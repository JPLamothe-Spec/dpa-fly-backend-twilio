// index.js — Twilio PSTN ↔ OpenAI Realtime (μ-law)
// Incremental fixes: (1) no-empty-commit guard, (2) assistant audio 20ms framing,
// (3) smarter trickle (no trickle while assistant speaks), (4) restore 3.2s max-turn.

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

// ---- VAD knobs (tunable via env) — restored snappy timings from your good baseline
const SPEECH_THRESH = Number(process.env.VAD_SPEECH_THRESH || 18);
const SILENCE_MS    = Number(process.env.VAD_SILENCE_MS || 550);
const MAX_TURN_MS   = Number(process.env.VAD_MAX_TURN_MS || 3200);

// ---- ASR “trickle” (always on… but now only when caller is active & assistant is quiet)
const TRICKLE_MS         = Number(process.env.VAD_TRICKLE_MS || 600);
const COMMIT_COOLDOWN_MS = Number(process.env.COMMIT_COOLDOWN_MS || 300);

const PROJECT_BRIEF = process.env.PROJECT_BRIEF || `Digital Personal Assistant (DPA)
- Goal: natural, low-latency phone assistant for JP.
- Priorities: realtime voice, AU/UK female voice, no unsolicited number capture, low latency, smooth barge-in.
- Dev mode: treat caller as JP (teammate). Be concise, flag latency/transcription issues, suggest next tests.`;

// quick μ-law energy proxy
function ulawEnergy(buf){ let s=0; for (let i=0;i<buf.length;i++) s+=Math.abs(buf[i]-0x7f); return s/buf.length; }

// 20ms μ-law framing helpers for Twilio (160 bytes per frame @ 8 kHz)
const ULawFrameBytes = 160;
function splitIntoULawFrames(b64) {
  const raw = Buffer.from(b64, "base64");
  const frames = [];
  for (let o=0; o + ULawFrameBytes <= raw.length; o += ULawFrameBytes) {
    frames.push(raw.subarray(o, o + ULawFrameBytes));
  }
  // drop remainder < 20ms to avoid pops; next delta will fill it
  return frames.map(f => f.toString("base64"));
}

// TwiML generator (unchanged)
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
  let appendedSinceLastCommit = false; // NEW: guarantees no empty commits

  // Transcript accumulators
  let callerText = "";
  let assistantText = "";

  const resetBuffer = () => { mulawChunks = []; bytesBuffered = 0; appendedSinceLastCommit = false; };
  const nowMs = () => Date.now();
  const bufferedMs = (bytes) => Math.round((bytes / 800) * 100); // μ-law @8k

  function canCommit() {
    if (!socketOpen || !sessionHealthy || sessionError) return false;
    if (commitInflight) return false;
    if (nowMs() - lastCommitAt < COMMIT_COOLDOWN_MS) return false;
    if (!appendedSinceLastCommit) return false; // NEW: do not commit if no append since last commit
    if (bytesBuffered < MIN_COMMIT_BYTES || mulawChunks.length === 0) return false;
    return true;
  }

  function doCommit({ respond, cause }) {
    if (!canCommit()) return;

    const payloadBuf = Buffer.concat(mulawChunks);
    const ms = bufferedMs(payloadBuf.length);
    if (ms < 100) return; // hard stop: API minimum to avoid commit_empty

    const b64 = payloadBuf.toString("base64");
    commitInflight = true;
    lastCommitAt = nowMs();

    try {
      // Always append before commit
      if (oai.readyState === WebSocket.OPEN) {
        oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
        appendedSinceLastCommit = false; // will be true again when we buffer new packets
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
      }
    } catch (e) {
      console.error("❌ send to Realtime failed:", e?.message || e);
    } finally {
      commitInflight = false;
      resetBuffer();
      turnStartedAt = nowMs();
    }
  }

  function commitTrickle() {
    // Only trickle while caller is active AND assistant is not speaking
    const callerActive = (nowMs() - lastSpeechAt) < 800; // recent energy
    if (!callerActive) return;
    if (activeResponse) return; // don't trickle over assistant speech
    if (!canCommit()) return;
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
      const p = msg?.error?.param || "";
      if (String(p).startsWith("session.") || ["invalid_value","missing_required_parameter"].includes(msg?.error?.code)) {
        sessionError = true;
      }
      return;
    }

    // Response lifecycle (prevents duplicate response.create)
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

    // Forward assistant audio to Twilio — NOW FRAMED IN 20ms CHUNKS
    if (streamSid) {
      // Newer event name (`response.output_audio.delta`) is preferred; keep both for safety
      if ((msg.type === "response.output_audio.delta" && msg.audio) ||
          (msg.type === "response.audio.delta" && msg.delta)) {
        const b64 = msg.audio || msg.delta;
        try {
          const frames = splitIntoULawFrames(b64);
          for (const payload of frames) {
            twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
          }
          // (Optional) mark end of burst so Twilio player flushes quickly
          if (frames.length) {
            twilioWS.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts-chunk" } }));
          }
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
    if ((longSilence || hitMax) && bytesBuffered >= MIN_COMMIT_BYTES && !activeResponse) {
      doCommit({ respond: true, cause: hitMax ? "max" : "silence" });
      return;
    }
    if ((longSilence || hitMax) && bytesBuffered >= MIN_COMMIT_BYTES && activeResponse) {
      // If assistant is already talking, still flush caller audio (no respond)
      doCommit({ respond: false, cause: hitMax ? "max" : "silence" });
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
        lastTrickleAt = 0;
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
        appendedSinceLastCommit = true; // NEW: we have data to commit
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
