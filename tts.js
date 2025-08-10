// tts.js — paced outbound μ-law using ffmpeg-static (+gain, silence tail) + GREETING CACHE
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static") || "ffmpeg";
require("dotenv").config();

// ESM-friendly fetch shim (avoids CommonJS crash with node-fetch v3)
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const FRAME_BYTES = 160;   // 20ms @ 8k μ-law
const FRAME_MS = 20;

// In-memory greeting cache (μ-law buffer)
let cachedGreeting = null;
let cachedGreetingKey = null; // text|voice|model signature

// Send a single frame
function sendMediaFrame(ws, streamSid, chunk) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({
    event: "media",
    streamSid,
    media: { payload: chunk.toString("base64") }
  }));
}

// Send a mark (Twilio will echo it back)
function sendMark(ws, streamSid, name) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({
    event: "mark",
    streamSid,
    mark: { name }
  }));
}

// Build 20ms frames and pace them; append a short μ-law silence tail to ensure clean end
function paceAndSendMuLaw(ws, streamSid, mulawBuffer, { addSilenceTail = true, tailMs = 600 } = {}) {
  return new Promise((resolve) => {
    const frames = [];
    for (let i = 0; i < mulawBuffer.length; i += FRAME_BYTES) {
      const frame = mulawBuffer.subarray(i, Math.min(i + FRAME_BYTES, mulawBuffer.length));
      if (frame.length < FRAME_BYTES) {
        const padded = Buffer.alloc(FRAME_BYTES, 0x7f); // μ-law silence
        frame.copy(padded);
        frames.push(padded);
      } else {
        frames.push(frame);
      }
    }
    if (addSilenceTail) {
      const tailFrames = Math.ceil(tailMs / FRAME_MS);
      for (let i = 0; i < tailFrames; i++) frames.push(Buffer.alloc(FRAME_BYTES, 0x7f));
    }

    let idx = 0;
    const timer = setInterval(() => {
      if (!ws || ws.readyState !== ws.OPEN) { clearInterval(timer); return resolve(); }
      if (idx >= frames.length) { clearInterval(timer); return resolve(); }
      sendMediaFrame(ws, streamSid, frames[idx++]);
    }, FRAME_MS);
  });
}

// Tone playback with gain
async function startPlaybackTone({ ws, streamSid, seconds = 2, freq = 880, logPrefix = "TONE" }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-f","lavfi","-i",`sine=frequency=${freq}:duration=${seconds}`,
      "-filter:a","volume=2.0",      // +6 dB gain
      "-ar","8000","-ac","1","-f","mulaw","pipe:1"
    ];
    const p = spawn(ffmpegPath, args);
    const chunks = [];
    p.stdout.on("data", (buf) => chunks.push(buf));
    p.on("close", async (code) => {
      if (code !== 0) return reject(new Error(`${logPrefix} ffmpeg exited with code ${code}`));
      const out = Buffer.concat(chunks);
      await paceAndSendMuLaw(ws, streamSid, out, { tailMs: 600 });
      sendMark(ws, streamSid, `${logPrefix}-done`);
      console.log(`${logPrefix}: sent ~${out.length} bytes μ-law (paced, +gain)`);
      resolve();
    });
    p.on("error", reject);
  });
}

// OpenAI TTS -> μ-law@8k -> paced (with gain)
async function startPlaybackFromTTS({ ws, streamSid, text, voice = "alloy", model = "gpt-4o-mini-tts" }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for TTS mode");

  // 1) Fetch TTS audio (MP3) from OpenAI
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, voice, input: text, format: "mp3" }),
  });
  if (!resp.ok) throw new Error(`OpenAI TTS failed: ${resp.status} ${await resp.text().catch(() => "")}`);
  const mp3Buffer = Buffer.from(await resp.arrayBuffer());

  // 2) Transcode MP3 -> μ-law@8k, boost gain, then pace to Twilio
  const mulawBuffer = await transcodeMp3ToMulaw(mp3Buffer);
  await paceAndSendMuLaw(ws, streamSid, mulawBuffer, { tailMs: 600 });
  sendMark(ws, streamSid, "tts-done");
  console.log(`TTS: sent ~${mulawBuffer.length} bytes μ-law (paced, +gain)`);
}

// ---------- Greeting cache utilities ----------
async function transcodeMp3ToMulaw(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const args = [
      "-i","pipe:0",
      "-filter:a","volume=2.0",      // +6 dB gain before μ-law
      "-ar","8000","-ac","1","-f","mulaw","pipe:1"
    ];
    const p = spawn(ffmpegPath, args);
    const chunks = [];
    p.stdout.on("data", (buf) => chunks.push(buf));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code}`));
      resolve(Buffer.concat(chunks));
    });
    p.on("error", reject);
    p.stdin.write(mp3Buffer);
    p.stdin.end();
  });
}

async function fetchTTSMp3({ text, voice, model }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for TTS");
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, voice, input: text, format: "mp3" }),
  });
  if (!resp.ok) throw new Error(`OpenAI TTS failed: ${resp.status} ${await resp.text().catch(() => "")}`);
  return Buffer.from(await resp.arrayBuffer());
}

// Warm the greeting cache at boot or on demand
async function warmGreeting({ text, voice = "alloy", model = "gpt-4o-mini-tts" }) {
  try {
    const key = `${text}|${voice}|${model}`;
    if (cachedGreeting && cachedGreetingKey === key) {
      console.log("🔥 Greeting cache already warm");
      return;
    }
    console.log("🔥 Warming greeting cache…");
    const mp3 = await fetchTTSMp3({ text, voice, model });
    cachedGreeting = await transcodeMp3ToMulaw(mp3);
    cachedGreetingKey = key;
    console.log(`✅ Greeting cached (~${cachedGreeting.length} bytes μ-law)`);
  } catch (e) {
    console.error("❌ Failed to warm greeting cache:", e?.message || e);
    cachedGreeting = null;
    cachedGreetingKey = null;
  }
}

// Play cached greeting immediately; if not ready, fall back to live TTS
async function playCachedGreeting({ ws, streamSid, text, voice = "alloy", model = "gpt-4o-mini-tts" }) {
  const key = `${text}|${voice}|${model}`;
  if (cachedGreeting && cachedGreetingKey === key) {
    await paceAndSendMuLaw(ws, streamSid, cachedGreeting, { tailMs: 600 });
    sendMark(ws, streamSid, "tts-done");
    console.log(`TTS (cached): sent ~${cachedGreeting.length} bytes μ-law (paced, +gain)`);
    return;
  }
  // Fallback (should be rare if warmed at boot)
  await startPlaybackFromTTS({ ws, streamSid, text, voice, model });
}

module.exports = {
  startPlaybackTone,
  startPlaybackFromTTS,
  warmGreeting,
  playCachedGreeting,
};
