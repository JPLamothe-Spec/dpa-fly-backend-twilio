// src/utils/realtime.js
// Helpers for OpenAI Realtime URL building, audio frame encoding, and Twilio frame coalescing.

export function createRealtimeUrl({ model, voice, dev }) {
  const base = (process.env.OPENAI_REALTIME_URL || 'wss://api.openai.com/v1/realtime').replace(/\/+$/, '');
  const params = new URLSearchParams({
    model: model || process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17',
    voice: voice || process.env.OPENAI_REALTIME_VOICE || 'shimmer',
    ...(dev ? { dev: 'true' } : {})
  });
  return `${base}?${params.toString()}`;
}

/**
 * Encodes a μ-law@8k audio frame for Realtime API JSON append.
 * The API will decode based on `input_audio_format` from session.update.
 */
export function encodeAppendFrame(base64Mulaw) {
  return JSON.stringify({
    type: 'input_audio_buffer.append',
    audio: base64Mulaw
  });
}

/**
 * Groups Twilio 20ms μ-law frames into larger commits (minCommitMs),
 * reducing request overhead to the Realtime API.
 */
export class TwilioCoalescer {
  constructor({ minCommitMs = process.env.COMMIT_MIN_MS || 120, frameMs = 20, onCommit }) {
    this.minCommitMs = Number(minCommitMs);
    this.frameMs = Number(frameMs);
    this.onCommit = onCommit;
    this.frames = [];
    this.ms = 0;
  }

  push(base64Frame) {
    this.frames.push(base64Frame);
    this.ms += this.frameMs;

    if (this.ms >= this.minCommitMs) {
      this.commit();
    }
  }

  commit() {
    if (!this.frames.length) return;
    const packed = this.frames.join('');
    const approxMs = this.ms;
    this.frames = [];
    this.ms = 0;
    this.onCommit?.({ audio: packed, approxMs });
  }

  flush() {
    this.commit();
  }
}
