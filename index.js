// index.js — Twilio PSTN ↔ OpenAI Realtime (μ-law)
// Features:
// • Env-driven persona (name/role/tone/style/greeting)
// • Private live transcription via SSE at /live and viewer at /transcript (token + dev-mode)
// • ASR trickle, VAD-based turn-taking, low-latency tweaks
// • Caller transcript fixes for non-prefixed and completed events

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

// Persona from env
const DPA_NAME = process.env.DPA_NAME || "Anna";
const DPA_ROLE = process.env.DPA_ROLE || "your assistant";
const DPA_TONE = process.env.DPA_TONE || "friendly and helpful";
const DPA_STYLE = process.env.DPA_STYLE || "keeps responses short and clear";
const DPA_GREETING = process.env.DPA_GREETING || "Hi—how can I help?";

const PROJECT_BRIEF = process.env.PROJECT_BRIEF || `Digital Personal Assistant (DPA)
- Goal: natural, low-latency phone assistant for JP.
- Priorities: realtime voice, AU/UK female voice, no unsolicited number capture, low latency, smooth barge-in.
- Dev mode: treat caller as JP (teammate). Be concise, flag latency/transcription issues, suggest next tests.`;

// μ-law @8k: 160B ≈ 20ms, 800B ≈ 100ms (API minimum)
const MIN_COMMIT_BYTES = Number(process.env.MIN_COMMIT_BYTES || 800);

// ---- VAD knobs (tunable via env)
const SPEECH_THRESH = Number(process.env.VAD_SPEECH_THRESH || 18);   // raise to ignore room noise
const SILENCE_MS    = Number(process.env.VAD_SILENCE_MS || 500);     // quicker pause detection (550→500)
const MAX_TURN_MS   = Number(process.env.VAD_MAX_TURN_MS || 3200);   // slightly snappier max turn

// ---- ASR “trickle” (always on) so 👂 YOU SAID appears during speech
const TRICKLE_MS         = Number(process.env.VAD_TRICKLE_MS || 600);
const COMMIT_COOLDOWN_MS = Number(process.env.COMMIT_COOLDOWN_MS || 300);

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

// ------------------------ PRIVATE TRANSCRIPT GATE -------------------------
const TRANSCRIPT_TOKEN = (process.env.TRANSCRIPT_TOKEN || "").trim();

/** Require dev-mode + token; returns true if allowed, else sends 401/403 and returns false */
function requireDevAuth(req, res) {
  if (!DEV_MODE) {
    res.status(403).send("Transcripts disabled: ANNA_DEV_MODE is not true.");
    return false;
  }
  if (!TRANSCRIPT_TOKEN) {
    res.status(403).send("Transcripts disabled: missing TRANSCRIPT_TOKEN on server.");
    return false;
  }
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const token = req.query.token || req.get("x-dev-token") || bearer || "";
  if (token !== TRANSCRIPT_TOKEN) {
    res.status(401).send("Unauthorized");
    return false;
  }
  return true;
}
// -------------------------------------------------------------------------

