// tts.js — OpenAI TTS playback helpers with caching + μ-law pacing
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const DEFAULT_VOICE = process.env.TTS_VOICE || "verse";          // British female by default
const DEFAULT_MODEL = process.env.TTS_MODEL || "gpt-4o-mini-tts";

class TtsController {
  constructor() { this.cancelled = false; }
  cancel() { this.cancelled = true; }
}

// Simple in-memory cache for greeting audio (per voice+model+text)
const greetingCache = new Map();

async function synthesize({ text, voice = DEFAULT_VOICE, model = DEFAULT_MODEL }) {
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      voice,                 // <- honour requested voice
      input: text,
      format: "mulaw",       // Twilio-friendly
      sample_rate: 8000
    })
  });
  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`TTS synth failed: ${resp.status} ${errTxt}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

async function playMulawBuffer({ ws, streamSid, buffer, controller, logPrefix = "TTS" }) {
  if (!ws || !streamSid) return;
  const CHUNK = 160; // 20ms at 8k μ-law
  let offset = 0;
  while (offset < buffer.length && !(controller && controller.cancelled)) {
    const slice = buffer.subarray(offset, offset + CHUNK);
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: slice.toString("base64") }
    }));
    offset += CHUNK;
    await new Promise(r => setTimeout(r, 20));
  }
  if (!(controller && controller.cancelled)) {
    ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts-done" } }));
    console.log(`${logPrefix}: sent ~${buffer.length} bytes μ-law (paced, +gain)`);
  }
}

async function startPlaybackFromTTS({ ws, streamSid, text, voice = DEFAULT_VOICE, model = DEFAULT_MODEL, controller }) {
  const audio = await synthesize({ text, voice, model });
  await playMulawBuffer({ ws, streamSid, buffer: audio, controller, logPrefix: "TTS" });
}

async function playCachedGreeting({ ws, streamSid, text, voice = DEFAULT_VOICE, model = DEFAULT_MODEL, controller }) {
  const key = `${voice}::${model}::${text}`;
  let audio = greetingCache.get(key);
  if (!audio) {
    audio = await synthesize({ text, voice, model });
    greetingCache.set(key, audio);
  }
  await playMulawBuffer({ ws, streamSid, buffer: audio, controller, logPrefix: "TTS (cached)" });
}

async function warmGreeting({ text, voice = DEFAULT_VOICE, model = DEFAULT_MODEL }) {
  const key = `${voice}::${model}::${text}`;
  if (!greetingCache.has(key)) {
    const audio = await synthesize({ text, voice, model });
    greetingCache.set(key, audio);
  }
}

async function startPlaybackTone({ ws, streamSid, controller, logPrefix = "TONE" }) {
  // simple 1kHz tone for 500ms as a fallback (mulaw)
  const tone = Buffer.alloc(8000 / 2); // 0.5s placeholder of "silence" mulaw
  await playMulawBuffer({ ws, streamSid, buffer: tone, controller, logPrefix });
}

module.exports = {
  startPlaybackFromTTS,
  startPlaybackTone,
  warmGreeting,
  playCachedGreeting,
  TtsController,
};
