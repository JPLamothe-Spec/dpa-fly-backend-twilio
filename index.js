// index.js — Twilio PSTN ↔ OpenAI Realtime (μ-law, 8kHz)
// Stability pass: safer commit protocol (no empty commits), trickle OFF by default,
// playback pacer kept for smoother TTS.

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

// μ-law @8k: 160B ≈ 20ms, 800B ≈ 100ms
const MIN_COMMIT_BYTES = Number(process.env.MIN_COMMIT_BYTES || 1200); // 150ms minimum per commit

// ---- VAD knobs (tunable via env)
const SPEECH_THRESH = Number(process.env.VAD_SPEECH_THRESH || 18);
const SILENCE_MS    = Number(process.env.VAD_SILENCE_MS || 550);
const MAX_TURN_MS   = Number(process.env.VAD_MAX_TURN_MS || 3200);

// Optional: noise-floor autocal (disabled by default)
const AUTOCAL_MS    = Number(process.env.VAD_AUTOCAL_MS || 0);
const NOISE_OFFSET  = Number(process.env.VAD_NOISE_OFFSET || 6);

// ---- ASR trickle — OFF by default (set >0 to enable)
const TRICKLE_MS         = Number(process.env.VAD_TRICKLE_MS || 0);   // e.g. 600 to enable trickle
const COMMIT_COOLDOWN_MS = Number(process.env.COMMIT_COOLDOWN_MS || 250);

