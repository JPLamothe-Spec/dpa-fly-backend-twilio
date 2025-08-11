// Twilio PSTN ↔ OpenAI Realtime (μ-law end-to-end, hardcoded Stream URL)
// - No ffmpeg, no resampling: g711_ulaw 8k in/out
// - Proactive greeting; simple VAD turn-taking
// - Dev brief inline; UK-leaning female voice via VOICE=verse
// - Hard override STREAM_WS_URL so Twilio always connects correctly

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

/* ===== Hardcoded Stream URL (Option A) =====
   Make sure this matches your Fly app URL.
   You can still override at runtime by setting STREAM_WS_URL env if you want. */
const STREAM_WS_URL =
  process.env.STREAM_WS_URL || "wss://dpa-fly-backend-twilio.fly.dev/call";

/* ===== OpenAI Realtime config ===== */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const VOICE = (process.env.VOICE || "verse").toLowerCase(); // try "sage" if you want a different female timbre
const DEV_MODE = String(process.env.ANNA_DEV_MODE || "true").toLowerCase() === "true";
const DEV_CALLER_NAME = process.env.DEV_CALLER_NAME || "JP";

/* ===== VAD / Turn-taking ===== */
const SPEECH_THRESH = Number(process.env.VAD_SPEECH_THRESH || 22);  // μ-law energy threshold
const SILENCE_MS    = Number(process.env.VAD_SILENCE_MS || 1100);  // end turn after ~1.1s silence
const MAX_TURN_MS   = Number(process.env.VAD_MAX_TURN_MS || 6000); // cap a single turn

/* ===== Project brief (inline) ===== */
const PROJECT_BRIEF =
  process.env.PROJECT_BRIEF ||
  `Digital Personal Assistant (DPA) Project
- Goal: natural, low-latency phone assistant for JP.
- Priorities: realtime voice, UK/AU female voice, no unsolicited number capture, low latency, smooth barge-in.
- Dev mode: treat caller as JP (teammate). Be concise, flag issues (latency, transcription, overlap), suggest next tests.
- Behaviours: avoid asking for phone numbers unless explicitly requested. Keep replies short unless asked to elaborate.`;

/* ===== Helpers ===== */
function ulawEnergy(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += Math.abs(buf[i] - 0x7f);
  return s / buf.length;
}

/* ===== Twilio webhook: return TwiML with hardcoded WS URL ===== */
function twiml() {
  return `
    <Response>
      <Connect>
        <Stream url="${STREAM_WS_URL}" track="inbound_audio"/>
      </Connect>
    </Response>
  `.trim();
}

app.post("/twilio/voice", (req, res) => {
  console.log("➡️ /twilio/voice hit (POST)");
  const xml = twiml();
  console.log("🧾 TwiML returned:", xml);
  res.type("text/xml").send(xml);
});

app.get("/twilio/voice", (req, res) => {
  console.log("➡️ /twilio/voice hit (GET)");
  const xml = twiml();
  console.log("🧾 TwiML returned:", xml);
  res.type("text/xml").send(xml);
});

/* ===== Health ===== */
app.get("/", (_req, res) => res.status(200).send("Realtime DPA backend is live"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

/* ===== HTTP + WS ===== */
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/call") {
    wss.handleUpgrade(request, socket, head, (ws) =>
      wss.emit("connection", ws, request)
    );
  } else {
    socket.destroy();
  }
});

