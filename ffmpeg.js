// ffmpeg.js (CommonJS) — Twilio inbound/outbound transcoding helpers
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

// Twilio inbound: mulaw 8k -> s16le 16k mono
function createFFmpegInbound(log) {
  const ev = new EventEmitter();
  const ff = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning",
    "-f", "mulaw", "-ar", "8000", "-ac", "1", "-i", "pipe:0",
    "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"
  ]);

  ff.stderr.on("data", (d) => log.info?.(d.toString().trim()) || console.log(d.toString().trim()));
  ff.on("error", (e) => log.error?.(e) || console.error("ffmpeg inbound spawn error:", e));
  ff.on("close", (code) => (log.info?.({ code }, "🧹 ffmpeg inbound closed") || console.log("ffmpeg inbound closed", code)));

  let pcmBuf = Buffer.alloc(0);
  ff.stdout.on("data", (chunk) => {
    pcmBuf = Buffer.concat([pcmBuf, chunk]);

    // Emit ~320ms frames @16kHz * 2B = 10,240 bytes
    const FRAME = 10240;
    while (pcmBuf.length >= FRAME) {
      const frame = pcmBuf.subarray(0, FRAME);
      pcmBuf = pcmBuf.subarray(FRAME);
      if (hasEnergy(frame)) ev.emit("text-frame", frame);
    }
  });

  // Minimal ASR shim (replace with your real ASR)
  const asr = streamWhisper(ev, log);

  return {
    feed(buf) { try { ff.stdin.write(buf); } catch (e) { /* ignore broken pipe on hangup */ } },
    end() { try { ff.stdin.end(); } catch {} },
    onText(cb) { asr.on("asr-text", cb); }
  };
}

function hasEnergy(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 2) {
    const s = frame.readInt16LE(i);
    sum += s * s;
  }
  const rms = Math.sqrt(sum / (frame.length / 2));
  return rms > 400; // tweak to taste
}

// --- ASR shim (replace with Whisper/Realtime/Deepgram) ---
function streamWhisper(ev, log) {
  const out = new EventEmitter();
  let collector = [];

  ev.on("text-frame", async (pcm) => {
    collector.push(pcm);
    const bytes = collector.reduce((a, b) => a + b.length, 0);
    if (bytes >= 32000) { // ~1.0s @16kHz s16le
      const audio = Buffer.concat(collector);
      collector = [];
      try {
        const text = await fakeWhisper(audio); // TODO: replace
        if (text && text.trim()) out.emit("asr-text", { text, isFinal: true });
      } catch (e) {
        log?.error?.({ err: e }, "ASR error");
      }
    }
  });

  return out;
}

async function fakeWhisper(_audio) {
  // placeholder to keep file self-contained.
  return "";
}

// === Outbound: mp3 -> mulaw (8k mono), chunk callback to send to Twilio ===
function createFFmpegOutbound(log) {
  return {
    async playMp3(mp3Buffer, onMulaw) {
      return new Promise((resolve, reject) => {
        const ff = spawn("ffmpeg", [
          "-hide_banner", "-loglevel", "warning",
          "-f", "mp3", "-i", "pipe:0",
          "-f", "mulaw", "-ar", "8000", "-ac", "1", "pipe:1"
        ]);

        ff.stderr.on("data", (d) => log.info?.(d.toString().trim()) || console.log(d.toString().trim()));
        ff.on("error", reject);
        ff.on("close", () => resolve());

        ff.stdout.on("data", (chunk) => onMulaw(chunk));
        try { ff.stdin.end(mp3Buffer); } catch (e) { reject(e); }
      });
    },
    end() { /* no-op */ }
  };
}

module.exports = { createFFmpegInbound, createFFmpegOutbound };
