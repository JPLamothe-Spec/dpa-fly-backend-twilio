// tts.js — OpenAI TTS → (mp3 or wav) → ffmpeg → μ-law@8k → send to Twilio

const OpenAI = require("openai");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Synthesize speech (OpenAI default is MP3; that's fine)
async function synthesizeSpeech(text) {
  const resp = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: text
    // format omitted — use default (mp3)
  });
  return Buffer.from(await resp.arrayBuffer());
}

// Convert encoded audio (mp3/wav/etc.) → μ-law@8k
async function encodedToMulaw8k(inputBuf) {
  return await new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      "-i", "pipe:0",      // auto-detect input
      "-f", "mulaw",
      "-ar", "8000",
      "-ac", "1",
      "pipe:1"
    ], { stdio: ["pipe", "pipe", "inherit"] });

    const chunks = [];
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg (any→mulaw) exited with ${code}`));
    });

    ff.stdin.end(inputBuf);
  });
}

// Split μ-law buffer into 20ms frames (160 bytes @ 8kHz)
function* frameMulaw(mu) {
  const FRAME = 160;
  for (let i = 0; i < mu.length; i += FRAME) {
    yield mu.subarray(i, Math.min(i + FRAME, mu.length));
  }
}

// Small queued sender so replies don't overlap
class TtsSender {
  constructor(ws) {
    this.ws = ws;
    this.streamSid = null;
    this.queue = [];
    this.speaking = false;
    this.markCounter = 0;
  }
  setStreamSid(sid) { this.streamSid = sid; }

  async speak(text) {
    if (!text?.trim() || !this.streamSid || this.ws.readyState !== 1) return;
    this.queue.push(text);
    if (!this.speaking) this._drain().catch((e) => console.error("TTS drain error:", e));
  }

  async _drain() {
    this.speaking = true;
    while (this.queue.length && this.ws.readyState === 1) {
      const text = this.queue.shift();
      try {
        const speechBuf = await synthesizeSpeech(text);
        const mu = await encodedToMulaw8k(speechBuf);

        for (const fr of frameMulaw(mu)) {
          this.ws.send(JSON.stringify({
            event: "media",
            streamSid: this.streamSid,
            media: { payload: fr.toString("base64") }
          }));
        }
        const name = `utt-${++this.markCounter}`;
        this.ws.send(JSON.stringify({ event: "mark", streamSid: this.streamSid, mark: { name } }));
      } catch (e) {
        console.error("TTS send error:", e?.message || e);
      }
    }
    this.speaking = false;
  }
}

module.exports = { TtsSender };
