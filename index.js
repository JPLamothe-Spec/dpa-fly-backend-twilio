// index.js — Twilio PSTN ↔ OpenAI Realtime (μ-law), strict commit guard, silence-only commits, transcript logs

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------- Env ----------
const PORT = process.env.PORT || 3000;
const STREAM_WS_URL = process.env.STREAM_WS_URL || "wss://dpa-fly-backend-twilio.fly.dev/call";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const VOICE = (process.env.VOICE || "coral").toLowerCase();

const DEV_MODE = String(process.env.ANNA_DEV_MODE || "true").toLowerCase() === "true";
const DEV_CALLER_NAME = process.env.DEV_CALLER_NAME || "JP";

const PROJECT_BRIEF = process.env.PROJECT_BRIEF || `Digital Personal Assistant (DPA)
- Natural phone assistant for JP.
- Priorities: UK/AU female voice, low latency, wait for caller, avoid unsolicited number capture.
- Dev mode: caller is ${DEV_CALLER_NAME}. Keep replies concise and contextual; don't re-ask the same question.`;

// ---------- Audio & VAD ----------
const FRAME_BYTES = 160;     // 20 ms @ 8kHz μ-law
const FRAME_MS = 20;

const MIN_COMMIT_FRAMES = 5; // >=100 ms required by API
const MIN_COMMIT_BYTES = FRAME_BYTES * MIN_COMMIT_FRAMES;

const VAD_SPEECH_THRESH = Number(process.env.VAD_SPEECH_THRESH || 12);   // 8–20 typical
const VAD_SILENCE_MS    = Number(process.env.VAD_SILENCE_MS || 1100);    // how long to wait after user stops
const VAD_MAX_TURN_MS   = Number(process.env.VAD_MAX_TURN_MS || 8000);   // force a commit at most every 8s

// NO MICRO COMMITS: keep it simple until stable
const TICK_MS = 40;

function ulawEnergy(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += Math.abs(buf[i] - 0x7f);
  return s / buf.length;
}

// ---------- TwiML ----------
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

// ---------- Server / Upgrade ----------
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

