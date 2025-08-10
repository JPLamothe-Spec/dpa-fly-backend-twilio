// tts.js — hardened OpenAI TTS (CommonJS)
const fetch = require("node-fetch");

const DEFAULT_MODEL = process.env.TTS_MODEL || "gpt-4o-mini-tts";
const DEFAULT_VOICE = process.env.TTS_VOICE || "alloy";
const DEFAULT_FORMAT = "mp3";
const DEFAULT_SR = 24000;
const TIMEOUT_MS = 12000;        // 12s network timeout
const MAX_RETRIES = 2;           // total 3 attempts
const RETRY_BASE_MS = 400;       // 400ms, 800ms backoff

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ttsToMp3(text, opts = {}) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  if (!text || !String(text).trim()) throw new Error("TTS input text is empty");

  const model = opts.model || DEFAULT_MODEL;
  const voice = opts.voice || DEFAULT_VOICE;
  const format = opts.format || DEFAULT_FORMAT;
  const sample_rate = typeof opts.sample_rate === "number" ? opts.sample_rate : DEFAULT_SR;

  const body = {
    model,
    voice,
    input: String(text).trim(),
    format,           // OpenAI accepts "mp3" | "wav" | "flac" etc.
    sample_rate       // 24000 is a good balance; Twilio needs 8k later
  };

  let attempt = 0, lastErr;
  while (attempt <= MAX_RETRIES) {
    attempt++;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    try {
      const r = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg"
        },
        body: JSON.stringify(body)
      });

      clearTimeout(to);

      if (r.ok) {
        const arrayBuf = await r.arrayBuffer();
        return Buffer.from(arrayBuf);
      }

      // Soft-retry on 429/5xx
      const retriable = r.status === 429 || (r.status >= 500 && r.status <= 599);
      const errText = await r.text().catch(() => "");
      lastErr = new Error(`TTS HTTP ${r.status}: ${errText || r.statusText}`);

      if (retriable && attempt <= MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
        continue;
      }
      throw lastErr;
    } catch (e) {
      clearTimeout(to);
      lastErr = e.name === "AbortError" ? new Error("TTS request timed out") : e;
      if (attempt <= MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new Error("TTS failed");
}

module.exports = { ttsToMp3 };
