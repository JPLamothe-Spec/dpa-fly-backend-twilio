// tts.js — playback helpers using ffmpeg-static and Twilio's streamSid
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static") || "ffmpeg";
require("dotenv").config();

// ESM-friendly fetch shim (avoids CommonJS crash with node-fetch v3)
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const FRAME_BYTES = 160; // 20ms @ 8k μ-law

function sendMediaFrame(ws, streamSid, chunk) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({
    event: "media",
    streamSid, // REQUIRED by Twilio for outbound media
    media: { payload: chunk.toString("base64") },
  }));
}

function sendMark(ws, streamSid, name) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({
    event: "mark",
    streamSid,
    mark: { name },
  }));
}

function streamMuLawBuffer(ws, streamSid, mulawBuffer) {
  for (let i = 0; i < mulawBuffer.length; i += FRAME_BYTES) {
    const frame = mulawBuffer.subarray(i, Math.min(i + FRAME_BYTES, mulawBuffer.length));
    if (frame.length < FRAME_BYTES) {
      const padded = Buffer.alloc(FRAME_BYTES, 0x7f); // μ-law silence
      frame.copy(padded);
      sendMediaFrame(ws, streamSid, padded);
    } else {
      sendMediaFrame(ws, streamSid, frame);
    }
  }
}

// Mode A: simple tone to prove outbound audio path
async function startPlaybackTone({ ws, streamSid, seconds = 2, freq = 880, logPrefix = "TONE" }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-f", "lavfi",
      "-i", `sine=frequency=${freq}:duration=${seconds}`,
      "-ar", "8000",
      "-ac", "1",
      "-f", "mulaw",
      "pipe:1",
    ];
    const p = spawn(ffmpegPath, args);
    let total = 0;

    p.stdout.on("data", (buf) => { total += buf.length; streamMuLawBuffer(ws, streamSid, buf); });
    p.stderr.on("data", () => {});

    p.on("close", (code) => {
      if (code === 0) {
        sendMark(ws, streamSid, `${logPrefix}-done`);
        console.log(`${logPrefix}: sent ~${total} bytes μ-law`);
        resolve();
      } else reject(new Error(`${logPrefix} ffmpeg exited with code ${code}`));
    });
    p.on("error", reject);
  });
}

// Mode B: OpenAI TTS -> μ-law@8k -> stream to Twilio
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

  // 2) Transcode MP3 -> μ-law@8k and stream frames
  return new Promise((resolve, reject) => {
    const args = ["-i","pipe:0","-ar","8000","-ac","1","-f","mulaw","pipe:1"];
    const p = spawn(ffmpegPath, args);
    p.stdin.write(mp3Buffer);
    p.stdin.end();

    let total = 0;
    p.stdout.on("data", (buf) => { total += buf.length; streamMuLawBuffer(ws, streamSid, buf); });
    p.stderr.on("data", () => {});

    p.on("close", (code) => {
      if (code === 0) {
        sendMark(ws, streamSid, "tts-done");
        console.log(`TTS: sent ~${total} bytes μ-law`);
        resolve();
      } else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    p.on("error", reject);
  });
}

module.exports = { startPlaybackTone, startPlaybackFromTTS };
