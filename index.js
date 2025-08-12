// index.js — Twilio PSTN ↔ OpenAI Realtime (μ-law), frame-aligned commits, "let me finish"

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ===== Env =====
const PORT = process.env.PORT || 3000;
const STREAM_WS_URL = process.env.STREAM_WS_URL || "wss://dpa-fly-backend-twilio.fly.dev/call";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const VOICE = (process.env.VOICE || "coral").toLowerCase();

const DEV_MODE = String(process.env.ANNA_DEV_MODE || "true").toLowerCase() === "true";
const DEV_CALLER_NAME = process.env.DEV_CALLER_NAME || "JP";

const PROJECT_BRIEF =
  process.env.PROJECT_BRIEF ||
  `Digital Personal Assistant (DPA)
- Goal: natural phone assistant for JP.
- Priorities: realtime voice (AU/UK female), low latency, avoid unsolicited number capture.
- Dev mode: caller is ${DEV_CALLER_NAME}. Be concise. Flag latency/overlap issues.`;

// ===== μ-law constants =====
const FRAME_BYTES = 160;   // 20ms @ 8kHz μ-law
const FRAME_MS = 20;

// Strict minimum to avoid "commit_empty" (5 frames = 100ms)
const MIN_COMMIT_FRAMES = 5;
const MIN_COMMIT_BYTES = FRAME_BYTES * MIN_COMMIT_FRAMES;

// Let user finish before reply
const VAD_SPEECH_THRESH = Number(process.env.VAD_SPEECH_THRESH || 12);   // energy gate
const VAD_SILENCE_MS    = Number(process.env.VAD_SILENCE_MS || 900);     // pause before we speak
const VAD_MAX_TURN_MS   = Number(process.env.VAD_MAX_TURN_MS || 10000);  // hard cap for user turn

// Micro streaming: keep pipe moving but never <100ms
const MICRO_COMMIT_EVERY_MS = Number(process.env.MICRO_COMMIT_EVERY_MS || 350);
const MAX_BUNDLE_FRAMES     = Number(process.env.MAX_BUNDLE_FRAMES || 30); // 30*20ms ≈ 600ms
const MAX_BUNDLE_BYTES      = FRAME_BYTES * MAX_BUNDLE_FRAMES;

function ulawEnergy(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += Math.abs(buf[i] - 0x7f);
  return s / buf.length;
}

// ===== TwiML (no twilio sdk) =====
function twiml() {
  return `
<Response>
  <Connect>
    <Stream url="${STREAM_WS_URL}" track="inbound_track"/>
  </Connect>
  <Pause length="30"/>
</Response>`.trim();
}

app.post("/twilio/voice", (_req, res) => {
  console.log("➡️ /twilio/voice hit (POST)");
  const xml = twiml();
  console.log("🧾 TwiML returned:", xml);
  res.type("text/xml").send(xml);
});
app.get("/twilio/voice", (_req, res) => {
  console.log("➡️ /twilio/voice hit (GET)");
  const xml = twiml();
  console.log("🧾 TwiML returned:", xml);
  res.type("text/xml").send(xml);
});
app.get("/", (_req, res) => res.status(200).send("Realtime DPA backend is live"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ===== Server & WS upgrade =====
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  console.log("🛰 HTTP upgrade requested:", req.method, req.url);
  console.log("     headers:", {
    host: req.headers.host,
    origin: req.headers.origin,
    upgrade: req.headers.upgrade,
    "sec-websocket-key": req.headers["sec-websocket-key"],
    "sec-websocket-protocol": req.headers["sec-websocket-protocol"],
    "sec-websocket-version": req.headers["sec-websocket-version"],
  });
  if (req.url === "/call") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    try { socket.destroy(); } catch {}
  }
});

