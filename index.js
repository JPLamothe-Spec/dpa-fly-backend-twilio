// index.js — Twilio PSTN ↔ OpenAI Realtime (WS bridge)
// - Live streaming voice both ways (no batch TTS/Whisper)
// - Natural barge-in and turn-taking
// - UK-leaning female voice via VOICE=verse (or sage)
// - Built-in dev-mode project brief (no extra file)
// - Clean shutdown on hangup

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static") || "ffmpeg";
require("dotenv").config();

const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ===== Config =====
const PUBLIC_URL = process.env.PUBLIC_URL || ""; // e.g. https://your-app.fly.dev
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const VOICE = (process.env.VOICE || "verse").toLowerCase(); // try "verse" or "sage"
const DEV_MODE = String(process.env.ANNA_DEV_MODE || "true").toLowerCase() === "true";
const DEV_CALLER_NAME = process.env.DEV_CALLER_NAME || "JP";
const MAINTENANCE_MODE = String(process.env.MAINTENANCE_MODE || "false").toLowerCase() === "true";

// VAD tuning (avoid cutoffs by giving a little more silence)
const SPEECH_THRESH = Number(process.env.VAD_SPEECH_THRESH || 22);  // μ-law energy
const SILENCE_MS    = Number(process.env.VAD_SILENCE_MS || 1100);  // end turn after ~1.1s silence
const MAX_TURN_MS   = Number(process.env.VAD_MAX_TURN_MS || 6000); // hard cap per turn

// ===== Built-in project brief (override via env PROJECT_BRIEF if you like) =====
const PROJECT_BRIEF =
  process.env.PROJECT_BRIEF ||
  `Digital Personal Assistant (DPA) Project
- Goal: natural, low-latency phone assistant for JP.
- Priorities: realtime voice, UK/AU female voice, no unsolicited number capture, low latency, smooth barge-in.
- Dev mode: treat caller as JP (teammate). Be concise, flag issues (latency, transcription, overlap), suggest next tests.
- Behaviours: avoid asking for phone numbers unless explicitly requested. Keep replies short unless asked to elaborate.`;

// ===== Simple μ-law energy =====
function ulawEnergy(buf) {
  let acc = 0;
  for (let i = 0; i < buf.length; i++) acc += Math.abs(buf[i] - 0x7f);
  return acc / buf.length;
}

// ===== Twilio webhook returns TwiML to open the media stream =====
app.post("/twilio/voice", (req, res) => {
  if (MAINTENANCE_MODE) {
    console.log("🚫 MAINTENANCE_MODE active — rejecting call");
    return res.type("text/xml").send(`<Response><Reject/></Response>`);
  }
  console.log("➡️ /twilio/voice hit");
  const host = req.headers.host;
  const base = PUBLIC_URL || `https://${host}`;
  const wsUrl = base.replace(/^http/i, "ws");
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${wsUrl}/call"/>
      </Connect>
    </Response>
  `.trim();
  res.type("text/xml").send(twiml);
});

// Health
app.get("/", (_req, res) => res.status(200).send("Realtime DPA backend is live"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ===== HTTP server + WS upgrade =====
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (request.url === "/call") {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  } else {
    socket.destroy();
  }
});

// ===== OpenAI Realtime connect =====
function connectOpenAIRealtime() {
  return new Promise((resolve, reject) => {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
    const oai = new WebSocket(url, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });
    oai.on("open", () => resolve(oai));
    oai.on("error", reject);
  });
}

// μ-law 8k → PCM16 16k (for OpenAI input)
function ulaw8kToPcm16k(mulawBuffer) {
  return new Promise((resolve, reject) => {
    const args = [
      "-f", "mulaw", "-ar", "8000", "-ac", "1", "-i", "pipe:0",
      "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"
    ];
    const p = spawn(ffmpegPath, args);
    const chunks = [];
    let err = "";
    p.stdout.on("data", b => chunks.push(b));
    p.stderr.on("data", b => err += b.toString());
    p.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ulaw->pcm16 failed ${code}: ${err}`)));
    p.on("error", reject);
    p.stdin.end(mulawBuffer);
  });
}

