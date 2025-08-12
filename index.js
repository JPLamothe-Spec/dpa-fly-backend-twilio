// index.js — Twilio PSTN ↔ OpenAI Realtime (μ-law) with paced audio-out (fixed formats)

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---- Config ----
const PORT = Number(process.env.PORT || 3000);
const STREAM_WS_URL =
  process.env.STREAM_WS_URL ||
  (process.env.PUBLIC_URL ? `wss://${new URL(process.env.PUBLIC_URL).host}/call` : "wss://dpa-fly-backend-twilio.fly.dev/call");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// Valid voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse
const VOICE = (process.env.VOICE || "coral").toLowerCase();

const DEV_MODE = String(process.env.ANNA_DEV_MODE || "true").toLowerCase() === "true";
const DEV_CALLER_NAME = process.env.DEV_CALLER_NAME || "JP";

// μ-law at 8kHz → 160 bytes per 20ms frame
const FRAME_BYTES = 160;
const FRAME_MS = 20;

// Commit policy (caller → OpenAI)
const MIN_COMMIT_BYTES = Number(process.env.MIN_COMMIT_BYTES || 800); // ~100ms
const SPEECH_THRESH = Number(process.env.VAD_SPEECH_THRESH || 12);
const SILENCE_MS    = Number(process.env.VAD_SILENCE_MS || 700);
const MAX_TURN_MS   = Number(process.env.VAD_MAX_TURN_MS || 15000);

// Optional brief for dev mode
const PROJECT_BRIEF = process.env.PROJECT_BRIEF || `Digital Personal Assistant (DPA) Project
- Goal: natural, low-latency phone assistant.
- Priorities: realtime voice, Australian tone, low latency, smooth barge-in.
- Dev mode: treat caller as ${DEV_CALLER_NAME}. Be concise; flag issues (latency, overlap).`;

function ulawEnergy(buf){ let s=0; for(let i=0;i<buf.length;i++) s+=Math.abs(buf[i]-0x7f); return s/buf.length; }

function twiml() {
  return `
<Response>
  <Connect>
    <Stream url="${STREAM_WS_URL}" track="inbound_track"/>
  </Connect>
  <Pause length="30"/>
</Response>`.trim();
}

// --- Twilio webhook (TwiML) ---
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

// --- HTTP(S) + WS upgrade ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  console.log("🛰  HTTP upgrade requested:", req.method, req.url);
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
    console.log("🚫 Upgrade path not /call — closing");
    try { socket.destroy(); } catch {}
  }
});

