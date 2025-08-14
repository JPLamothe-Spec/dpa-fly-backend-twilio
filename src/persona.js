// src/persona.js
// Everything configurable lives in env.

export function loadPersona() {
  return {
    name: process.env.DPA_NAME || 'Anna',
    voice: process.env.DPA_VOICE || 'shimmer',
    asrModel: process.env.DPA_ASR_MODEL || 'gpt-4o-mini-transcribe',
    ttsModel: process.env.DPA_TTS_MODEL || 'gpt-4o-realtime-preview-2024-12-17',
    devMode: (process.env.DEV_MODE || '').toLowerCase() === 'true',
    systemPrompt: (process.env.DPA_SYSTEM_PROMPT || '').trim(),
  };
}
