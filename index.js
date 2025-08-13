// index.js — Twilio PSTN ↔ OpenAI Realtime (μ-law)
// Baseline with ASR trickle, snappy VAD, full transcripts.
// FIX: Forward BOTH response.audio.delta and response.output_audio.delta to Twilio (deduped).

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
require("dotenv").config();

// ---- Env & defaults
const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const VOICE = (process.env.VOICE || "coral").toLowerCase();

// ASR must be one of: whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe
const TRANSCRIBE_MODEL_RAW = (process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe").trim();
const ALLOWED_ASR = new Set(["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"]);
const TRANSCRIBE_MODEL = ALLOWED_ASR.has(TRANSCRIBE_MODEL_RAW) ? TRANSCRIBE_MODEL_RAW : "gpt-4o-mini-transcribe";

const DEV_MODE = String(process.env.ANNA_DEV_MODE || "true").toLowerCase() === "true";
const DEV_CALLER_NAME = process.env.DEV_CALLER_NAME || "JP";

// μ-law @8k: 160B ≈ 20ms, 800B ≈ 100ms (API minimum)
// Use ~120ms to be safe.
const MIN_COMMIT_BYTES = Number(process.env.MIN_COMMIT_BYTES || 960);

// ---- VAD knobs
const SPEECH_THRESH = Number(process.env.VAD_SPEECH_THRESH || 18);
const SILENCE_MS    = Number(process.env.VAD_SILENCE_MS || 550);
const MAX_TURN_MS   = Number(process.env.VAD_MAX_TURN_MS || 3200);

// ---- ASR “trickle”
const TRICKLE_MS         = Number(process.env.VAD_TRICKLE_MS || 600);
const COMMIT_COOLDOWN_MS = Number(process.env.COMMIT_COOLDOWN_MS || 300);

const PROJECT_BRIEF = process.env.PROJECT_BRIEF || `Digital Personal Assistant (DPA)
- Goal: natural, low-latency phone assistant for JP.
- Priorities: realtime voice, AU/UK female voice, no unsolicited number capture, low latency, smooth barge-in.
- Dev mode: treat caller as JP (teammate). Be concise, flag latency/transcription issues, suggest next tests.`;

// quick μ-law energy proxy
function ulawEnergy(buf){ let s=0; for (let i=0;i<buf.length;i++) s+=Math.abs(buf[i]-0x7f); return s/buf.length; }

// TwiML generator
function twiml(wsUrl) {
  return `
<Response>
  <Connect>
    <Stream url="${wsUrl}" track="inbound_track"/>
  </Connect>
  <Pause length="30"/>
</Response>`.trim();
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- Twilio webhook ---
app.post("/twilio/voice", (req, res) => {
  const streamUrl = (process.env.PUBLIC_WS_URL || "").trim() || `wss://${req.headers.host}/call`;
  console.log("➡️ /twilio/voice hit (POST)");
  const xml = twiml(streamUrl);
  console.log("🧾 TwiML returned:", xml);
  res.type("text/xml").send(xml);
});
app.get("/twilio/voice", (req, res) => {
  const streamUrl = (process.env.PUBLIC_WS_URL || "").trim() || `wss://${req.headers.host}/call`;
  console.log("➡️ /twilio/voice hit (GET)");
  const xml = twiml(streamUrl);
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
  if (req.url === "/call") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    console.log("🚫 Upgrade path not /call — closing");
    try { socket.destroy(); } catch {}
  }
});

// --- Bridge Twilio <-> OpenAI Realtime ---
wss.on("connection", async (twilioWS, req) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log("✅ Twilio WebSocket connected from", ip);

  if (!OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY not set — closing");
    try { twilioWS.close(); } catch {}
    return;
  }

  const oai = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
        "openai-beta": "realtime=v1",
      }
    }
  );

  let streamSid = null;
  let mulawChunks = [];
  let bytesBuffered = 0;
  let bytesSinceLastCommit = 0;
  let lastSpeechAt = Date.now();
  let turnStartedAt = Date.now();
  let mediaPackets = 0;

  // Session health & response gating
  let socketOpen = false;
  let sessionHealthy = false;
  let sessionError = false;
  let activeResponse = false;

  // Commit guards
  let lastCommitAt = 0;
  let commitInflight = false;
  let lastTrickleAt = 0;

  // Transcript accumulators
  let callerText = "";
  let assistantText = "";

  // Audio dedupe guard (avoid double-playing if both channels arrive)
  let lastAudioHash = "";

  const resetBuffer = () => { mulawChunks = []; bytesBuffered = 0; };
  const resetSinceCommit = () => { bytesSinceLastCommit = 0; };
  const nowMs = () => Date.now();
  const bufferedMs = (bytes) => Math.round((bytes / 800) * 100); // μ-law @8k (800B ≈ 100ms)

  function canCommit() {
    if (!socketOpen || !sessionHealthy || sessionError) return false;
    if (commitInflight) return false;
    if (nowMs() - lastCommitAt < COMMIT_COOLDOWN_MS) return false;
    return (bytesBuffered >= MIN_COMMIT_BYTES) &&
           (bytesSinceLastCommit >= MIN_COMMIT_BYTES) &&
           (mulawChunks.length > 0);
  }

  function doCommit({ respond, cause }) {
    if (!canCommit()) return;

    const payloadBuf = Buffer.concat(mulawChunks);
    const ms = bufferedMs(payloadBuf.length);
    if (ms < 120) return; // extra safety

    const b64 = payloadBuf.toString("base64");
    commitInflight = true;
    lastCommitAt = nowMs();

    try {
      oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

      if (respond && !activeResponse) {
        oai.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio","text"] } }));
        activeResponse = true; // optimistic until response.created
        console.log(`🔊 committed ~${ms}ms cause=${cause} (→ respond)`);
      } else {
        console.log(`🔊 committed ~${ms}ms cause=${cause} (no respond)`);
      }

      if (respond && callerText.trim()) {
        console.log("👂 YOU (turn):", callerText.trim());
        callerText = "";
      }
    } catch (e) {
      console.error("❌ send to Realtime failed:", e?.message || e);
    } finally {
      commitInflight = false;
      resetBuffer();
      resetSinceCommit();
      turnStartedAt = nowMs();
    }
  }

  function commitTrickle() {
    if (nowMs() - lastTrickleAt < TRICKLE_MS) return;
    if (!canCommit()) return;
    lastTrickleAt = nowMs();
    doCommit({ respond: false, cause: "trickle" });
  }

  oai.on("open", () => {
    socketOpen = true;
    console.log("🔗 OpenAI Realtime connected");

    const instructions = DEV_MODE
      ? `You are Anna, JP’s English-accented digital personal assistant AND a core member of the DPA build team.
Caller is ${DEV_CALLER_NAME}. Be concise. Avoid asking for phone numbers unless requested.

PROJECT BRIEF:
${PROJECT_BRIEF}`
      : `You are Anna, JP’s assistant on a live phone call. Be concise and helpful.`;

    // Configure session: μ-law in/out + ASR model
    const sessionUpdate = {
      type: "session.update",
      session: {
        input_audio_format:  "g711_ulaw",
        output_audio_format: "g711_ulaw",
        modalities: ["audio","text"],
        voice: VOICE,
        instructions,
        input_audio_transcription: { model: TRANSCRIBE_MODEL }
      }
    };

    try {
      oai.send(JSON.stringify(sessionUpdate));
    } catch (e) {
      console.error("❌ session.update send failed:", e?.message || e);
    }

    // Single greeting once session is valid
    setTimeout(() => {
      if (!sessionError) {
        try {
          oai.send(JSON.stringify({
            type: "response.create",
            response: { modalities: ["audio","text"], instructions: "Hi—how can I help?" }
          }));
          activeResponse = true;
        } catch (e) {
          console.error("❌ greeting send failed:", e?.message || e);
        }
      }
    }, 120);
  });

  oai.on("error", (e) => console.error("🔻 OAI socket error:", e?.message || e));
  oai.on("close", (c, r) => console.log("🔚 OAI socket closed", c, r?.toString?.() || ""));

  // ---- OpenAI -> Twilio + Logs ----
  oai.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    // Session health
    if (msg.type === "session.updated") {
      sessionHealthy = true;
      console.log(`✅ session.updated (ASR=${TRANSCRIBE_MODEL})`);
      return;
    }

    if (msg.type === "error") {
      console.error("🔻 OAI error:", msg);
      const p = msg?.error?.param || "";
      if (String(p).startsWith("session.") || ["invalid_value","missing_required_parameter"].includes(msg?.error?.code)) {
        sessionError = true;
      }
      return;
    }

    // Response lifecycle
    if (msg.type === "response.created") { activeResponse = true; return; }
    if (msg.type === "response.completed" || msg.type === "response.output_audio.done" || msg.type === "response.refusal.delta") {
      activeResponse = false;
      if (assistantText.trim()) console.log("🗣️ ANNA (turn):", assistantText.trim());
      assistantText = "";
      return;
    }

    // Assistant transcript (delta/streaming)
    if (msg.type === "response.audio_transcript.delta" && msg.delta) {
      assistantText += String(msg.delta);
      console.log("🗣️ ANNA SAID:", String(msg.delta));
      return;
    }

    // Caller transcripts
    if (msg.type === "response.input_audio_transcription.delta" && msg.delta) {
      callerText += String(msg.delta);
      console.log("👂 YOU SAID:", String(msg.delta));
      return;
    }
    if (msg.type === "response.input_text.delta" && msg.delta) {
      callerText += String(msg.delta);
      console.log("👂 YOU SAID (text):", String(msg.delta));
      return;
    }

    // ---- Forward assistant audio to Twilio (μ-law base64) ----
    // Dedupe identical chunks if both channels happen to fire.
    function sendAudio(b64) {
      if (!b64 || !streamSid) return;
      if (b64 === lastAudioHash) return;
      lastAudioHash = b64;
      try {
        twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
      } catch (e) {
        console.error("❌ send audio to Twilio failed:", e?.message || e);
      }
    }

    if (msg.type === "response.output_audio.delta" && msg.audio) {
      sendAudio(msg.audio);
      return;
    }
    if (msg.type === "response.audio.delta" && msg.delta) {
      // Some sessions/models emit this legacy channel
      sendAudio(msg.delta);
      return;
    }
    if (msg.type === "response.output_audio.done" || msg.type === "response.audio.done") {
      try { if (streamSid) twilioWS.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts-done" } })); } catch {}
      return;
    }
  });

  // ---- VAD/turn-taking + ASR trickle ----
  const vadPoll = setInterval(() => {
    if (!socketOpen || !sessionHealthy || sessionError) return;

    const t = nowMs();
    const longSilence = t - lastSpeechAt >= SILENCE_MS;
    const hitMax = t - turnStartedAt >= MAX_TURN_MS;

    if ((longSilence || hitMax) && bytesBuffered >= MIN_COMMIT_BYTES) {
      doCommit({ respond: !activeResponse, cause: hitMax ? "max" : "silence" });
      return;
    }

    if (bytesBuffered >= MIN_COMMIT_BYTES) {
      commitTrickle();
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
        bytesSinceLastCommit = 0;
        mediaPackets = 0;
        lastSpeechAt = nowMs();
        turnStartedAt = nowMs();
        lastCommitAt = 0;
        lastTrickleAt = 0;
        callerText = "";
        assistantText = "";
        lastAudioHash = "";
        break;

      case "media": {
        const b64 = data?.media?.payload; if (!b64) break;
        const mulaw = Buffer.from(b64, "base64");  // μ-law 8k
        mediaPackets += 1;
        if (mediaPackets <= 5 || mediaPackets % 50 === 0) console.log(`🟢 media pkt #${mediaPackets} (+${mulaw.length} bytes)`);
        const e = ulawEnergy(mulaw);
        if (e > SPEECH_THRESH) lastSpeechAt = nowMs();
        mulawChunks.push(mulaw);
        bytesBuffered += mulaw.length;
        bytesSinceLastCommit += mulaw.length;
        break;
      }

      case "mark":
        break;

      case "stop":
        console.log("🛑 Twilio STOP event");
        if (bytesSinceLastCommit >= MIN_COMMIT_BYTES) {
          doCommit({ respond: false, cause: "stop" });
        }
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
