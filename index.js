// index.js — Twilio PSTN ↔ OpenAI Realtime (μ-law)
// Stable: ASR trickle (safer), faster pause commits, full transcripts.
// Fixes: stricter commit gating, no trickle during TTS, cooldown after empty-commit errors.

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
const MIN_COMMIT_BYTES = Number(process.env.MIN_COMMIT_BYTES || 800);

// ---- VAD knobs (tunable via env)
const SPEECH_THRESH = Number(process.env.VAD_SPEECH_THRESH || 18);
const SILENCE_MS    = Number(process.env.VAD_SILENCE_MS || 550);
const MAX_TURN_MS   = Number(process.env.VAD_MAX_TURN_MS || 3200);

// ---- ASR “trickle” (safer cadence)
// Only trickle when we have ≥~150ms new audio & TTS not active.
const TRICKLE_MS         = Number(process.env.VAD_TRICKLE_MS || 800);
const COMMIT_COOLDOWN_MS = Number(process.env.COMMIT_COOLDOWN_MS || 300);

// Empty-commit cooloff (prevents rapid-fire zero buffers)
const EMPTY_COMMIT_BACKOFF_MS = Number(process.env.EMPTY_COMMIT_BACKOFF_MS || 300);

const PROJECT_BRIEF = process.env.PROJECT_BRIEF || `Digital Personal Assistant (DPA)
- Goal: natural, low-latency phone assistant for JP.
- Priorities: realtime voice, AU/UK female voice, no unsolicited number capture, low latency, smooth barge-in.
- Dev mode: treat caller as JP (teammate). Be concise, flag latency/transcription issues, suggest next tests.`;

// quick μ-law energy proxy
function ulawEnergy(buf){ let s=0; for (let i=0;i<buf.length;i++) s+=Math.abs(buf[i]-0x7f); return s/buf.length; }