// --- Bridge Twilio <-> OpenAI Realtime ---
wss.on("connection", async (twilioWS, req) => {
  console.log("✅ Twilio WebSocket connected from", req.headers["x-forwarded-for"] || req.socket.remoteAddress);
  if (!OPENAI_API_KEY) { console.error("❌ OPENAI_API_KEY not set — closing"); try { twilioWS.close(); } catch {}; return; }

  const oai = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  let streamSid = null;

  // Inbound (Twilio→OAI) buffers
  let mulawChunks = [];
  let bytesBuffered = 0;
  let lastSpeechAt = Date.now();
  let turnStartedAt = Date.now();
  let mediaPackets = 0;

  // Outbound (OAI→Twilio) pacing queue (160B / 20ms)
  let ttsQueue = [];
  let ttsTimer = null;
  let carry = Buffer.alloc(0); // hold partial frames across deltas
  let sentBytesToTwilio = 0;

  function startPacer(){
    if (ttsTimer) return;
    ttsTimer = setInterval(() => {
      if (!streamSid) return;
      const chunk = ttsQueue.shift();
      if (!chunk) {
        clearInterval(ttsTimer); ttsTimer = null; return;
      }
      try {
        twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload: chunk.toString("base64") } }));
        sentBytesToTwilio += chunk.length;
        if (sentBytesToTwilio < 2000 || sentBytesToTwilio % 48000 === 0) {
          console.log(`📤 sent to Twilio: ${sentBytesToTwilio} bytes total`);
        }
      } catch (e) {
        console.error("❌ send audio to Twilio failed:", e?.message || e);
      }
    }, FRAME_MS);
  }

  function enqueueForTwilio(base64Ulaw){
    const incoming = Buffer.from(base64Ulaw, "base64");
    const buf = carry.length ? Buffer.concat([carry, incoming]) : incoming;
    const fullFramesLen = Math.floor(buf.length / FRAME_BYTES) * FRAME_BYTES;
    const frames = buf.subarray(0, fullFramesLen);
    carry = buf.subarray(fullFramesLen); // keep remainder for next delta
    for (let i = 0; i < frames.length; i += FRAME_BYTES) {
      ttsQueue.push(frames.subarray(i, i + FRAME_BYTES));
    }
    startPacer();
  }

  oai.on("open", () => {
    console.log("🔗 OpenAI Realtime connected");

    const instructions = DEV_MODE
      ? `You are Anna, a friendly Australian voice assistant for ${DEV_CALLER_NAME}.
Speak with a natural Australian accent, warm and clear. Keep turns concise.
If the caller pauses, finish your sentence and stop. Avoid asking for phone numbers unless requested.

PROJECT BRIEF:
${PROJECT_BRIEF}`
      : `You are Anna, a friendly Australian voice assistant. Keep responses concise.`;

    // IMPORTANT: formats as string literals, not objects
    oai.send(JSON.stringify({
      type: "session.update",
      session: {
        input_audio_format:  "g711_ulaw",
        output_audio_format: "g711_ulaw",
        modalities: ["audio","text"],
        voice: VOICE,
        instructions
      }
    }));

    // Tiny greeting
    try {
      oai.send(JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio","text"], instructions: "Hi, I’m ready. How can I help?" }
      }));
    } catch {}
  });

  oai.on("error", (e) => console.error("🔻 OAI socket error:", e?.message || e));
  oai.on("close", (c, r) => console.log("🔚 OAI socket closed", c, r?.toString?.() || ""));

  // ---- OpenAI -> Twilio audio (modern + older event shapes) ----
  oai.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (!streamSid) return;

    // Modern: response.audio.delta → msg.delta
    if (msg.type === "response.audio.delta" && msg.delta) {
      enqueueForTwilio(msg.delta);
    }

    // Older: response.output_audio.delta → msg.audio
    if (msg.type === "response.output_audio.delta" && msg.audio) {
      enqueueForTwilio(msg.audio);
    }

    if (msg.type === "response.audio.done" || msg.type === "response.output_audio.done") {
      try { twilioWS.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts-done" } })); } catch {}
    }

    if (msg.type === "error") console.error("🔻 OAI error:", msg);
  });

  // ---- Caller → OpenAI commit logic (simple VAD-ish) ----
  const vadPoll = setInterval(() => {
    const now = Date.now();
    const longSilence = now - lastSpeechAt >= SILENCE_MS;
    const hitMax = now - turnStartedAt >= MAX_TURN_MS;
    const haveAudio = bytesBuffered >= MIN_COMMIT_BYTES && mulawChunks.length > 0;

    if ((longSilence || hitMax) && haveAudio) {
      const payloadBuf = Buffer.concat(mulawChunks);
      const b64 = payloadBuf.toString("base64");
      const ms = Math.round((payloadBuf.length / FRAME_BYTES) * FRAME_MS);

      try {
        oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
        oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        oai.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio","text"] } }));
        console.log(`🔊 committed ~${ms}ms (${payloadBuf.length} bytes)`);
      } catch (e) {
        console.error("❌ send to Realtime failed:", e?.message || e);
      }
      // reset after logging
      mulawChunks = [];
      bytesBuffered = 0;
      turnStartedAt = Date.now();
    }
  }, 50);

  // Twilio inbound media
  twilioWS.on("message", (raw) => {
    let data; try { data = JSON.parse(raw.toString()); } catch { return; }
    switch (data.event) {
      case "connected":
        console.log("📞 Twilio media stream connected");
        break;

      case "start":
        streamSid = data.start?.streamSid || null;
        console.log(`🎬 Twilio stream START: streamSid=${streamSid}, voice=${VOICE}, model=${REALTIME_MODEL}, dev=${DEV_MODE}`);
        mulawChunks = [];
        bytesBuffered = 0;
        mediaPackets = 0;
        sentBytesToTwilio = 0;
        carry = Buffer.alloc(0);
        lastSpeechAt = Date.now();
        turnStartedAt = Date.now();
        // Backup greeting
        try {
          oai.send(JSON.stringify({
            type: "response.create",
            response: { modalities: ["audio","text"], instructions: "Hi! How can I help?" }
          }));
        } catch {}
        break;

      case "media": {
        const b64 = data?.media?.payload; if (!b64) break;
        const mulaw = Buffer.from(b64, "base64");
        mediaPackets += 1;
        if (mediaPackets <= 5 || mediaPackets % 50 === 0) console.log(`🟢 media pkt #${mediaPackets} (+${mulaw.length} bytes)`);
        const e = ulawEnergy(mulaw);
        if (e > SPEECH_THRESH) lastSpeechAt = Date.now();
        mulawChunks.push(mulaw);
        bytesBuffered += mulaw.length;
        break;
      }

      case "mark":
        break;

      case "stop":
        console.log("🛑 Twilio STOP event");
        cleanup();
        break;

      default:
        console.log("ℹ️ Twilio event:", data.event);
    }
  });

  twilioWS.on("close", () => { console.log("❌ Twilio WS closed"); cleanup(); });
  twilioWS.on("error", (err) => { console.error("⚠️ Twilio WS error:", err?.message || err); cleanup(); });

  function cleanup(){
    try { clearInterval(vadPoll); } catch {}
    try { if (ttsTimer) { clearInterval(ttsTimer); ttsTimer = null; } } catch {}
    try { if (oai.readyState === WebSocket.OPEN) oai.close(); } catch {}
    try { if (twilioWS.readyState === WebSocket.OPEN) twilioWS.close(); } catch {}
  }
});

// ---- Start server ----
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Realtime DPA listening on 0.0.0.0:${PORT}`);
});
server.on("clientError", (err, socket) => {
  console.error("💥 HTTP clientError:", err?.message || err);
  try { socket.destroy(); } catch {}
});
