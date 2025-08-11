// tts.js — OpenAI TTS -> WAV (PCM16@8k) -> ffmpeg -> RAW μ-law (PCMU@8k) -> paced frames to Twilio
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static") || "ffmpeg";
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const DEFAULT_VOICE = process.env.TTS_VOICE || "aria";            // British female by default
const DEFAULT_MODEL = process.env.TTS_MODEL || "gpt-4o-mini-tts";

console.log(`🎙️ TTS voice=${DEFAULT_VOICE} model=${DEFAULT_MODEL}`);

const greetingCache = new Map();

class TtsController {
  constructor() { this.cancelled = false; }
  cancel() { this.cancelled = true; }
}

/** OpenAI TTS -> WAV (PCM16 @ 8kHz) */
async function synthesizeWav({ text, voice = DEFAULT_VOICE, model = DEFAULT_MODEL }) {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, voice, input: text, format: "wav", sample_rate: 8000 })
  });
  if (!r.ok) throw new Error(`TTS synth failed: ${r.status} ${await r.text().catch(()=> "")}`);
  return Buffer.from(await r.arrayBuffer());
}

/** ffmpeg: WAV (PCM16@8k) -> RAW μ-law (PCMU@8k) */
function wavToMulawRaw(wavBuf) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-vn",
      "-acodec", "pcm_mulaw",
      "-f", "mulaw",
      "-ar", "8000",
      "-ac", "1",
      "pipe:1"
    ];
    const p = spawn(ffmpegPath, args);
    const chunks = [];
    let errTxt = "";
    p.stdout.on("data", (b) => chunks.push(b));
    p.stderr.on("data", (b) => { errTxt += b.toString(); });
    p.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(chunks));
      reject(new Error(`ffmpeg (wav->mulaw) exited ${code}: ${errTxt.trim()}`));
    });
    p.on("error", (e) => reject(e));
    p.stdin.end(wavBuf);
  });
}

/** Pace RAW μ-law buffer to Twilio (160 bytes every 20ms) */
async function playMulawBuffer({ ws, streamSid, buffer, controller, logPrefix = "TTS" }) {
  if (!ws || !streamSid) return;
  const CHUNK = 160; // 20ms @ 8k μ-law
  let offset = 0;
  while (offset < buffer.length && !(controller && controller.cancelled)) {
    const slice = buffer.subarray(offset, offset + CHUNK);
    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: slice.toString("base64") } }));
    offset += CHUNK;
    await new Promise(r => setTimeout(r, 20));
  }
  if (!(controller && controller.cancelled)) {
    ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts-done" } }));
    console.log(`${logPrefix}: sent ~${buffer.length} bytes RAW μ-law (paced)`);
  }
}

async function startPlaybackFromTTS({ ws, streamSid, text, voice = DEFAULT_VOICE, model = DEFAULT_MODEL, controller }) {
  const wav = await synthesizeWav({ text, voice, model });
  const mulaw = await wavToMulawRaw(wav);
  await playMulawBuffer({ ws, streamSid, buffer: mulaw, controller, logPrefix: "TTS" });
}

async function playCachedGreeting({ ws, streamSid, text, voice = DEFAULT_VOICE, model = DEFAULT_MODEL, controller }) {
  const key = `${voice}::${model}::${text}`;
  let mulaw = greetingCache.get(key);
  if (!mulaw) {
    const wav = await synthesizeWav({ text, voice, model });
    mulaw = await wavToMulawRaw(wav);
    greetingCache.set(key, mulaw);
  }
  await playMulawBuffer({ ws, streamSid, buffer: mulaw, controller, logPrefix: "TTS (cached)" });
}

async function warmGreeting({ text, voice = DEFAULT_VOICE, model = DEFAULT_MODEL }) {
  const key = `${voice}::${model}::${text}`;
  if (!greetingCache.has(key)) {
    const wav = await synthesizeWav({ text, voice, model });
    const mulaw = await wavToMulawRaw(wav);
    greetingCache.set(key, mulaw);
  }
}

function clearGreetingCache() {
  greetingCache.clear();
  console.log("🧹 TTS greeting cache cleared");
}

// Minimal fallback “tone” (neutral buffer) if no API key set
async function startPlaybackTone({ ws, streamSid, controller, logPrefix = "TONE" }) {
  const silence = Buffer.alloc(8000 / 2);
  await playMulawBuffer({ ws, streamSid, buffer: silence, controller, logPrefix });
}

module.exports = {
  startPlaybackFromTTS,
  startPlaybackTone,
  warmGreeting,
  playCachedGreeting,
  clearGreetingCache,
  TtsController,
};