// ===== Bridge Twilio <-> OpenAI =====
wss.on("connection", async (twilioWS, req) => {
  console.log("✅ Twilio WebSocket connected from", req.headers["x-forwarded-for"] || req.socket.remoteAddress);
  if (!OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY not set — closing");
    try { twilioWS.close(); } catch {}
    return;
  }

  // OpenAI Realtime WS
  const oai = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  let streamSid = null;

  // Buffer as an array of chunks + total length
  let chunkQueue = [];
  let queuedBytes = 0;

  let lastSpeechAt = Date.now();
  let turnStartedAt = Date.now();
  let lastCommitAt = Date.now();

  let mediaPackets = 0;
  let sentBytesToTwilio = 0;

  const bytesToMs = (bytes) => Math.round((bytes / FRAME_BYTES) * FRAME_MS);

  // Helpers for frame-aligned take
  function framesAvailable() {
    return Math.floor(queuedBytes / FRAME_BYTES);
  }
  function takeBytesAligned(maxBytes) {
    // Only return a multiple of FRAME_BYTES, up to maxBytes
    const maxAligned = Math.floor(Math.min(queuedBytes, maxBytes) / FRAME_BYTES) * FRAME_BYTES;
    if (maxAligned <= 0) return Buffer.alloc(0);

    let need = maxAligned;
    const out = Buffer.allocUnsafe(maxAligned);
    let offset = 0;

    while (need > 0 && chunkQueue.length) {
      const head = chunkQueue[0];
      if (head.length <= need) {
        head.copy(out, offset);
        offset += head.length;
        need -= head.length;
        chunkQueue.shift();
      } else {
        // split head
        head.copy(out, offset, 0, need);
        chunkQueue[0] = head.subarray(need);
        offset += need;
        need = 0;
      }
    }
    queuedBytes -= maxAligned;
    return out;
  }

  // ==== OpenAI lifecycle ====
  oai.on("open", () => {
    console.log("🔗 OpenAI Realtime connected");

    const instructions = DEV_MODE
      ? `You are Anna, JP’s digital personal assistant and part of the build team.
Caller is ${DEV_CALLER_NAME}. Use a clear UK/AU female delivery with the '${VOICE}' voice.
Wait for the caller to finish (brief pause) before replying. Keep replies concise and contextual.`
      : `You are Anna. Be concise and wait for the caller to finish before replying.`;

    oai.send(JSON.stringify({
      type: "session.update",
      session: {
        input_audio_format:  "g711_ulaw",   // string form per API
        output_audio_format: "g711_ulaw",
        modalities: ["audio","text"],
        voice: VOICE,
        instructions
      }
    }));
  });
  oai.on("error", (e) => console.error("🔻 OAI socket error:", e?.message || e));
  oai.on("close", (c, r) => console.log("🔚 OAI socket closed", c, r?.toString?.() || ""));

  // OpenAI -> Twilio (audio)
  oai.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!streamSid) return;

    if (msg.type === "response.audio.delta" && msg.delta) {
      const b64 = msg.delta;
      try {
        twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
        sentBytesToTwilio += Buffer.from(b64, "base64").length;
        if (sentBytesToTwilio < 2000 || sentBytesToTwilio % 48000 === 0) {
          console.log(`📤 sent to Twilio: ${sentBytesToTwilio} bytes total`);
        }
      } catch (e) {
        console.error("❌ send audio to Twilio failed:", e?.message || e);
      }
    }
    if (msg.type === "response.output_audio.delta" && msg.audio) {
      const b64 = msg.audio;
      try {
        twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
        sentBytesToTwilio += Buffer.from(b64, "base64").length;
        if (sentBytesToTwilio < 2000 || sentBytesToTwilio % 48000 === 0) {
          console.log(`📤 sent to Twilio: ${sentBytesToTwilio} bytes total`);
        }
      } catch (e) {
        console.error("❌ send audio to Twilio failed:", e?.message || e);
      }
    }
    if (msg.type === "response.audio.done" || msg.type === "response.output_audio.done") {
      try { twilioWS.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts-done" } })); } catch {}
    }
    if (msg.type === "error") console.error("🔻 OAI error:", msg);
  });

  // ==== Commit loop (only when we appended data this tick) ====
  const tick = setInterval(() => {
    if (oai.readyState !== WebSocket.OPEN) return;

    const now = Date.now();
    const haveFrames = framesAvailable();
    if (haveFrames < MIN_COMMIT_FRAMES) return; // <100ms → do nothing

    const longSilence = now - lastSpeechAt >= VAD_SILENCE_MS;
    const hitMax = now - turnStartedAt >= VAD_MAX_TURN_MS;
    const dueMicro = now - lastCommitAt >= MICRO_COMMIT_EVERY_MS;

    // Amount to send this tick (frame-aligned, never less than 100ms)
    const maxThisTick = (longSilence || hitMax) ? MAX_BUNDLE_BYTES : Math.min(MAX_BUNDLE_BYTES, queuedBytes);
    const slice = takeBytesAligned(maxThisTick);
    if (slice.length < MIN_COMMIT_BYTES) {
      // put it back if we somehow took <100ms (shouldn't happen due to guards)
      if (slice.length) {
        chunkQueue.unshift(slice); // revert
        queuedBytes += slice.length;
      }
      return;
    }

    try {
      oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: slice.toString("base64") }));
      oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      if (longSilence || hitMax) {
        oai.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio","text"] } }));
        console.log(`🔊 committed ~${bytesToMs(slice.length)}ms cause=${longSilence ? "silence" : "max"} (→ respond)`);
        turnStartedAt = now;
      } else if (dueMicro) {
        console.log(`🔊 committed ~${bytesToMs(slice.length)}ms cause=micro (no respond)`);
      } else {
        // Not time for a micro yet → hold off; put back remaining bytes if any
        // (We already sent a decent chunk; skipping extra log noise.)
      }
      lastCommitAt = now;
    } catch (e) {
      console.error("❌ send to Realtime failed:", e?.message || e);
    }
  }, 40);

  // ==== Twilio inbound media ====
  twilioWS.on("message", (raw) => {
    let data; try { data = JSON.parse(raw.toString()); } catch { return; }
    switch (data.event) {
      case "connected":
        console.log("📞 Twilio media stream connected");
        break;

      case "start":
        streamSid = data.start?.streamSid || null;
        console.log(`🎬 Twilio stream START: streamSid=${streamSid}, voice=${VOICE}, model=${REALTIME_MODEL}, dev=${DEV_MODE}`);
        chunkQueue = [];
        queuedBytes = 0;
        mediaPackets = 0;
        sentBytesToTwilio = 0;
        lastSpeechAt = Date.now();
        turnStartedAt = Date.now();
        lastCommitAt = Date.now();
        break;

      case "media": {
        const b64 = data?.media?.payload; if (!b64) break;
        const mulaw = Buffer.from(b64, "base64");
        mediaPackets += 1;
        if (mediaPackets <= 5 || mediaPackets % 50 === 0) {
          console.log(`🟢 media pkt #${mediaPackets} (+${mulaw.length} bytes)`);
        }
        const e = ulawEnergy(mulaw);
        if (e > VAD_SPEECH_THRESH) lastSpeechAt = Date.now();

        // enqueue
        chunkQueue.push(mulaw);
        queuedBytes += mulaw.length;
        break;
      }

      case "stop":
        console.log("🛑 Twilio STOP event");
        cleanup();
        break;

      default:
        // ignore marks, etc.
        break;
    }
  });

  twilioWS.on("close", () => { console.log("❌ Twilio WS closed"); cleanup(); });
  twilioWS.on("error", (err) => { console.error("⚠️ Twilio WS error:", err?.message || err); cleanup(); });

  function cleanup() {
    try { clearInterval(tick); } catch {}
    try { if (oai.readyState === WebSocket.OPEN) oai.close(); } catch {}
    try { if (twilioWS.readyState === WebSocket.OPEN) twilioWS.close(); } catch {}
  }
});

// ===== Start =====
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Realtime DPA listening on 0.0.0.0:${PORT}`);
});
server.on("clientError", (err, socket) => {
  console.error("💥 HTTP clientError:", err?.message || err);
  try { socket.destroy(); } catch {}
});