// ===== Per-call bridge =====
wss.on("connection", async (twilioWS) => {
  console.log("✅ Twilio WebSocket connected");

  if (!OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY not set");
    try { twilioWS.close(); } catch {}
    return;
  }

  let callEnded = false;
  let streamSid = null;

  // VAD/turn state
  let collecting = false;
  let pcmChunks = [];
  let lastSpeechAt = Date.now();
  let turnStartedAt = 0;
  let vadPoll = null;

  // Connect to OpenAI Realtime
  let oaiWS;
  try {
    oaiWS = await connectOpenAIRealtime();
  } catch (e) {
    console.error("❌ Failed to connect OpenAI Realtime:", e?.message || e);
    try { twilioWS.close(); } catch {}
    return;
  }

  // Pipe Realtime audio back to Twilio (expecting μ-law 8k from model)
  oaiWS.on("message", async (data) => {
    if (callEnded) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "response.output_audio.delta" && msg.audio) {
        twilioWS.send(JSON.stringify({
          event: "media", streamSid,
          media: { payload: Buffer.from(msg.audio, "base64").toString("base64") }
        }));
      }
      if (msg.type === "response.output_audio.done") {
        twilioWS.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts-done" } }));
      }
      if (msg.type === "error") console.error("🔻 OAI error:", msg);
    } catch {}
  });

  function endCall(reason = "unknown") {
    if (callEnded) return;
    callEnded = true;
    console.log("🛑 Ending call:", reason);
    try { if (vadPoll) { clearInterval(vadPoll); vadPoll = null; } } catch {}
    collecting = false;
    pcmChunks = [];
    try { if (oaiWS && oaiWS.readyState === WebSocket.OPEN) oaiWS.close(); } catch {}
    try { if (twilioWS && twilioWS.readyState === WebSocket.OPEN) twilioWS.close(); } catch {}
  }

  // Send session setup: voice, formats, instructions
  function sendSessionUpdate() {
    const instructions = DEV_MODE
      ? `You are Anna, JP’s English-accented digital personal assistant AND a core member of the DPA build team.
Caller is ${DEV_CALLER_NAME}. Be concise. Avoid asking for phone numbers unless requested.

PROJECT BRIEF:
${PROJECT_BRIEF}`
      : `You are Anna, JP’s assistant on a live phone call. Be concise and helpful.`;

    const sess = {
      type: "session.update",
      session: {
        audio_format: "pcm_mulaw",       // model -> μ-law@8k (pass straight to Twilio)
        sample_rate: 8000,
        input_audio_format: "pcm16",     // we send PCM16@16k
        input_sample_rate: 16000,
        modalities: ["audio", "text"],
        voice: VOICE,
        instructions
      }
    };
    oaiWS.send(JSON.stringify(sess));
  }
  sendSessionUpdate();

  // Handle Twilio media stream
  twilioWS.on("message", async (raw) => {
    if (callEnded) return;
    let data; try { data = JSON.parse(raw.toString()); } catch { return; }

    switch (data.event) {
      case "connected":
        console.log("📞 Twilio media stream connected");
        break;

      case "start":
        streamSid = data.start?.streamSid || null;
        console.log(`🔗 Stream started. streamSid=${streamSid} voice=${VOICE} model=${REALTIME_MODEL} dev=${DEV_MODE}`);
        // Start VAD
        collecting = true;
        pcmChunks = [];
        lastSpeechAt = Date.now();
        turnStartedAt = Date.now();

        if (vadPoll) { clearInterval(vadPoll); vadPoll = null; }
        vadPoll = setInterval(async () => {
          if (callEnded || !collecting) return;
          const now = Date.now();
          const longSilence = (now - lastSpeechAt) >= SILENCE_MS;
          const hitMax = (now - turnStartedAt) >= MAX_TURN_MS;

          if ((longSilence || hitMax) && pcmChunks.length) {
            try {
              const pcm = Buffer.concat(pcmChunks);
              const b64 = pcm.toString("base64");
              oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
              oaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              oaiWS.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] } }));
            } catch (e) {
              console.error("❌ send to Realtime failed:", e?.message || e);
            }
            pcmChunks = [];
            turnStartedAt = Date.now();
          }
        }, 50);
        break;

      case "media": {
        const b64 = data?.media?.payload;
        if (!b64) break;
        const mulaw = Buffer.from(b64, "base64");

        // VAD energy
        const e = ulawEnergy(mulaw);
        if (e > SPEECH_THRESH) lastSpeechAt = Date.now();

        // Convert to PCM16@16k for model input
        try {
          const pcm16 = await ulaw8kToPcm16k(mulaw);
          pcmChunks.push(pcm16);
        } catch (err) {
          console.error("ffmpeg ulaw->pcm error:", err?.message || err);
        }
        break;
      }

      case "mark":
        // Optional: observe "tts-done"
        break;

      case "stop":
        endCall("twilio stop");
        break;
    }
  });

  twilioWS.on("close", () => { endCall("ws close"); console.log("❌ Twilio WS closed"); });
  twilioWS.on("error", (err) => { console.error("⚠️ Twilio WS error:", err?.message || err); endCall("ws error"); });
});

// ===== Start server =====
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Realtime server on 0.0.0.0:${PORT}`);
});