// TwiML generator (keeps your prior shape)
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
  let uncommittedBytes = 0; // NEW: track since last commit

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
  let lastNonEmptyCommitAt = 0; // NEW: for timing check
  let lastTrickleAt = 0;
  let commitInflight = false;
  let commitGuardUntil = 0;     // NEW: short guard window
  let emptyCommitCooldownUntil = 0; // NEW: backoff after empty-commit error

  // Transcript accumulators
  let callerText = "";
  let assistantText = "";

  const resetBuffer = () => { mulawChunks = []; bytesBuffered = 0; uncommittedBytes = 0; };
  const nowMs = () => Date.now();
  const bufferedMs = (bytes) => Math.round((bytes / 800) * 100); // μ-law @8k

  function canCommit() {
    if (!socketOpen || !sessionHealthy || sessionError) return false;
    if (commitInflight) return false;
    if (nowMs() < commitGuardUntil) return false;
    if (nowMs() - lastCommitAt < COMMIT_COOLDOWN_MS) return false;
    if (nowMs() < emptyCommitCooldownUntil) return false;
    return bytesBuffered >= MIN_COMMIT_BYTES && mulawChunks.length > 0;
  }

  function doCommit({ respond, cause }) {
    // Hard prechecks
    if (!canCommit()) return false;

    const payloadBuf = Buffer.concat(mulawChunks);
    const ms = bufferedMs(payloadBuf.length);

    // Extra safety: size + elapsed since last non-empty commit
    const elapsedSinceLast = nowMs() - lastNonEmptyCommitAt;
    if (ms < 100) return false;              // API minimum ~100ms
    if (elapsedSinceLast < 120) return false; // avoid back-to-back

    // Lock & guard
    commitInflight = true;
    commitGuardUntil = nowMs() + 60; // small guard to avoid same-tick reentry
    lastCommitAt = nowMs();

    try {
      const b64 = payloadBuf.toString("base64");
      oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

      if (respond && !activeResponse) {
        oai.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio","text"] } }));
        activeResponse = true; // optimistic until response.created
        console.log(`🔊 committed ~${ms}ms cause=${cause} (→ respond)`);
      } else {
        console.log(`🔊 committed ~${ms}ms cause=${cause} (no respond)`);
      }

      // On a turn commit, flush caller turn summary line
      if (respond && callerText.trim()) {
        console.log("👂 YOU (turn):", callerText.trim());
        callerText = "";
      }

      lastNonEmptyCommitAt = nowMs();
      // After commit, the data we had is now "committed"
      uncommittedBytes = 0;
      return true;
    } catch (e) {
      console.error("❌ send to Realtime failed:", e?.message || e);
      return false;
    } finally {
      commitInflight = false;
      // Don't immediately nuke the buffer before server ingests — but our pattern
      // has worked fine to reset here because we only append new frames after this tick.
      mulawChunks = [];
      bytesBuffered = 0;
      turnStartedAt = nowMs();
    }
  }

  function commitTrickle() {
    // No trickling while assistant is speaking (prevents races)
    if (activeResponse) return;

    // Require meaningful NEW audio since last commit: ~150ms (>=1200 bytes)
    if (uncommittedBytes < 1200) return;

    // Cadence guard
    if (nowMs() - lastTrickleAt < TRICKLE_MS) return;

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
          activeResponse = true; // optimistic until response.created arrives
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
      const code = msg?.error?.code || "";
      const p = msg?.error?.param || "";
      if (String(p).startsWith("session.") || ["invalid_value","missing_required_parameter"].includes(code)) {
        sessionError = true;
      }
      // Backoff when we hit empty-commit so buffer can actually build
      if (code === "input_audio_buffer_commit_empty") {
        emptyCommitCooldownUntil = nowMs() + EMPTY_COMMIT_BACKOFF_MS;
      }
      return;
    }

    // Response lifecycle (prevents duplicate response.create)
    if (msg.type === "response.created") { activeResponse = true; return; }
    if (msg.type === "response.completed" || msg.type === "response.output_audio.done" || msg.type === "response.refusal.delta") {
      activeResponse = false;
      // Flush assistant turn summary line
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

    // Caller transcripts (arrive after each commit)
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

    // Forward assistant audio to Twilio (μ-law already, thanks to output_audio_format)
    if (streamSid) {
      if (msg.type === "response.audio.delta" && msg.delta) {
        try {
          twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } }));
        } catch (e) { console.error("❌ send audio to Twilio failed:", e?.message || e); }
        return;
      }
      if (msg.type === "response.output_audio.delta" && msg.audio) {
        try {
          twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.audio } }));
        } catch (e) { console.error("❌ send audio to Twilio failed:", e?.message || e); }
        return;
      }
      if (msg.type === "response.audio.done" || msg.type === "response.output_audio.done") {
        try { twilioWS.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts-done" } })); } catch {}
        return;
      }
    }
  });

  // ---- VAD/turn-taking + ASR trickle ----
  const vadPoll = setInterval(() => {
    if (!socketOpen || !sessionHealthy || sessionError) return;

    const t = nowMs();
    const longSilence = t - lastSpeechAt >= SILENCE_MS;
    const hitMax = t - turnStartedAt >= MAX_TURN_MS;

    // (A) Short pause or max-turn → real turn commit (ask to respond if free)
    if ((longSilence || hitMax) && bytesBuffered >= MIN_COMMIT_BYTES) {
      doCommit({ respond: !activeResponse, cause: hitMax ? "max" : "silence" });
      return;
    }

    // (B) While caller is talking → periodic ASR-only trickles so you see 👂 deltas
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
        resetBuffer();
        mediaPackets = 0;
        lastSpeechAt = nowMs();
        turnStartedAt = nowMs();
        lastCommitAt = 0;
        lastNonEmptyCommitAt = 0;
        lastTrickleAt = 0;
        emptyCommitCooldownUntil = 0;
        callerText = "";
        assistantText = "";
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
        uncommittedBytes += mulaw.length; // NEW: track for trickle threshold
        break;
      }

      case "mark":
        break;

      case "stop":
        console.log("🛑 Twilio STOP event");
        // Final ASR-only commit to flush any tail audio, but don't request reply
        doCommit({ respond: false, cause: "stop" });
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
