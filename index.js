// index.js — Twilio PSTN ↔ OpenAI Realtime (μ-law), WS-ok + audio fixes
// Changes:
//  - response.create uses ["audio","text"] (fixes invalid modalities)
//  - Commit only when ≥100ms (~800 bytes) buffered (fixes empty-buffer errors)
//  - Media packet counters for visibility

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const STREAM_WS_URL = process.env.STREAM_WS_URL || "wss://dpa-fly-backend-twilio.fly.dev/call";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const VOICE = (process.env.VOICE || "verse").toLowerCase();
const DEV_MODE = String(process.env.ANNA_DEV_MODE || "true").toLowerCase() === "true";
const DEV_CALLER_NAME = process.env.DEV_CALLER_NAME || "JP";

// μ-law @ 8kHz ⇒ ~800 bytes = 100ms
const MIN_COMMIT_BYTES = Number(process.env.MIN_COMMIT_BYTES || 800);
const SPEECH_THRESH = Number(process.env.VAD_SPEECH_THRESH || 22);
const SILENCE_MS    = Number(process.env.VAD_SILENCE_MS || 1100);
const MAX_TURN_MS   = Number(process.env.VAD_MAX_TURN_MS || 6000);

const PROJECT_BRIEF = process.env.PROJECT_BRIEF || `Digital Personal Assistant (DPA) Project
- Goal: natural, low-latency phone assistant for JP.
- Priorities: realtime voice, UK/AU female voice, no unsolicited number capture, low latency, smooth barge-in.
- Dev mode: treat caller as JP (teammate). Be concise, flag issues (latency, transcription, overlap), suggest next tests.
- Behaviours: avoid asking for phone numbers unless explicitly requested. Keep replies short unless asked to elaborate.`;

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

// --- Twilio webhook ---
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

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// --- Upgrade diagnostics ---
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
  if (!OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY not set — closing"); try { twilioWS.close(); } catch {} ; return;
  }

  const oai = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  let streamSid = null;
  let mulawChunks = [];
  let bytesBuffered = 0;
  let lastSpeechAt = Date.now();
  let turnStartedAt = Date.now();
  let mediaPackets = 0;

  oai.on("open", () => {
    console.log("🔗 OpenAI Realtime connected");

    const instructions = DEV_MODE
      ? `You are Anna, JP’s English-accented digital personal assistant AND a core member of the DPA build team.
Caller is ${DEV_CALLER_NAME}. Be concise. Avoid asking for phone numbers unless requested.

PROJECT BRIEF:
${PROJECT_BRIEF}`
      : `You are Anna, JP’s assistant on a live phone call. Be concise and helpful.`;

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
  });
  oai.on("error", (e) => console.error("🔻 OAI socket error:", e?.message || e));
  oai.on("close", (c, r) => console.log("🔚 OAI socket closed", c, r?.toString?.() || ""));

  // OAI -> Twilio audio
  oai.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!streamSid) return;
    if (msg.type === "response.output_audio.delta" && msg.audio) {
      try {
        twilioWS.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: Buffer.from(msg.audio, "base64").toString("base64") }
        }));
      } catch (e) {
        console.error("❌ send audio to Twilio failed:", e?.message || e);
      }
    }
    if (msg.type === "response.output_audio.done") {
      try { twilioWS.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts-done" } })); } catch {}
    }
    if (msg.type === "error") console.error("🔻 OAI error:", msg);
  });

  // Commit when silence/max-turn AND enough audio buffered
  const vadPoll = setInterval(() => {
    const now = Date.now();
    const longSilence = now - lastSpeechAt >= SILENCE_MS;
    const hitMax = now - turnStartedAt >= MAX_TURN_MS;

    if ((longSilence || hitMax) && bytesBuffered >= MIN_COMMIT_BYTES) {
      const b64 = Buffer.concat(mulawChunks).toString("base64");
      try {
        oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
        oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        oai.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio","text"] } }));
        // reset
        mulawChunks = [];
        bytesBuffered = 0;
        turnStartedAt = Date.now();
        console.log(`🔊 committed ~${Math.round((b64.length*0.75)/80)}ms (${bytesBuffered} bytes pre-reset)`);
      } catch (e) {
        console.error("❌ send to Realtime failed:", e?.message || e);
      }
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
        lastSpeechAt = Date.now();
        turnStartedAt = Date.now();
        // Proactive greeting (no input required)
        try { oai.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio","text"] } })); } catch {}
        break;
      case "media": {
        const b64 = data?.media?.payload; if (!b64) break;
        const mulaw = Buffer.from(b64, "base64");
        mediaPackets += 1;
        if (mediaPackets <= 5 || mediaPackets % 50 === 0) {
          console.log(`🟢 media pkt #${mediaPackets} (+${mulaw.length} bytes)`);
        }
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
    try { if (oai.readyState === WebSocket.OPEN) oai.close(); } catch {}
    try { if (twilioWS.readyState === WebSocket.OPEN) twilioWS.close(); } catch {}
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Realtime DPA listening on 0.0.0.0:${PORT}`);
});
server.on("clientError", (err, socket) => {
  console.error("💥 HTTP clientError:", err?.message || err);
  try { socket.destroy(); } catch {}
});