/* -------------------------- SSE broadcaster (private) -------------------- */
const sseClients = new Set();
function sseBroadcast(event, payload) {
  const line = `event: ${event}\ndata: ${JSON.stringify({ ts: Date.now(), ...payload })}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch {}
  }
}
app.get("/live", (req, res) => {
  if (!requireDevAuth(req, res)) return;
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Pragma": "no-cache",
    Connection: "keep-alive",
  });
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.flushHeaders?.();
  res.write(": connected\n\n");
  sseClients.add(res);
  req.on("close", () => { sseClients.delete(res); try { res.end(); } catch {} });
});
app.get("/transcript", (req, res) => {
  if (!requireDevAuth(req, res)) return;
  const token = (req.query.token || "").toString();
  const html = `
<!doctype html>
<meta charset="utf-8">
<title>DPA Live Transcript (Private)</title>
<meta name="robots" content="noindex,nofollow">
<style>
  body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#0b0c10;color:#e6edf3}
  header{position:sticky;top:0;background:#11131a;padding:12px 16px;border-bottom:1px solid #1f232b}
  main{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px}
  .col{background:#11131a;border:1px solid #1f232b;border-radius:12px;padding:12px;min-height:50vh}
  .col h2{margin:0 0 8px 0;font-size:14px;color:#9fb1c5;letter-spacing:.03em;text-transform:uppercase}
  .line{padding:6px 8px;border-bottom:1px dashed #232734;white-space:pre-wrap;word-wrap:break-word}
  .you .line{color:#d9f99d}
  .anna .line{color:#93c5fd}
  .meta{font-size:12px;color:#9fb1c5;margin-left:6px}
</style>
<header>
  <strong>DPA Live Transcript</strong>
  <span class="meta">private /live (token & dev-mode)</span>
</header>
<main>
  <section class="col you"><h2>👂 You Said</h2><div id="you"></div></section>
  <section class="col anna"><h2>🗣️ ${DPA_NAME} Said</h2><div id="anna"></div></section>
</main>
<script>
  const you = document.getElementById('you');
  const anna = document.getElementById('anna');
  const token = ${JSON.stringify(token)};
  if(!token){ document.body.innerHTML = '<p style="padding:16px">Missing ?token= in URL.</p>'; }
  function add(el, text) {
    const div = document.createElement('div');
    div.className = 'line';
    div.textContent = text;
    el.prepend(div);
  }
  const es = token ? new EventSource('/live?token=' + encodeURIComponent(token)) : null;
  if (es) {
    es.addEventListener('you_delta', (e)=> { try{ const {text}=JSON.parse(e.data); if(text) add(you, text);}catch{} });
    es.addEventListener('you_turn', (e)=> { try{ const {text}=JSON.parse(e.data); if(text) add(you, '— ' + text);}catch{} });
    es.addEventListener('anna_delta', (e)=> { try{ const {text}=JSON.parse(e.data); if(text) add(anna, text);}catch{} });
    es.addEventListener('anna_turn', (e)=> { try{ const {text}=JSON.parse(e.data); if(text) add(anna, '— ' + text);}catch{} });
    es.onerror = () => console.warn('SSE connection error');
  }
</script>`;
  res.status(200).type("html").send(html);
});
/* ------------------------ END PRIVATE TRANSCRIPT ------------------------- */

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

  // Transcript accumulators
  let callerText = "";
  let assistantText = "";

  const resetBuffer = () => { mulawChunks = []; bytesBuffered = 0; };
  const nowMs = () => Date.now();
  const bufferedMs = (bytes) => Math.round((bytes / 800) * 100); // μ-law @8k

  function canCommit() {
    if (!socketOpen || !sessionHealthy || sessionError) return false;
    if (commitInflight) return false;
    if (nowMs() - lastCommitAt < COMMIT_COOLDOWN_MS) return false;
    return bytesBuffered >= MIN_COMMIT_BYTES && mulawChunks.length > 0;
  }

  function doCommit({ respond, cause }) {
    if (!canCommit()) return;

    const payloadBuf = Buffer.concat(mulawChunks);
    const ms = bufferedMs(payloadBuf.length);
    if (ms < 100) return; // API minimum
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
        sseBroadcast("you_turn", { text: callerText.trim() });
        callerText = "";
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
    if (!canCommit()) return;
    if (nowMs() - lastTrickleAt < TRICKLE_MS) return;
    lastTrickleAt = nowMs();
    doCommit({ respond: false, cause: "trickle" }); // ASR-only
  }

  oai.on("open", () => {
    socketOpen = true;
    console.log("🔗 OpenAI Realtime connected");

    const persona = `${DPA_NAME}, ${DPA_ROLE}. Speak in a ${DPA_TONE} tone and ${DPA_STYLE}.`;
    const instructions = DEV_MODE
      ? `You are ${persona}
Caller is ${DEV_CALLER_NAME}. Be concise. Avoid asking for phone numbers unless requested.

PROJECT BRIEF:
${PROJECT_BRIEF}`
      : `You are ${persona}`;

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
            response: { modalities: ["audio","text"], instructions: DPA_GREETING }
          }));
          activeResponse = true;
        } catch (e) { console.error("❌ greeting send failed:", e?.message || e); }
      }
    }, 120);
  });

  oai.on("error", (e) => console.error("🔻 OAI socket error:", e?.message || e));
  oai.on("close", (c, r) => console.log("🔚 OAI socket closed", c, r?.toString?.() || ""));

  // ---- OpenAI -> Twilio + Logs ----
  oai.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    // Debug peek for transcription-ish events (helps surface new shapes)
    if (msg?.type && (msg.type.includes("transcript") || msg.type.includes("input_audio") || msg.type.includes("input_text"))) {
      console.log("🔎 OAI event:", msg.type);
    }

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

    if (msg.type === "response.created") { activeResponse = true; return; }
    if (msg.type === "response.completed" || msg.type === "response.output_audio.done" || msg.type === "response.refusal.delta") {
      activeResponse = false;
      if (assistantText.trim()) {
        console.log(`🗣️ ${DPA_NAME.toUpperCase()} (turn):`, assistantText.trim());
        sseBroadcast("anna_turn", { text: assistantText.trim() });
      }
      assistantText = "";
      return;
    }

    // Assistant transcript (delta/streaming)
    if (msg.type === "response.audio_transcript.delta" && msg.delta) {
      const d = String(msg.delta);
      assistantText += d;
      console.log(`🗣️ ${DPA_NAME.toUpperCase()} SAID:`, d);
      sseBroadcast("anna_delta", { text: d });
      return;
    }

    // Caller transcripts (common)
    if (msg.type === "response.input_audio_transcription.delta" && msg.delta) {
      const d = String(msg.delta);
      callerText += d;
      console.log("👂 YOU SAID:", d);
      sseBroadcast("you_delta", { text: d });
      return;
    }
    if (msg.type === "response.input_text.delta" && msg.delta) {
      const d = String(msg.delta);
      callerText += d;
      console.log("👂 YOU SAID (text):", d);
      sseBroadcast("you_delta", { text: d });
      return;
    }

    // --- EXTRA HANDLERS: alternate shapes seen in some runtimes ---

    // Non-prefixed delta
    if (msg.type === "input_audio_transcription.delta" && msg.delta) {
      const d = String(msg.delta);
      callerText += d;
      console.log("👂 YOU SAID (np.delta):", d);
      sseBroadcast("you_delta", { text: d });
      return;
    }

    // Completed events with full transcript
    if (msg.type === "response.input_audio_transcription.completed" && msg.transcript) {
      const t = String(msg.transcript);
      callerText += t;
      console.log("👂 YOU SAID (completed):", t);
      sseBroadcast("you_delta", { text: t });
      sseBroadcast("you_turn", { text: t });
      return;
    }
    if (msg.type === "input_audio_transcription.completed" && msg.transcript) {
      const t = String(msg.transcript);
      callerText += t;
      console.log("👂 YOU SAID (np.completed):", t);
      sseBroadcast("you_delta", { text: t });
      sseBroadcast("you_turn", { text: t });
      return;
    }

    // Forward assistant audio to Twilio
    if (streamSid) {
      if (msg.type === "response.audio.delta" && msg.delta) {
        try { twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.delta } })); } catch (e) { console.error("❌ send audio to Twilio failed:", e?.message || e); }
        return;
      }
      if (msg.type === "response.output_audio.delta" && msg.audio) {
        try { twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.audio } })); } catch (e) { console.error("❌ send audio to Twilio failed:", e?.message || e); }
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

    const t = Date.now();
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
        resetBuffer();
        mediaPackets = 0;
        lastSpeechAt = Date.now();
        turnStartedAt = Date.now();
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
        if (e > SPEECH_THRESH) lastSpeechAt = Date.now();
        mulawChunks.push(mulaw);
        bytesBuffered += mulaw.length;
        break;
      }

      case "mark":
        break;

      case "stop":
        console.log("🛑 Twilio STOP event");
        doCommit({ respond: false, cause: "stop" }); // flush tail, no reply
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