// ---------- Twilio <-> OpenAI Bridge ----------
wss.on("connection", async (twilioWS, req) => {
  console.log("✅ Twilio WebSocket connected from", req.headers["x-forwarded-for"] || req.socket.remoteAddress);
  if (!OPENAI_API_KEY) { console.error("❌ OPENAI_API_KEY not set — closing"); try { twilioWS.close(); } catch {}; return; }

  const oai = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  let streamSid = null;

  // inbound buffer (μ-law frames)
  let chunkQueue = [];
  let queuedBytes = 0;

  // state
  let lastSpeechAt = Date.now();
  let turnStartedAt = Date.now();
  let lastAppendBytes = 0;              // bytes appended since last commit (strict guard)
  let mediaPackets = 0;
  let sentBytesToTwilio = 0;

  const bytesToMs = (bytes) => Math.round((bytes / FRAME_BYTES) * FRAME_MS);

  function framesAvailable() { return Math.floor(queuedBytes / FRAME_BYTES); }

  function takeBytesAligned(maxBytes) {
    const takeAligned = Math.floor(Math.min(queuedBytes, maxBytes) / FRAME_BYTES) * FRAME_BYTES;
    if (takeAligned <= 0) return Buffer.alloc(0);

    let need = takeAligned;
    const out = Buffer.allocUnsafe(takeAligned);
    let off = 0;

    while (need > 0 && chunkQueue.length) {
      const head = chunkQueue[0];
      if (head.length <= need) {
        head.copy(out, off);
        off += head.length;
        need -= head.length;
        chunkQueue.shift();
      } else {
        head.copy(out, off, 0, need);
        chunkQueue[0] = head.subarray(need);
        off += need;
        need = 0;
      }
    }
    queuedBytes -= takeAligned;
    return out;
  }

  // ----- OpenAI lifecycle -----
  oai.on("open", () => {
    console.log("🔗 OpenAI Realtime connected");

    const instructions = DEV_MODE
      ? `You are Anna, JP’s digital personal assistant and a member of the build team.
Caller is ${DEV_CALLER_NAME}. Use '${VOICE}' voice (UK/AU female).
Wait for a brief pause before replying. Do not ask the same "How can I help?" repeatedly.
If the last user turn is short or unclear, ask a specific clarifying question instead of repeating the prompt.`
      : `You are Anna. Wait for brief pauses before replying; avoid repeating yourself.`;

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

  // OpenAI -> Twilio (TTS out)
  oai.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.type?.startsWith?.("response.")) {
      // log partial transcripts to verify what Anna "heard"
      if (msg.type === "response.audio_transcript.delta" && msg.delta) {
        console.log("📝 heard+transcribing:", String(msg.delta).slice(0, 200));
      }
    }
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

  // ----- Commit loop (silence-only) -----
  const tick = setInterval(() => {
    if (oai.readyState !== WebSocket.OPEN) return;

    const now = Date.now();
    const haveFrames = framesAvailable();
    if (haveFrames * FRAME_BYTES < MIN_COMMIT_BYTES) return;  // <100ms → don't touch

    const longSilence = now - lastSpeechAt >= VAD_SILENCE_MS;
    const hitMaxTurn = now - turnStartedAt >= VAD_MAX_TURN_MS;

    if (!longSilence && !hitMaxTurn) return;

    // take as much as we have (frame-aligned)
    const slice = takeBytesAligned(queuedBytes);
    if (slice.length < MIN_COMMIT_BYTES) {
      // safety: put back if we somehow grabbed <100ms
      if (slice.length) { chunkQueue.unshift(slice); queuedBytes += slice.length; }
      return;
    }

    try {
      // strict guard: only commit if we appended this tick
      oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: slice.toString("base64") }));
      lastAppendBytes = slice.length;

      oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      console.log(`🔊 committed ~${bytesToMs(slice.length)}ms cause=${longSilence ? "silence" : "max"} (→ respond)`);

      // Immediately request a response
      oai.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio","text"] } }));

      // reset turn timers
      lastAppendBytes = 0;
      turnStartedAt = now;
    } catch (e) {
      console.error("❌ send to Realtime failed:", e?.message || e);
    }
  }, TICK_MS);

  // ----- Twilio inbound -----
  twilioWS.on("message", (raw) => {
    let data; try { data = JSON.parse(raw.toString()); } catch { return; }
    switch (data.event) {
      case "connected":
        console.log("📞 Twilio media stream connected");
        break;

      case "start":
        streamSid = data.start?.streamSid || null;
        console.log(`🎬 Twilio stream START: streamSid=${streamSid}, voice=${VOICE}, model=${REALTIME_MODEL}, dev=${DEV_MODE}`);
        // reset state
        chunkQueue = [];
        queuedBytes = 0;
        mediaPackets = 0;
        sentBytesToTwilio = 0;
        lastSpeechAt = Date.now();
        turnStartedAt = Date.now();
        lastAppendBytes = 0;
        break;

      case "media": {
        const b64 = data?.media?.payload; if (!b64) break;
        const mulaw = Buffer.from(b64, "base64");
        mediaPackets += 1;
        if (mediaPackets <= 5 || mediaPackets % 50 === 0) {
          console.log(`🟢 media pkt #${mediaPackets} (+${mulaw.length} bytes)`);
        }
        // VAD
        const e = ulawEnergy(mulaw);
        if (e > VAD_SPEECH_THRESH) lastSpeechAt = Date.now();

        chunkQueue.push(mulaw);
        queuedBytes += mulaw.length;
        break;
      }

      case "stop":
        console.log("🛑 Twilio STOP event");
        cleanup();
        break;

      default:
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

// ---------- Start ----------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Realtime DPA listening on 0.0.0.0:${PORT}`);
});
server.on("clientError", (err, socket) => {
  console.error("💥 HTTP clientError:", err?.message || err);
  try { socket.destroy(); } catch {}
});