// ---- Outbound pacing (audio to Twilio @ 20ms frames)
const PACE_MS = Number(process.env.TTS_PACE_MS || 20);
const PREBUFFER_FRAMES = Number(process.env.TTS_PREBUFFER_FRAMES || 2);
const MAX_BUFFER_FRAMES = Number(process.env.TTS_MAX_BUFFER_FRAMES || 10);

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
  res.type("text/xml").send(twiml(streamUrl));
});
app.get("/twilio/voice", (req, res) => {
  const streamUrl = (process.env.PUBLIC_WS_URL || "").trim() || `wss://${req.headers.host}/call`;
  console.log("➡️ /twilio/voice hit (GET)");
  res.type("text/xml").send(twiml(streamUrl));
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

  // ---- State
  let streamSid = null;
  let mulawChunks = [];
  let bytesBuffered = 0;
  let lastSpeechAt = Date.now();
  let turnStartedAt = Date.now();
  let mediaPackets = 0;

  let socketOpen = false;
  let sessionHealthy = false;
  let sessionError = false;
  let activeResponse = false;

  // commit coordination
  let lastCommitAt = 0;
  let commitInflight = false;
  let lastTrickleAt = 0;
  let lastAppendMs = 0;         // ms appended in the *most recent* append preceding a commit
  let commitEmptyBackoffUntil = 0;

  // transcripts
  let callerText = "";
  let assistantText = "";

  // VAD threshold (may autocal)
  let speechThresh = SPEECH_THRESH;
  const callStartAt = Date.now();

  const resetBuffer = () => { mulawChunks = []; bytesBuffered = 0; };
  const nowMs = () => Date.now();
  const bufferedMs = (bytes) => Math.round((bytes / 800) * 100); // μ-law @8k

  // ---- Outbound pacing
  function makePacer() {
    let frames = [];
    let ticking = null;
    let started = false;
    function startTick() {
      if (ticking || !twilioWS || twilioWS.readyState !== WebSocket.OPEN) return;
      ticking = setInterval(() => {
        if (!streamSid || !frames.length) return;
        const burst = frames.length > MAX_BUFFER_FRAMES ? 2 : 1;
        for (let i = 0; i < burst; i++) {
          const f = frames.shift(); if (!f) break;
          try {
            twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload: f.toString("base64") } }));
          } catch {}
        }
      }, PACE_MS);
    }
    function stopTick(){ if (ticking) { try { clearInterval(ticking); } catch{} ticking = null; } }
    function enqueueBase64(b64) {
      if (!b64) return;
      const buf = Buffer.from(b64, "base64");
      for (let i = 0; i + 160 <= buf.length; i += 160) frames.push(buf.subarray(i, i + 160));
      if (!started && frames.length >= PREBUFFER_FRAMES) { started = true; startTick(); } else { startTick(); }
      if (frames.length > MAX_BUFFER_FRAMES * 2) frames = frames.slice(-MAX_BUFFER_FRAMES * 2);
    }
    function markUtteranceDone(){ started = false; }
    function destroy(){ stopTick(); frames = []; }
    return { enqueueBase64, markUtteranceDone, destroy };
  }
  const pacer = makePacer();

  function canCommit() {
    if (!socketOpen || !sessionHealthy || sessionError) return false;
    if (commitInflight) return false;
    if (nowMs() - lastCommitAt < COMMIT_COOLDOWN_MS) return false;
    if (nowMs() < commitEmptyBackoffUntil) return false; // backoff after empty error
    return bytesBuffered >= MIN_COMMIT_BYTES && mulawChunks.length > 0;
  }

  function doAppendAndCommit({ respond, cause }) {
    // Snapshot current buffer
    const payloadBuf = Buffer.concat(mulawChunks);
    const ms = bufferedMs(payloadBuf.length);
    if (ms < 150) return false; // stricter guard
    const b64 = payloadBuf.toString("base64");

    // Mark inflight before sending to avoid re-entrancy
    commitInflight = true;
    lastCommitAt = nowMs();
    lastAppendMs = ms;

    try {
      oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

      if (respond && !activeResponse) {
        oai.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio","text"] } }));
        activeResponse = true;
        console.log(`🔊 committed ~${ms}ms cause=${cause} (→ respond)`);
      } else {
        console.log(`🔊 committed ~${ms}ms cause=${cause} (no respond)`);
      }
      // Clear local buffer only after we've sent both frames
      resetBuffer();
      turnStartedAt = nowMs();
      return true;
    } catch (e) {
      console.error("❌ send to Realtime failed:", e?.message || e);
      return false;
    } finally {
      commitInflight = false;
    }
  }

  function commitIfReady({ respond, cause }) {
    if (!canCommit()) return;
    // Only allow a commit if we will append >=150ms right now.
    doAppendAndCommit({ respond, cause });
  }

  function commitTrickle() {
    if (TRICKLE_MS <= 0) return; // disabled by default
    if (!canCommit()) return;
    if (nowMs() - lastTrickleAt < TRICKLE_MS) return;
    lastTrickleAt = nowMs();
    doAppendAndCommit({ respond: false, cause: "trickle" });
  }

  // ---- OpenAI socket
  oai.on("open", () => {
    socketOpen = true;
    console.log("🔗 OpenAI Realtime connected");

    const instructions = DEV_MODE
      ? `You are Anna, JP’s English-accented digital personal assistant AND a core member of the DPA build team.
Caller is ${DEV_CALLER_NAME}. Be concise. Avoid asking for phone numbers unless requested.

PROJECT BRIEF:
${PROJECT_BRIEF}`
      : `You are Anna, JP’s assistant on a live phone call. Be concise and helpful.`;

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

    try { oai.send(JSON.stringify(sessionUpdate)); }
    catch (e) { console.error("❌ session.update send failed:", e?.message || e); }

    setTimeout(() => {
      if (!sessionError) {
        try {
          oai.send(JSON.stringify({
            type: "response.create",
            response: { modalities: ["audio","text"], instructions: "Hi—how can I help?" }
          }));
          activeResponse = true;
        } catch (e) { console.error("❌ greeting send failed:", e?.message || e); }
      }
    }, 120);
  });

  oai.on("error", (e) => {
    const msg = e?.message || e;
    console.error("🔻 OAI socket error:", msg);
  });
  oai.on("close", (c, r) => console.log("🔚 OAI socket closed", c, r?.toString?.() || ""));

  // ---- OpenAI -> Twilio + Logs ----
  oai.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.type === "session.updated") {
      sessionHealthy = true;
      console.log(`✅ session.updated (ASR=${TRANSCRIBE_MODEL})`);
      return;
    }

    if (msg.type === "error") {
      console.error("🔻 OAI error:", msg);
      if (msg?.error?.code === "input_audio_buffer_commit_empty") {
        // brief backoff to avoid cascades; also clear local buffer
        commitEmptyBackoffUntil = nowMs() + 250;
        resetBuffer();
      }
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

    // Forward assistant audio to Twilio via pacer
    if (streamSid) {
      if (msg.type === "response.audio.delta" && msg.delta) {
        pacer.enqueueBase64(msg.delta);
        return;
      }
      if (msg.type === "response.output_audio.delta" && msg.audio) {
        pacer.enqueueBase64(msg.audio);
        return;
      }
      if (msg.type === "response.audio.done" || msg.type === "response.output_audio.done") {
        pacer.markUtteranceDone();
        try { twilioWS.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts-done" } })); } catch {}
        return;
      }
    }
  });

  // ---- VAD/turn-taking + optional trickle ----
  const tick = setInterval(() => {
    if (!socketOpen || !sessionHealthy || sessionError) return;

    const t = nowMs();
    const longSilence = t - lastSpeechAt >= SILENCE_MS;
    const hitMax = t - turnStartedAt >= MAX_TURN_MS;

    // (A) Real turn commit (respond if assistant is idle)
    if ((longSilence || hitMax)) {
      commitIfReady({ respond: !activeResponse, cause: hitMax ? "max" : "silence" });
      return;
    }

    // (B) Optional periodic ASR-only trickles
    commitTrickle();
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
        lastSpeechAt = nowMs();
        turnStartedAt = nowMs();
        lastCommitAt = 0;
        lastTrickleAt = 0;
        lastAppendMs = 0;
        commitEmptyBackoffUntil = 0;
        callerText = "";
        assistantText = "";
        break;

      case "media": {
        const b64 = data?.media?.payload; if (!b64) break;
        const mulaw = Buffer.from(b64, "base64");  // μ-law 8k
        mediaPackets += 1;
        if (mediaPackets <= 5 || mediaPackets % 50 === 0) console.log(`🟢 media pkt #${mediaPackets} (+${mulaw.length} bytes)`);
        const e = ulawEnergy(mulaw);

        // Optional: autocalibrate noise floor during first AUTOCAL_MS
        if (AUTOCAL_MS > 0 && nowMs() - callStartAt < AUTOCAL_MS) {
          speechThresh = Math.max(speechThresh, Math.round(e + NOISE_OFFSET));
        }

        if (e > speechThresh) lastSpeechAt = nowMs();
        mulawChunks.push(mulaw);
        bytesBuffered += mulaw.length;
        break;
      }

      case "mark":
        break;

      case "stop":
        console.log("🛑 Twilio STOP event");
        // Final ASR-only commit only if we actually have ≥150ms staged
        if (bytesBuffered >= 1200 && mulawChunks.length > 0) {
          doAppendAndCommit({ respond: false, cause: "stop" });
        } else {
          resetBuffer();
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
    try { clearInterval(tick); } catch {}
    try { pacer.destroy(); } catch {}
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
