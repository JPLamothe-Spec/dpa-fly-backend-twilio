// index.js
// Minimal Twilio <Stream> ↔ OpenAI Realtime bridge with fast VAD commits + caller transcription logging

import http from "http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";

// ------- Config (env-overridable) -------
const PORT = Number(process.env.PORT || 8080);

// OpenAI Realtime
const OAI_API_KEY = process.env.OPENAI_API_KEY;
const OAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const OAI_VOICE = process.env.OPENAI_VOICE || "coral";
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"; // <-- required

// Twilio Audio: μ-law 8k; we keep everything in μ-law to avoid heavy transcoding
const TWILIO_SAMPLE_RATE = 8000;

// VAD knobs (tunable live via env)
const SPEECH_THRESH = Number(process.env.VAD_SPEECH_THRESH || 12); // lower = more sensitive
const SILENCE_MS    = Number(process.env.VAD_SILENCE_MS || 700);  // pause to trigger commit
const MAX_TURN_MS   = Number(process.env.VAD_MAX_TURN_MS || 3500); // hard turn cutoff
const MIN_COMMIT_BYTES = 800; // ≈100ms of μ-law @ 8k; API minimum for commit

if (!OAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}

// ------- Express app (TwiML + upgrade endpoint) -------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio Voice webhook → return TwiML that opens a Stream to our WS
app.post("/twilio/voice", (req, res) => {
  const wsUrl = (process.env.PUBLIC_WS_URL || "").trim() ||
    `wss://${req.headers.host}/call`;
  const twiml = [
    "<Response>",
    "  <Connect>",
    `    <Stream url="${wsUrl}" track="inbound_track"/>`,
    "  </Connect>",
    '  <Pause length="30"/>',
    "</Response>"
  ].join("\n");

  console.log("➡️ /twilio/voice hit (POST)");
  console.log("🧾 TwiML returned:", twiml);
  res.set("Content-Type", "text/xml").send(twiml);
});

const server = http.createServer(app);

// We’ll accept WS upgrades at /call from Twilio, then inside connect to OpenAI Realtime.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/call") {
    socket.destroy();
    return;
  }
  console.log("🛰 HTTP upgrade requested:", req.method, req.url);
  console.log("headers:", req.headers);
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// ------- Utilities: μ-law helpers -------
/** clamp to 16-bit */
const clamp16 = (n) => Math.max(-32768, Math.min(32767, n|0));
/** very fast energy estimate for μ-law bytes (no decode): just use |byte-128| as proxy */
function ulawEnergy(buf) {
  let acc = 0;
  for (let i = 0; i < buf.length; i++) acc += Math.abs(buf[i] - 128);
  return acc / buf.length; // 0..127 average
}

