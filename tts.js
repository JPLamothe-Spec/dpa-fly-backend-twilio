// tts.js — paced outbound with track:"outbound"
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static") || "ffmpeg";
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const FRAME_BYTES = 160;      // 20ms @ 8k μ-law
const FRAME_MS = 20;

function sendMediaFrame(ws, streamSid, chunk) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({
    event: "media",
    streamSid,
    track: "outbound",                          // <-- add track
    media: { payload: chunk.toString("base64") }
  }));
}

function sendMark(ws, streamSid, name) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({
    event: "mark",
    streamSid,
    track: "outbound",                          // <-- add track
    mark: { name }
  }));
}

// Pace frames at ~20ms so Twilio plays them reliably
function paceAndSendMuLaw(ws, streamSid, mulawBuffer) {
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

    let idx = 0;
    const timer = setInterval(() => {
      if (!ws || ws.readyState !== ws.OPEN) {
        clearInterval(timer);
        return resolve();
      }
      if (idx >= frames.length) {
        clearInterval(timer);
        return resolve();
      }
      sendMediaFrame(ws, streamSid, frames[idx++]);
    }, FRAME_MS);
  });
}

// Tone playback (collect -> pace -> send)
async function startPlaybackTone({ ws, streamSid, seconds = 2, freq = 880, logPrefix = "TONE" }) {
  return new Promise((resolve, reject) => {
    const args = ["-f","lavfi","-i",`sine=frequency=${freq}:duration=${seconds}`,
                  "-ar","8000","-ac","1","-f","mulaw","pipe:1"];
    const p = spawn(ffmpegPath, args);
    const chunks = [];
    p.stdout.on("data", (buf) => chunks.push(buf));
    p.on("close", async (code) => {
      if (code !== 0) return reject(new Error(`${logPrefix} ffmpeg exited with code ${code}`));
      const out = Buffer.concat(chunks);
      await paceAndSendMuLaw(ws, streamSid, out);
      sendMark(ws, streamSid, `${logPrefix}-done`);
      console.log(`${logPrefix}: sent ~${out.length} bytes μ-law (paced)`);
      resolve();
    });
    p.on("error", reject);
  });
}

// OpenAI TTS playback (collect -> pace -> send)
async function startPlaybackFromTTS({ ws, streamSid, text, voice = "alloy", model = "gpt-4o-mini-tts" }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for TTS mode");

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

  return new Promise((resolve, reject) => {
    const args = ["-i","pipe:0","-ar","8000","-ac","1","-f","mulaw","pipe:1"];
    const p = spawn(ffmpegPath, args);
    const chunks = [];
    p.stdout.on("data", (buf) => chunks.push(buf));
    p.on("close", async (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code}`));
      const out = Buffer.concat(chunks);
      await paceAndSendMuLaw(ws, streamSid, out);
      sendMark(ws, streamSid, "tts-done");
      console.log(`TTS: sent ~${out.length} bytes μ-law (paced)`);
      resolve();
    });
    p.on("error", reject);

    p.stdin.write(mp3Buffer);
    p.stdin.end();
  });
}

module.exports = { startPlaybackTone, startPlaybackFromTTS };
