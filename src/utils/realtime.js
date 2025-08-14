// src/utils/realtime.js
// Helpers for Realtime URL, append frames, and a Twilio 100ms commit coalescer.

export function createRealtimeUrl({ model, voice, dev }) {
  const base = process.env.OPENAI_REALTIME_URL || 'wss://api.openai.com/v1/realtime';
  const params = new URLSearchParams({
    model: model || 'gpt-4o-realtime-preview-2024-12-17',
    voice: voice || 'shimmer',
    ...(dev ? { dev: 'true' } : {})
  });
  return `${base}?${params.toString()}`;
}

/**
 * Realtime expects `input_audio_buffer.append` frames either as JSON with `audio` field
 * (base64) or as binary frames with a frame header. JSON is simplest here.
 */
export function encodeAppendFrame(base64Mulaw) {
  return JSON.stringify({
    type: 'input_audio_buffer.append',
    audio: base64Mulaw,
    // Since we set input_audio_format to g711_ulaw in session.update,
    // the server will decode correctly from μ-law 8k.
  });
}

/**
 * Coalesces Twilio's 20ms frames until we have >= minCommitMs,
 * then invokes onCommit with a single base64 string.
 */
export class TwilioCoalescer {
  constructor({ minCommitMs = 120, onCommit }) {
    this.minCommitMs = minCommitMs;
    this.onCommit = onCommit;
    this.frames = [];
    this.ms = 0;
  }
  push(base64MulawFrame, frameMs = 20) {
    this.frames.push(base64MulawFrame);
    this.ms += frameMs;
    if (this.ms >= this.minCommitMs) {
      const packed = this.frames.join(''); // base64-safe concat (same alphabet)
      const approxMs = this.ms;
      this.frames = [];
      this.ms = 0;
      this.onCommit?.({ data: packed, approxMs });
      // onCommit expects raw base64 string:
      this.onCommit?.(Object.assign(packed, { approxMs })); // convenience for old callers
    }
  }
  flush() {
    if (!this.frames.length) return;
    const packed = this.frames.join('');
    const approxMs = this.ms;
    this.frames = [];
    this.ms = 0;
    this.onCommit?.(Object.assign(packed, { approxMs }));
  }
}
