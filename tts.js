// tts.js — playback helpers using ffmpeg-static (no system ffmpeg required)
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static") || "ffmpeg";
const fetch = require("node-fetch");

// Twilio expects 20ms μ-law@8k frames, base64 payload, over the same WS.
// Each frame = 160 bytes at 8k μ-law (20ms).
const FRAME_BYTES = 160;

// Send a "media" JSON message with base64 audio payload
function sendMediaFrame(ws, chunk) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  const payload = chunk.toString("base64");
  ws.send(
    JSON.stringify({
      event: "media",
      media: { payload }
    })
  );
}

// Chunk a Buffer into 160-byte frames and send each as a media event
function streamMuLawBuffer(ws, mulawBuffer) {
  for (let i = 0; i < mulawBuffer.length; i += FRAME_BYTES) {
    const frame = mulawBuffer.subarray(i, Math.min(i + FRAME_BYTES, mulawBuffer.length));
    if (frame.length < FRAME_BYTES) {
      // pad last frame with silence if needed
      const padded = Buffer.alloc(FRAME_BYTES, 0x7f); // μ-law silence
      frame.copy(padded);
      sendMediaFrame(ws, padded);
    } else {
      sendMediaFrame(ws, frame);
    }
  }
}

// Mode A: Generate a quick confirmation tone (sine wave) -> μ-law@8k and stream it
async function startPlaybackTone({ ws, seconds = 2, freq = 880, logPrefix = "TONE" }) {
  return new Promise((resolve, reject) => {
    // Generate tone with ffmpeg and output μ-law@8k
    //  -re (not used) since we're offline-chunking; we just push frames quickly.
    const args = [
      "-f", "lavfi",
      "-i", `sine=frequency=${freq}:duration=${seconds}`,
      "-ar", "8000",
      "-ac", "1",
      "-f", "mulaw",
      "pipe:1"
    ];

    const p = spawn(ffmpegPath, args);
    let total = 0;

    p.stdout.on("data", (buf) => {
      total += buf.length;
      streamMuLawBuffer(ws, buf);
    });

    p.stderr.on("data", () => {}); // keep quiet unless debugging

    p.on("close", (code) => {
      if (code === 0) {
        console.log(`${logPrefix}: sent ~${total} bytes μ-law`);
        resolve();
      } else {
        reject(new Error(`${logPrefix} ffmpeg exited with code ${code}`));
      }
    });

    p.on("error", (err) => reject(err));
  });
}

// Mode B: Use OpenAI TTS -> transcode to μ-law@8k with ffmpeg-static -> stream to Twilio
async function startPlaybackFromTTS({ ws, text, voice = "alloy", model = "gpt-4o-mini-tts" }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for TTS mode");
  }

  // 1) Fetch TTS audio (MP3) from OpenAI
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      format: "mp3"
    })
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OpenAI TTS failed: ${resp.status} ${errText}`);
  }

  const mp3Buffer = Buffer.from(await resp.arrayBuffer());

  // 2) Pipe MP3 into ffmpeg-static to convert → μ-law@8k
  return new Promise((resolve, reject) => {
    const args = [
      "-i", "pipe:0",     // read MP3 from stdin
      "-ar", "8000",
      "-ac", "1",
      "-f", "mulaw",
      "pipe:1"            // write μ-law to stdout
    ];

    const p = spawn(ffmpegPath, args);

    p.stdin.write(mp3Buffer);
    p.stdin.end();

    let total = 0;

    p.stdout.on("data", (buf) => {
      total += buf.length;
      streamMuLawBuffer(ws, buf);
    });

    p.stderr.on("data", () => {}); // quiet unless needed

    p.on("close", (code) => {
      if (code === 0) {
        console.log(`TTS: sent ~${total} bytes μ-law`);
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    p.on("error", (err) => reject(err));
  });
}

module.exports = {
  startPlaybackTone,
  startPlaybackFromTTS
};
