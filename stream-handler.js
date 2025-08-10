import { createFFmpegInbound, createFFmpegOutbound } from '../media/ffmpeg.js';
import { planReply } from '../nl/dpa.js';
import { ttsToMp3 } from '../tts/tts.js';
import { v4 as uuidv4 } from 'uuid';

export function handleStreamConnection(ws, log) {
  let callSid = null;
  let streamSid = null;

  // Loop-guards
  let lastUserText = '';
  let lastBotText = '';
  let repeatBudget = 0;

  // Audio pipelines
  const inbound = createFFmpegInbound(log);   // Twilio mulaw -> s16le 16k mono (PCM)
  const outbound = createFFmpegOutbound(log); // mp3 -> mulaw 8k mono (Twilio)

  // Twilio <Stream> protocol messages
  ws.on('message', async (msgBuf) => {
    const msg = JSON.parse(msgBuf.toString());

    switch (msg.event) {
      case 'start':
        callSid = msg.start.callSid;
        streamSid = msg.start.streamSid;
        log.info({ callSid, streamSid }, '📞 Twilio media stream connected');
        break;

      case 'media': {
        // Base64 mulaw 8k mono from Twilio
        const mulaw = Buffer.from(msg.media.payload, 'base64');
        inbound.feed(mulaw); // ffmpeg converts to 16k s16le PCM for ASR
        break;
      }

      case 'mark':
        log.info({ id: msg.mark.name }, '✔️ Playback mark received');
        break;

      case 'stop':
        log.info('🛑 Twilio signaled stop — closing stream');
        inbound.end();
        outbound.end();
        try { ws.close(); } catch {}
        break;
    }
  });

  ws.on('close', () => {
    log.info('❌ WebSocket connection closed');
    inbound.end();
    outbound.end();
  });

  // Transcription events (chunked; low latency)
  inbound.onText(async (partialOrFinal) => {
    const { text, isFinal } = partialOrFinal;

    // Only act on “useful” finals to reduce latency yet avoid chatter
    if (!isFinal) return;
    const cleaned = text.trim();
    if (!cleaned) return;

    // loop-guard: drop identical repeats and short single-word stutters
    if (cleaned.toLowerCase() === lastUserText.toLowerCase()) {
      if (++repeatBudget > 2) return;
    } else {
      repeatBudget = 0;
    }
    lastUserText = cleaned;

    const dpa = await planReply({
      transcript: cleaned,
      lastBotText,
    });

    // If DPA decided to say nothing, stop here
    if (!dpa || !dpa.speak || !dpa.speak.trim()) return;

    // TTS -> mp3 (24k mono) -> ffmpeg -> mulaw -> Twilio "media" messages
    const mp3 = await ttsToMp3(dpa.speak);
    const uttId = `utt-${uuidv4().slice(0, 8)}`;

    // Feed outbound converter; for each mulaw buffer, send to Twilio
    await outbound.playMp3(mp3, (mulawChunk) => {
      ws.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: mulawChunk.toString('base64') }
      }));
    });

    // Send a Twilio mark so the logs show completion of this utterance
    ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: uttId } }));
    lastBotText = dpa.speak;
  });
}
