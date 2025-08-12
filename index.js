// index.js — Twilio PSTN ↔ OpenAI Realtime (μ-law) with corrected transcripts + safer VAD
// - Correctly distinguishes USER vs ASSISTANT transcripts
// - Debounces commits to avoid input_audio_buffer_commit_empty
// - Lets caller finish sentences (SILENCE_MS default 1200ms), trims overall latency
// - Sends μ-law audio to Twilio via response.audio.delta → msg.delta (new) and legacy shape

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
const VOICE = (process.env.VOICE || "coral").toLowerCase();
const DEV_MODE = String(process.env.ANNA_DEV_MODE || "true").toLowerCase() === "true";
const DEV_CALLER_NAME = process.env.DEV_CALLER_NAME || "JP";

// μ-law @ 8kHz ⇒ 800 bytes ≈ 100ms
const MIN_COMMIT_BYTES = Number(process.env.MIN_COMMIT_BYTES || 800);
const SPEECH_THRESH = Number(process.env.VAD_SPEECH_THRESH || 22);
const SILENCE_MS    = Number(process.env.VAD_SILENCE_MS || 1200);
const MAX_TURN_MS   = Number(process.env.VAD_MAX_TURN_MS || 6000);
const COMMIT_DEBOUNCE_MS = 150; // don't re-commit instantly

const PROJECT_BRIEF = process.env.PROJECT_BRIEF || `Digital Personal Assistant (DPA) Project
- Goal: natural, low-latency phone assistant for JP.
- Priorities: realtime voice, UK/AU female voice, no unsolicited number capture, low latency, smooth barge-in.
- Dev mode: treat caller as JP (teammate). Be concise, flag issues (latency, transcription, overlap), suggest next tests.
- Behaviours: avoid asking for phone numbers unless explicitly requested. Keep replies short unless asked to elaborate.`;

// quick energy estimate for 8k μ-law
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
  let mulawChunks = [];
  let bytesBuffered = 0;
  let lastSpeechAt = Date.now();
  let turnStartedAt = Date.now();
  let mediaPackets = 0;
  let sentBytesToTwilio = 0;

  let oaiReady = false;
  let lastCommitAt = 0;

  function bufferedMs(bytes){ return Math.round((bytes / 800) * 100); } // μ-law @ 8k
  function resetBuffer(){ mulawChunks = []; bytesBuffered = 0; }

  function commitIfReady(cause, respond) {
    const now = Date.now();
    if (now - lastCommitAt < COMMIT_DEBOUNCE_MS) return; // debounce

    const haveAudio = bytesBuffered >= MIN_COMMIT_BYTES && mulawChunks.length > 0;
    if (!oaiReady || !haveAudio) return;

    const payloadBuf = Buffer.concat(mulawChunks);
    const ms = bufferedMs(payloadBuf.length);

    // extra guard: require >=100ms to satisfy API
    if (ms < 100) {
      console.log(`🔊 committed ~${ms}ms cause=${cause} (skipped; <100ms)`);
      resetBuffer();
      lastCommitAt = now;
      return;
    }

    const b64 = payloadBuf.toString("base64");
    try {
      oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      if (respond) {
        oai.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio","text"] } }));
        console.log(`🔊 committed ~${ms}ms cause=${cause} (→ respond)`);
      } else {
        console.log(`🔊 committed ~${ms}ms cause=${cause} (no respond)`);
      }
    } catch (e) {
      console.error("❌ send to Realtime failed:", e?.message || e);
    } finally {
      resetBuffer();
      turnStartedAt = now;
      lastCommitAt = now;
    }
  }

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
    oaiReady = true; // good enough; session.update is synchronous to our socket
  });
  oai.on("error", (e) => console.error("🔻 OAI socket error:", e?.message || e));
  oai.on("close", (c, r) => console.log("🔚 OAI socket closed", c, r?.toString?.() || ""));

  // ---- OpenAI -> Twilio + Logs ----
  oai.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.type?.startsWith("response.")) {
      // console.log("🧠 OAI:", msg.type); // noisy; uncomment if needed
    }

    if (msg.type === "response.audio_transcript.delta" && msg.delta) {
      // This is the ASSISTANT's transcript (what Anna is saying)
      console.log("🗣️ ANNA SAID:", String(msg.delta));
    }

    // Realtime can surface input audio transcription like this:
    if (msg.type === "response.input_audio_transcription.delta" && msg.delta) {
      console.log("👂 YOU SAID:", String(msg.delta));
    }
    if (msg.type === "response.input_text.delta" && msg.delta) {
      console.log("👂 YOU SAID (text):", String(msg.delta));
    }

    if (msg.type === "response.output_text.delta" && msg.delta) {
      // Assistant’s text as it’s generated
      // console.log("📝 ANNA TEXT:", String(msg.delta));
    }

    if (streamSid) {
      // A) Modern: response.audio.delta -> msg.delta
      if (msg.type === "response.audio.delta" && msg.delta) {
        const chunkB64 = msg.delta;
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
      // B) Legacy: response.output_audio.delta -> msg.audio
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
    }

    if (msg.type === "error") console.error("🔻 OAI error:", msg);
  });

  // ---- VAD/turn-taking: commit caller audio when it’s ready ----
  const vadPoll = setInterval(() => {
    const now = Date.now();
    const longSilence = now - lastSpeechAt >= SILENCE_MS;
    const hitMax = now - turnStartedAt >= MAX_TURN_MS;
    const haveAudio = bytesBuffered >= MIN_COMMIT_BYTES && mulawChunks.length > 0;

    if ((longSilence || hitMax) && haveAudio) {
      // If we reached max turn time, we definitely want a response.
      // If we reached silence, we also want a response (caller finished).
      const cause = hitMax ? "max" : "silence";
      commitIfReady(cause, /*respond*/ true);
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
        resetBuffer();
        mediaPackets = 0;
        sentBytesToTwilio = 0;
        lastSpeechAt = Date.now();
        turnStartedAt = Date.now();

        // Single concise greeting
        try {
          oai.send(JSON.stringify({
            type: "response.create",
            response: { modalities: ["audio","text"], instructions: "Hi—how can I help?" }
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
