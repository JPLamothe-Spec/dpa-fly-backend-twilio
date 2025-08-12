// index.js — Twilio PSTN ↔ OpenAI Realtime (μ-law), "let me finish" tuning

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ===== Env & defaults =====
const PORT = process.env.PORT || 3000;
const STREAM_WS_URL =
  process.env.STREAM_WS_URL || "wss://dpa-fly-backend-twilio.fly.dev/call";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const VOICE = (process.env.VOICE || "coral").toLowerCase();

const DEV_MODE = String(process.env.ANNA_DEV_MODE || "true").toLowerCase() === "true";
const DEV_CALLER_NAME = process.env.DEV_CALLER_NAME || "JP";

const PROJECT_BRIEF =
  process.env.PROJECT_BRIEF ||
  `Digital Personal Assistant (DPA)
- Goal: natural, low-latency phone assistant for JP.
- Priorities: realtime voice, AU/UK female vibe, no unsolicited number capture, low latency, clean barge-in.
- Dev mode: treat caller as ${DEV_CALLER_NAME}. Be concise. Flag latency/overlap issues.`;

// μ-law (G.711) @ 8kHz: Twilio sends 20ms packets (160 bytes each)
const FRAME_BYTES = 160;           // 20ms
const FRAME_MS = 20;

// Commit policy (caller → OpenAI)
const MIN_COMMIT_BYTES = Number(process.env.MIN_COMMIT_BYTES || 800); // ~100ms
const SPEECH_THRESH    = Number(process.env.VAD_SPEECH_THRESH || 12); // energy gate
const SILENCE_MS       = Number(process.env.VAD_SILENCE_MS || 900);   // wait ~0.9s after stop
const MAX_TURN_MS      = Number(process.env.VAD_MAX_TURN_MS || 10000);// 10s cap

// Micro-commit pacing to keep the pipe moving, without triggering a reply yet
const MICRO_COMMIT_EVERY_MS = 400;              // ~0.4s
const MAX_BUNDLE_BYTES      = FRAME_BYTES * 30; // ~600ms

function ulawEnergy(buf) {
  // Quick μ-law "loudness" heuristic around 0x7F mid-point
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += Math.abs(buf[i] - 0x7f);
  return s / buf.length;
}

// ===== TwiML (no twilio SDK needed) =====
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

// ===== HTTP(S) server + WS upgrade =====
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

// ===== Bridge Twilio <-> OpenAI Realtime =====
wss.on("connection", async (twilioWS, req) => {
  console.log("✅ Twilio WebSocket connected from", req.headers["x-forwarded-for"] || req.socket.remoteAddress);
  if (!OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY not set — closing");
    try { twilioWS.close(); } catch {}
    return;
  }

  // Connect to OpenAI Realtime (WebSocket)
  const oai = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  let streamSid = null;
  let mulawChunks = [];
  let bytesBuffered = 0;
  let lastSpeechAt = Date.now();
  let turnStartedAt = Date.now();
  let lastCommitAt = Date.now();
  let mediaPackets = 0;
  let sentBytesToTwilio = 0;

  // ==== OpenAI socket lifecycle ====
  oai.on("open", () => {
    console.log("🔗 OpenAI Realtime connected");

    const instructions = DEV_MODE
      ? `You are Anna, JP’s digital personal assistant and a member of the build team.
Caller is ${DEV_CALLER_NAME}. Use the '${VOICE}' voice. Be concise.
Let the caller finish speaking; reply after a brief pause if they stop.`
      : `You are Anna, a helpful assistant. Be concise and wait for the caller to finish before replying.`;

    // IMPORTANT: use string forms for μ-law formats
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

    // No proactive greeting—wait for user's first turn
  });

  oai.on("error", (e) => console.error("🔻 OAI socket error:", e?.message || e));
  oai.on("close", (c, r) => console.log("🔚 OAI socket closed", c, r?.toString?.() || ""));

  // ---- OpenAI -> Twilio audio forwarder (supports current & older event names) ----
  oai.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!streamSid) return;

    // Modern: response.audio.delta (data in msg.delta)
    if (msg.type === "response.audio.delta" && msg.delta) {
      const chunkB64 = msg.delta; // base64 μ-law 8k
      try {
        twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload: chunkB64 } }));
        sentBytesToTwilio += Buffer.from(chunkB64, "base64").length;
        if (sentBytesToTwilio < 2000 || sentBytesToTwilio % 48000 === 0) {
          console.log(`📤 sent to Twilio: ${sentBytesToTwilio} bytes total`);
        }
      } catch (e) {
        console.error("❌ send audio to Twilio failed:", e?.message || e);
      }
    }

    // Legacy: response.output_audio.delta (data in msg.audio)
    if (msg.type === "response.output_audio.delta" && msg.audio) {
      const chunkB64 = msg.audio;
      try {
        twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload: chunkB64 } }));
        sentBytesToTwilio += Buffer.from(chunkB64, "base64").length;
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

  // ==== VAD/turn-taking: feed the model continuously, only speak at turn end ====
  const vadPoll = setInterval(() => {
    if (oai.readyState !== WebSocket.OPEN) return;

    const now = Date.now();
    const longSilence = now - lastSpeechAt >= SILENCE_MS;
    const hitMax = now - turnStartedAt >= MAX_TURN_MS;
    const have100ms = bytesBuffered >= MIN_COMMIT_BYTES && mulawChunks.length > 0;
    const dueMicro = now - lastCommitAt >= MICRO_COMMIT_EVERY_MS;

    if (!have100ms) return;

    // Slice to manageable size to keep latency predictable
    const payloadBuf = Buffer.concat(mulawChunks);
    const slice = payloadBuf.subarray(0, Math.min(payloadBuf.length, MAX_BUNDLE_BYTES));
    if (slice.length < MIN_COMMIT_BYTES) return;

    const b64 = slice.toString("base64");
    const ms = Math.round((slice.length / FRAME_BYTES) * FRAME_MS);

    try {
      // Always append+commit to keep the pipe flowing
      oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

      if (longSilence || hitMax) {
        // Only request a response when you likely finished your sentence
        oai.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio","text"] } }));
        console.log(`🔊 committed ~${ms}ms cause=${longSilence ? "silence" : "max"} (→ respond)`);
        turnStartedAt = now;
      } else if (dueMicro) {
        console.log(`🔊 committed ~${ms}ms cause=micro (no respond)`);
      }

      // Keep tail for next cycle
      const remaining = payloadBuf.subarray(slice.length);
      mulawChunks = remaining.length ? [remaining] : [];
      bytesBuffered = remaining.length;
      lastCommitAt = now;
    } catch (e) {
      console.error("❌ send to Realtime failed:", e?.message || e);
    }
  }, 50);

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
        mulawChunks = [];
        bytesBuffered = 0;
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

  function cleanup() {
    try { clearInterval(vadPoll); } catch {}
    try { if (oai.readyState === WebSocket.OPEN) oai.close(); } catch {}
    try { if (twilioWS.readyState === WebSocket.OPEN) twilioWS.close(); } catch {}
  }
});

// ===== Start server =====
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Realtime DPA listening on 0.0.0.0:${PORT}`);
});
server.on("clientError", (err, socket) => {
  console.error("💥 HTTP clientError:", err?.message || err);
  try { socket.destroy(); } catch {}
});
