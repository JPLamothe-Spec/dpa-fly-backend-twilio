import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// Twilio inbound: mulaw 8k -> s16le 16k mono
export function createFFmpegInbound(log) {
  const ev = new EventEmitter();
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'warning',
    '-f', 'mulaw', '-ar', '8000', '-ac', '1', '-i', 'pipe:0',
    '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1'
  ]);

  ff.stderr.on('data', d => log.info(d.toString().trim()));
  ff.on('close', (code) => log.info({ code }, '🧹 ffmpeg inbound closed'));

  let pcmBuf = Buffer.alloc(0);
  ff.stdout.on('data', chunk => {
    pcmBuf = Buffer.concat([pcmBuf, chunk]);

    // Emit short readable frames to ASR (~320ms @16kHz*2B=~10KB)
    const FRAME = 10240;
    while (pcmBuf.length >= FRAME) {
      const frame = pcmBuf.subarray(0, FRAME);
      pcmBuf = pcmBuf.subarray(FRAME);
      // Very small placeholder VAD: emit only if frame has energy
      if (hasEnergy(frame)) ev.emit('text-frame', frame);
    }
  });

  // Simple streaming Whisper localizer — we just turn frames into text via
  // a minimal “ASR shim” below (replace with your actual Whisper hook).
  const asr = streamWhisper(ev, log);

  return {
    feed(buf) { ff.stdin.write(buf); },
    end() { try { ff.stdin.end(); } catch {} },
    onText(cb) { asr.on('asr-text', cb); }
  };
}

function hasEnergy(frame) {
  // quick RMS check to drop pure silence
  let sum = 0;
  for (let i = 0; i < frame.length; i += 2) {
    const s = frame.readInt16LE(i);
    sum += s * s;
  }
  const rms = Math.sqrt(sum / (frame.length / 2));
  return rms > 400; // tweakable
}

// === ASR shim (replace with your actual Whisper/OpenAI Realtime/Deepgram) ===
import { EventEmitter as EE } from 'node:events';
function streamWhisper(ev, log) {
  const out = new EE();
  let collector = [];

  ev.on('text-frame', async (pcm) => {
    collector.push(pcm);
    // very small latency budget: finalize ~ every 1.0s of speech
    const bytes = collector.reduce((a, b) => a + b.length, 0);
    if (bytes >= 32000) {
      const audio = Buffer.concat(collector);
      collector = [];
      try {
        const text = await fakeWhisper(audio); // <— REPLACE
        if (text && text.trim()) out.emit('asr-text', { text, isFinal: true });
      } catch (e) {
        log.error({ err: e }, 'ASR error');
      }
    }
  });

  return out;
}

async function fakeWhisper(_) {
  // placeholder to keep this file self-contained.
  // In your repo, call your real Whisper/ASR function here.
  // e.g. POST to your ASR microservice and return the transcript text.
  return ''; // return empty so we speak only when your real ASR is wired.
}

// === Outbound: mp3 -> mulaw (8k mono), chunk callback to send to Twilio ===
export function createFFmpegOutbound(log) {
  return {
    async playMp3(mp3Buffer, onMulaw) {
      return new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
          '-hide_banner', '-loglevel', 'warning',
          '-f', 'mp3', '-i', 'pipe:0',
          '-f', 'mulaw', '-ar', '8000', '-ac', '1', 'pipe:1'
        ]);
        ff.stderr.on('data', d => log.info(d.toString().trim()));
        ff.on('error', reject);
        ff.on('close', () => resolve());

        ff.stdout.on('data', (chunk) => onMulaw(chunk));
        ff.stdin.end(mp3Buffer);
      });
    },
    end() {/*no-op*/}
  };
}
