// index.js — Twilio <Connect><Stream> full duplex baseline (Debian + ffmpeg-static)
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
require("dotenv").config();

const { startPlaybackFromTTS, startPlaybackTone } = require("./tts");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// --- 1) Twilio webhook: return full-duplex stream ---
app.post("/twilio/voice", (req, res) => {
  const host = req.headers.host;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="wss://${host}/media-stream"/>
      </Connect>
    </Response>
  `.trim();

  res.type("text/xml");
  res.send(twiml);
});

// Helpful pings
app.get("/", (_req, res) => res.status(200).send("DPA backend is live"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

const server = http.createServer(app);

// --- 2) WebSocket: Twilio connects here for media duplex ---
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/media-stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  console.log("✅ Twilio WebSocket connected");

  let streamSid = null;
  let started = false;
  let closed = false;

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "connected") {
        console.log("📞 Twilio media stream connected");
      }

      if (data.event === "start") {
        streamSid = data.start?.streamSid || null;
        console.log(`🔗 Stream started. streamSid=${streamSid}`);
        started = true;

        // === PLAYBACK: pick one mode ===
        // Mode A: simple tone (no API keys required) — proves outbound audio
        if (!process.env.OPENAI_API_KEY) {
          startPlaybackTone({ ws, logPrefix: "TONE" })
            .catch((e) => console.error("TTS/playback error (tone):", e?.message || e));
        } else {
          // Mode B: OpenAI TTS speaking Anna's greeting
          const greet = "Hi, this is Anna, JP's digital personal assistant. Would you like me to pass on a message?";
          startPlaybackFromTTS({
            ws,
            text: greet,
            voice: process.env.TTS_VOICE || "alloy",        // set if you want a specific voice
            model: process.env.TTS_MODEL || "gpt-4o-mini-tts" // OpenAI TTS model
          }).catch((e) => console.error("TTS/playback error:", e?.message || e));
        }
      }

      if (data.event === "media") {
        // Inbound 20ms μ-law@8k frames from caller — you can forward to ASR/LLM here
        // data.media.payload is base64 μ-law. Logging each chunk is noisy; keep minimal.
        // console.log("🔊 inbound media", data.media?.payload?.length || 0);
      }

      if (data.event === "mark") {
        // Optional: used to coordinate transfers
        // console.log("📍 mark", data.mark?.name);
      }

      if (data.event === "stop") {
        console.log("🛑 Twilio signaled stop — closing stream");
        try { ws.close(); } catch {}
      }
    } catch (e) {
      console.error("⚠️ WS message parse error:", e);
    }
  });

  ws.on("close", () => {
    if (!closed) {
      closed = true;
      console.log("❌ WebSocket closed");
    }
  });

  ws.on("error", (err) => {
    console.error("⚠️ WebSocket error:", err?.message || err);
    try { ws.close(); } catch {}
  });
});

// --- 3) Start server ---
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on 0.0.0.0:${PORT}`);
});