// ------- Per-call bridge -------
wss.on("connection", (twilioWS, req) => {
  const ip = req.socket.remoteAddress;
  const ips = (req.headers["fly-client-ip"] || req.headers["x-forwarded-for"] || "").toString();
  console.log(`✅ Twilio WebSocket connected from ${ips || ip}`);

  let oaiWS;
  let socketOpen = true;

  // Buffering & VAD state
  let mulawChunks = [];
  let bytesBuffered = 0;
  let lastSpeechAt = Date.now();
  let turnStartedAt = Date.now();

  // OpenAI response/activity flags
  let sessionHealthy = false;
  let sessionError = false;
  let activeResponse = false;

  const resetBuffer = () => {
    mulawChunks = [];
    bytesBuffered = 0;
  };

  function commitIfReady(cause) {
    if (!socketOpen || !sessionHealthy || sessionError) return;

    const haveAudio = bytesBuffered >= MIN_COMMIT_BYTES && mulawChunks.length > 0;
    if (!haveAudio) return;

    const payloadBuf = Buffer.concat(mulawChunks);
    const ms = Math.round((payloadBuf.length / 800) * 100); // μ-law @8k → 800 bytes ≈ 100ms
    const b64 = payloadBuf.toString("base64");

    try {
      oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      oaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

      if (!activeResponse) {
        oaiWS.send(JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio","text"] }
        }));
        activeResponse = true; // optimistic until response.created arrives
        console.log(`🔊 committed ~${ms}ms cause=${cause} (→ respond)`);
      } else {
        console.log(`🔊 committed ~${ms}ms cause=${cause} (no respond)`);
      }
    } catch (e) {
      console.error("❌ send to Realtime failed:", e?.message || e);
    } finally {
      resetBuffer();
      turnStartedAt = Date.now();
    }
  }

  // Connect to OpenAI Realtime WS
  const oaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OAI_MODEL)}`;
  oaiWS = new WebSocket(oaiUrl, {
    headers: {
      "Authorization": `Bearer ${OAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    }
  });

  oaiWS.on("open", () => {
    console.log("🔗 OpenAI Realtime connected");

    // Configure session: input μ-law 8k; caller transcription model; voice; short turn-taking
    const sessionUpdate = {
      type: "session.update",
      session: {
        // Tell Realtime the input audio encoding matches Twilio stream
        input_audio_format: {
          type: "g711_ulaw",
          sample_rate_hz: TWILIO_SAMPLE_RATE,
        },
        // Ask for low-latency ASR
        input_audio_transcription: {
          model: TRANSCRIBE_MODEL,
        },
        // Synthesize voice
        voice: OAI_VOICE,
        // (Optional) keep responses concise and fast
        turn_detection: { type: "server_vad" }, // we drive commits, but enable for safety
      }
    };
    oaiWS.send(JSON.stringify(sessionUpdate));
  });

  oaiWS.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.type === "session.updated") {
      sessionHealthy = true;
      console.log(`✅ session.updated (ASR=${TRANSCRIBE_MODEL})`);
      return;
    }

    if (msg.type === "error") {
      console.error("🔻 OAI error:", msg);
      const code = msg?.error?.code;
      const p = msg?.error?.param || "";
      if (String(p).startsWith("session.") || code === "invalid_value" || code === "missing_required_parameter") {
        sessionError = true;
      }
      return;
    }

    // Track response lifecycle to avoid duplicate response.create
    if (msg.type === "response.created") {
      activeResponse = true;
      return;
    }
    if (
      msg.type === "response.completed" ||
      msg.type === "response.output_audio.done" ||
      msg.type === "response.refusal.delta"
    ) {
      activeResponse = false;
      return;
    }

    // Assistant transcript (for debugging)
    if (msg.type === "response.audio_transcript.delta" && msg.delta) {
      console.log("🗣️ ANNA SAID:", String(msg.delta));
      return;
    }

    // Caller transcript deltas appear after we commit input audio
    if (msg.type === "response.input_audio_transcription.delta" && msg.delta) {
      console.log("👂 YOU SAID:", String(msg.delta));
      return;
    }
    if (msg.type === "response.input_text.delta" && msg.delta) {
      console.log("👂 YOU SAID (text):", String(msg.delta));
      return;
    }

    // Assistant audio stream → Twilio "media" frames
    if (msg.type === "response.output_audio.delta" && msg.delta) {
      // The Realtime service defaults to 24k PCM16. We requested μ-law input only.
      // For output, we ask the model to render audio; the WS delta is base64 PCM16@24k by default.
      // To keep things simple and robust across versions, we send raw bytes to Twilio after μ-law encoding.
      // Naive downsample by 3 (24k -> 8k) then PCM16 -> μ-law.

      const pcm16 = Buffer.from(msg.delta, "base64"); // 16-bit little-endian PCM@24k
      const decimated = downsamplePCM16Mono(pcm16, 24000, 8000);
      const ulaw = pcm16ToMulaw(decimated);

      // Twilio expects JSON messages: { event: "media", media: { payload: base64 } }
      if (ulaw.length > 0 && socketOpen) {
        const payload = ulaw.toString("base64");
        twilioWS.send(JSON.stringify({ event: "media", media: { payload } }));
      }
      return;
    }

    // When a response finishes audio, Twilio needs a marker to flush playback
    if (msg.type === "response.output_audio.done") {
      // Send a tiny noop (Twilio flushes as it receives frames; nothing required)
      return;
    }
  });

  oaiWS.on("close", (code) => {
    console.log("🔚 OAI socket closed", code);
    sessionHealthy = false;
    activeResponse = false;
  });

  oaiWS.on("error", (err) => {
    console.error("💥 OAI socket error:", err?.message || err);
  });

  // Twilio media handling
  twilioWS.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case "start":
          console.log("📞 Twilio media stream connected");
          console.log(`🎬 Twilio stream START: streamSid=${msg.start?.streamSid}, voice=${OAI_VOICE}, model=${OAI_MODEL}, dev=${!!process.env.DEV}`);
          // reset per-turn state
          resetBuffer();
          lastSpeechAt = Date.now();
          turnStartedAt = Date.now();
          break;

        case "media": {
          const b = Buffer.from(msg.media.payload, "base64"); // μ-law 8k bytes (20ms ≈ 160B)
          if (b.length > 0) {
            // simple activity proxy
            const energy = ulawEnergy(b);
            if (energy >= SPEECH_THRESH) {
              lastSpeechAt = Date.now();
            }
            mulawChunks.push(b);
            bytesBuffered += b.length;
            if (bytesBuffered % 160 === 0) { // every ~20ms
              const pktNum = bytesBuffered / 160;
              if (pktNum % 50 === 0) console.log(`🟢 media pkt #${pktNum} (+160 bytes)`);
            }
          }
          break;
        }

        case "stop":
          console.log("🛑 Twilio STOP event");
          commitIfReady("stop");
          if (oaiWS && oaiWS.readyState === WebSocket.OPEN) {
            // allow the model to finish if mid response
          }
          break;
      }
    } catch (e) {
      console.error("💥 Twilio msg parse error:", e?.message || e);
    }
  });

  twilioWS.on("close", () => {
    console.log("❌ Twilio WS closed");
    socketOpen = false;
    try { oaiWS?.close(); } catch {}
  });

  twilioWS.on("error", (err) => {
    console.error("💥 Twilio WS error:", err?.message || err);
  });

  // VAD timer: commit on short pauses or max turn
  const vadPoll = setInterval(() => {
    if (!socketOpen || !sessionHealthy || sessionError) return;

    const now = Date.now();
    const longSilence = now - lastSpeechAt >= SILENCE_MS;
    const hitMax = now - turnStartedAt >= MAX_TURN_MS;
    const haveAudio = bytesBuffered >= MIN_COMMIT_BYTES && mulawChunks.length > 0;

    if ((longSilence || hitMax) && haveAudio) {
      commitIfReady(hitMax ? "max" : "silence");
    }
  }, 50);

  twilioWS.once("close", () => clearInterval(vadPoll));
});

