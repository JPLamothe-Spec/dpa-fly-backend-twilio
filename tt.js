// tts.js — OpenAI TTS → WAV/16k → ffmpeg → μ-law@8k → send to Twilio over WS

const OpenAI = require("openai");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// synthesize text to WAV/16k mono with OpenAI TTS
async function synthesizeWav16k(text) {
  const resp = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",          // change voice if you like
    input: text,
    format: "wav"
  });
  return Buffer.from(await resp.arrayBuffer());
}

// convert WAV/16k → raw μ-law@8k (no headers)
async function wav16kToMulaw8k(wavBuf) {
  return await new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      "-f", "wav", "-i", "pipe:0",
      "-f", "mulaw", "-ar", "8000", "-ac", "1", "pipe:1"
    ], { stdio: ["pipe", "pipe", "inherit"] });

    const chunks = [];
    ff.stdout.on("data", d => chunks.push(d));
    ff.on("error", reject);
    ff.on("close", code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg (wav→mulaw) exited with ${code}`));
    });

    ff.stdin.end(wavBuf);
  });
}

// split μ-law buffer into 20ms frames (160 bytes @ 8kHz)
function* frameMulaw(mu) {
  const FRAME = 160;
  for (let i = 0; i < mu.length; i += FRAME) {
    yield mu.subarray(i, Math.min(i + FRAME, mu.length));
  }
}

// A tiny queued sender so replies don't overlap
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
    if (!this.speaking) this._drain().catch(err => console.error("TTS drain error:", err));
  }

  async _drain() {
    this.speaking = true;
    while (this.queue.length && this.ws.readyState === 1) {
      const text = this.queue.shift();
      try {
        const wav = await synthesizeWav16k(text);
        const mu = await wav16kToMulaw8k(wav);

        // send as base64 μ-law frames
        for (const fr of frameMulaw(mu)) {
          this.ws.send(JSON.stringify({
            event: "media",
            streamSid: this.streamSid,
            media: { payload: fr.toString("base64") }
          }));
        }

        // send a mark so we know when Twilio finishes playing it
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
