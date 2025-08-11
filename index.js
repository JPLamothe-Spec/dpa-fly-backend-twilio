// index.js — Twilio PSTN ↔ OpenAI Realtime (WS bridge)
// - Streams Twilio audio to OpenAI Realtime and streams model audio back
// - British / AU female voice via VOICE=verse (or sage)
// - Silence-based auto-commit + response creation (natural turn-taking)
// - Injects dev-mode project brief at session start
// - Cleans up fully on hangup (no post-call loops)

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static") || "ffmpeg";
require("dotenv").config();

// ESM-friendly node-fetch in CJS
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ========= Config =========
const PUBLIC_URL = process.env.PUBLIC_URL || ""; // e.g. your Fly URL (https://appname.fly.dev)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const VOICE = (process.env.VOICE || "verse").toLowerCase(); // verse/sage/etc
const DEV_MODE = String(process.env.ANNA_DEV_MODE || "true").toLowerCase() === "true";
const DEV_CALLER_NAME = process.env.DEV_CALLER_NAME || "JP";
const PROJECT_BRIEF_PATH = process.env.PROJECT_BRIEF_PATH || "./project-brief.md";

// VAD / turn taking (tweak to taste)
const SPEECH_THRESH = Number(process.env.VAD_SPEECH_THRESH || 22);   // ulaw avg energy thresh
const SILENCE_MS    = Number(process.env.VAD_SILENCE_MS || 900);    // end turn after ~0.9s silence
const MAX_TURN_MS   = Number(process.env.VAD_MAX_TURN_MS || 6000);  // cap turn to avoid run-ons

// Maintenance kill-switch: reject calls instantly
const MAINTENANCE_MODE = String(process.env.MAINTENANCE_MODE || "false").toLowerCase() === "true";

// ====== Load project brief (optional) ======
let PROJECT_BRIEF = "";
try {
  PROJECT_BRIEF = fs.readFileSync(PROJECT_BRIEF_PATH, "utf8");
  console.log(`🧠 Loaded project brief (${PROJECT_BRIEF.length} chars)`);
} catch {
  console.log("🧠 No project brief file found; proceeding without it.");
}

// ====== Simple ulaw energy ======
function ulawEnergy(buf) {
  let acc = 0;
  for (let i = 0; i < buf.length; i++) acc += Math.abs(buf[i] - 0x7f);
  return acc / buf.length; // rough 0..128
}

// ====== Twilio webhook: returns TwiML to open a media stream ======
app.post("/twilio/voice", (req, res) => {
  if (MAINTENANCE_MODE) {
    console.log("🚫 MAINTENANCE_MODE active — rejecting call");
    return res.type("text/xml").send(`<Response><Reject/></Response>`);
  }
  console.log("➡️ /twilio/voice hit");
  const host = req.headers.host;
  // Use PUBLIC_URL if you terminate behind a proxy/edge; else use live incoming host
  const wsUrl = PUBLIC_URL ? `${PUBLIC_URL}` : `https://${host}`;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${wsUrl.replace(/^http/i, "ws")}/call"/>
      </Connect>
    </Response>
  `.trim();
  res.type("text/xml").send(twiml);
});

// Health
app.get("/", (_req, res) => res.status(200).send("Realtime DPA backend is live"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ====== HTTP server + WS upgrade ======
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (request.url === "/call") {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  } else {
    socket.destroy();
  }
});

// ====== OpenAI Realtime connect helper ======
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

// ====== Audio conversion: Twilio μ-law 8k → PCM16 16k ======
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

// ====== WS bridge per call ======
wss.on("connection", async (twilioWS) => {
  console.log("✅ Twilio WebSocket connected");

  if (!OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY not set");
    try { twilioWS.close(); } catch {}
    return;
  }

  let callEnded = false;
  let streamSid = null;

  // VAD state (for committing turns)
  let collecting = false;
  let pcmChunks = [];           // PCM16@16k chunks for this turn
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

  // When Realtime sends audio deltas, pipe to Twilio
  oaiWS.on("message", async (data) => {
    if (callEnded) return;
    try {
      const msg = JSON.parse(data.toString());
      // We ask OpenAI to emit μ-law 8k frames, so we can pass straight to Twilio
      if (msg.type === "response.output_audio.delta" && msg.audio) {
        const payloadB64 = Buffer.from(msg.audio, "base64").toString("base64"); // already mulaw@8k
        twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload: payloadB64 } }));
      }
      if (msg.type === "response.output_audio.done") {
        twilioWS.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts-done" } }));
      }
      // Log useful items in dev
      if (msg.type === "error") console.error("🔻 OAI error:", msg);
    } catch {}
  });

  oaiWS.on("close", () => {
    if (!callEnded) console.log("ℹ️ OpenAI Realtime closed");
  });

  oaiWS.on("error", (err) => {
    console.error("⚠️ OpenAI Realtime error:", err?.message || err);
  });

  // Session bootstrap: voice + instructions + output audio format
  function sendSessionUpdate() {
    const brief = PROJECT_BRIEF ? `\n\nPROJECT BRIEF:\n${PROJECT_BRIEF}\n` : "";
    const instructions = DEV_MODE
      ? `You are Anna, JP’s English-accented digital personal assistant AND a core member of the DPA build team.
Caller is ${DEV_CALLER_NAME}. Be concise. Avoid asking for phone numbers unless requested.${brief}`
      : `You are Anna, JP’s assistant on a live phone call. Be concise and helpful.`;

    const sess = {
      type: "session.update",
      session: {
        // Stream audio out as μ-law 8k so we can pass straight to Twilio
        audio_format: "pcm_mulaw",
        sample_rate: 8000,
        // Input audio is PCM16@16k (we convert from Twilio μ-law)
        input_audio_format: "pcm16",
        input_sample_rate: 16000,
        // Realtime modalities
        modalities: ["audio", "text"],
        voice: VOICE,
        instructions
      }
    };
    oaiWS.send(JSON.stringify(sess));
  }
  sendSessionUpdate();

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

  // ====== Twilio media stream handling ======
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
        // Start VAD / collection
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
            // Commit a turn to Realtime
            try {
              const pcm = Buffer.concat(pcmChunks);
              const b64 = pcm.toString("base64");
              oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
              oaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              oaiWS.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] } }));
            } catch (e) {
              console.error("❌ Failed to send to Realtime:", e?.message || e);
            }
            // reset for next turn
            pcmChunks = [];
            turnStartedAt = Date.now();
          }
        }, 50);
        break;

      case "media": {
        const b64 = data?.media?.payload;
        if (!b64) break;
        const mulaw = Buffer.from(b64, "base64");

        // VAD: update speech / silence tracking from μ-law energy
        const e = ulawEnergy(mulaw);
        if (e > SPEECH_THRESH) lastSpeechAt = Date.now();

        // Convert to PCM16@16k and store for current turn
        try {
          const pcm16 = await ulaw8kToPcm16k(mulaw);
          pcmChunks.push(pcm16);
        } catch (e) {
          console.error("ffmpeg ulaw->pcm error:", e?.message || e);
        }
        break;
      }

      case "mark":
        // You can log tts-done here if you want
        break;

      case "stop":
        endCall("twilio stop");
        break;
    }
  });

  twilioWS.on("close", () => { endCall("ws close"); console.log("❌ Twilio WS closed"); });
  twilioWS.on("error", (err) => { console.error("⚠️ Twilio WS error:", err?.message || err); endCall("ws error"); });
});

// ====== Server listen ======
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Realtime server on 0.0.0.0:${PORT}`);
});