// ------- PCM16(LE) -> μ-law (G.711) with naive downsample (24k -> 8k) -------

/**
 * Downsample PCM16 mono from srcHz to dstHz (integer factor). Naive decimation (keep every Nth frame).
 * Expects Buffer with little-endian 16-bit samples.
 */
function downsamplePCM16Mono(buf, srcHz, dstHz) {
  if (srcHz === dstHz) return buf;
  const factor = srcHz / dstHz;
  if (Math.abs(factor - Math.round(factor)) > 1e-6) {
    // Non-integer factors are out of scope for this minimal bridge; fall back to rough nearest
    return buf; // worst-case: Twilio still plays; quality may degrade
  }
  const N = Math.round(factor);
  const out = Buffer.allocUnsafe((buf.length / 2 / N | 0) * 2);
  let oi = 0;
  for (let i = 0; i + 1 < buf.length; i += N * 2) {
    out[oi++] = buf[i];
    out[oi++] = buf[i+1];
  }
  return out.slice(0, oi);
}

/**
 * Convert PCM16 LE mono → G.711 μ-law bytes
 * Based on ITU-T G.711, simplified JS port.
 */
function pcm16ToMulaw(pcmBuf) {
  const len = pcmBuf.length / 2 | 0;
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    const s = pcmBuf.readInt16LE(i * 2);
    out[i] = linear2ulaw(s);
  }
  return out;
}

// μ-law constants
const BIAS = 0x84;
const CLIP = 32635;

function linear2ulaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;
  let exponent = exp_lut[(sample >> 7) & 0xFF];
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let ulawbyte = ~(sign | (exponent << 4) | mantissa);
  return ulawbyte & 0xFF;
}

// precomputed exponent lookup (256 entries)
const exp_lut = (() => {
  const lut = new Uint8Array(256);
  let exp = 7;
  let mask = 0x4000;
  for (let i = 0; i < 256; i++) {
    let val = (i << 7);
    while (exp > 0 && val < mask) { mask >>= 1; exp--; }
    lut[i] = exp;
    exp = 7; mask = 0x4000;
  }
  return lut;
})();

// ------- Start server -------
server.listen(PORT, () => {
  console.log(`🚀 server listening on :${PORT}`);
});