/* ===== OpenAI Realtime connect ===== */
function connectOpenAIRealtime() {
  return new Promise((resolve, reject) => {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
      REALTIME_MODEL
    )}`;
    const oai = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });
    oai.on("open", () => resolve(oai));
    oai.on("error", reject);
  });
}

/* ===== Per-call bridge (μ-law end-to-end) ===== */
wss.on("connection", async (twilioWS) => {
  console.log("✅ Twilio WebSocket connected");

  if (!OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY not set");
    try { twilioWS.close(); } catch {}
    return;
  }

  let streamSid = null;
  let callEnded = false;

  // VAD/turn state
  let mulawChunks = [];
  let lastSpeechAt = Date.now();
  let turnStartedAt = 0;
  let vadPoll = null;

  // Connect Realtime
  let oaiWS;
  try {
    oaiWS = await connectOpenAIRealtime();
  } catch (e) {
    console.error("❌ Failed to connect OpenAI Realtime:", e?.message || e);
    try { twilioWS.close(); } catch {}
    return;
  }

  // OpenAI -> Twilio audio stream
  oaiWS.on("message", (data) => {
    if (callEnded) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "response.output_audio.delta" && msg.audio) {
        twilioWS.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: Buffer.from(msg.audio, "base64").toString("base64") }
        }));
      }
      if (msg.type === "response.output_audio.done") {
        twilioWS.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts-done" } }));
      }
      if (msg.type === "error") {
        console.error("🔻 OAI error:", msg);
      }
    } catch (e) {
      console.error("⚠️ Failed to parse OAI message", e?.message || e);
    }
  });

  function endCall(reason = "unknown") {
    if (callEnded) return;
    callEnded = true;
    console.log("🛑 Ending call:", reason);
    try { if (vadPoll) { clearInterval(vadPoll); vadPoll = null; } } catch {}
    mulawChunks = [];
    try { if (oaiWS && oaiWS.readyState === WebSocket.OPEN) oaiWS.close(); } catch {}
    try { if (twilioWS && twilioWS.readyState === WebSocket.OPEN) twilioWS.close(); } catch {}
  }

  // Send session setup (μ-law in/out, voice, instructions)
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
        input_audio_format:  "g711_ulaw", // Twilio μ-law @ 8k
        output_audio_format: "g711_ulaw", // Send μ-law back to Twilio
        modalities: ["audio", "text"],
        voice: VOICE,
        instructions
      }
    };
    oaiWS.send(JSON.stringify(sess));
  }
  sendSessionUpdate();

  // Twilio media handling
  twilioWS.on("message", async (raw) => {
    if (callEnded) return;
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (!data.event) {
      console.log("ℹ️ Twilio message without event:", data);
      return;
    }

    switch (data.event) {
      case "connected":
        console.log("📞 Twilio media stream connected");
        break;

      case "start":
        streamSid = data.start?.streamSid || null;
        console.log(`🔗 Stream started. streamSid=${streamSid} voice=${VOICE} model=${REALTIME_MODEL} dev=${DEV_MODE}`);

        mulawChunks = [];
        lastSpeechAt = Date.now();
        turnStartedAt = Date.now();

        // Proactive greeting so you hear Anna immediately
        try {
          oaiWS.send(JSON.stringify({
            type: "response.create",
            response: { modalities: ["audio"] }
          }));
        } catch (e) {
          console.error("❌ initial greeting failed:", e?.message || e);
        }

        if (vadPoll) { clearInterval(vadPoll); vadPoll = null; }
        vadPoll = setInterval(() => {
          if (callEnded) return;
          const now = Date.now();
          const longSilence = (now - lastSpeechAt) >= SILENCE_MS;
          const hitMax = (now - turnStartedAt) >= MAX_TURN_MS;

          if ((longSilence || hitMax) && mulawChunks.length) {
            try {
              const mulaw = Buffer.concat(mulawChunks);
              const b64 = mulaw.toString("base64");
              oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
              oaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              oaiWS.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] } }));
            } catch (e) {
              console.error("❌ send to Realtime failed:", e?.message || e);
            }
            mulawChunks = [];
            turnStartedAt = Date.now();
          }
        }, 50);
        break;

      case "media": {
        const b64 = data?.media?.payload;
        if (!b64) break;
        const mulaw = Buffer.from(b64, "base64");

        // VAD energy detect
        const e = ulawEnergy(mulaw);
        if (e > SPEECH_THRESH) lastSpeechAt = Date.now();

        // accumulate raw μ-law
        mulawChunks.push(mulaw);
        break;
      }

      case "mark":
        // tts-done marker from our own responses if needed
        break;

      case "stop":
        endCall("twilio stop");
        break;

      default:
        console.log("ℹ️ Unhandled Twilio event:", data.event);
        break;
    }
  });

  twilioWS.on("close", () => { endCall("ws close"); console.log("❌ Twilio WS closed"); });
  twilioWS.on("error", (err) => { console.error("⚠️ Twilio WS error:", err?.message || err); endCall("ws error"); });
});

/* ===== Start server ===== */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Realtime server on 0.0.0.0:${PORT}`);
});
