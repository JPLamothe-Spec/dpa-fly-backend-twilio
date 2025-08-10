// index.js — Twilio <Connect><Stream> full duplex (passes streamSid to playback)
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
require("dotenv").config();

const { startPlaybackFromTTS, startPlaybackTone } = require("./tts");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// Twilio webhook: open a full-duplex media stream
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

// Simple health checks
app.get("/", (_req, res) => res.status(200).send("DPA backend is live"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

const server = http.createServer(app);

// WebSocket endpoint Twilio connects to
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

  ws.on("message", async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      console.error("⚠️ WS message parse error:", e);
      return;
    }

    switch (data.event) {
      case "connected":
        console.log("📞 Twilio media stream connected");
        break;

      case "start":
        streamSid = data.start?.streamSid || null;
        console.log(`🔗 Stream started. streamSid=${streamSid}`);

        // Choose playback mode
        if (!process.env.OPENAI_API_KEY) {
          console.log("🔊 Playback mode: Tone (no OPENAI_API_KEY set)");
          startPlaybackTone({ ws, streamSid, logPrefix: "TONE" })
            .catch((e) => console.error("TTS/playback error (tone):", e?.message || e));
        } else {
          console.log("🔊 Playback mode: OpenAI TTS");
          const greet = "Hi, this is Anna, JP's digital personal assistant. Would you like me to pass on a message?";
          startPlaybackFromTTS({
            ws,
            streamSid,
            text: greet,
            voice: process.env.TTS_VOICE || "alloy",
            model: process.env.TTS_MODEL || "gpt-4o-mini-tts",
          }).catch((e) => console.error("TTS/playback error:", e?.message || e));
        }
        break;

      case "media":
        // inbound μ-law@8k frames in data.media.payload (base64)
        // keep logs minimal to avoid noise
        break;

      case "mark":
        // Twilio will echo back your marks when it finishes playing your audio
        // console.log("📍 mark from Twilio:", data?.mark?.name);
        break;

      case "stop":
        console.log("🛑 Twilio signaled stop — closing stream");
        try { ws.close(); } catch {}
        break;
    }
  });

  ws.on("close", () => {
    console.log("❌ WebSocket closed");
  });

  ws.on("error", (err) => {
    console.error("⚠️ WebSocket error:", err?.message || err);
    try { ws.close(); } catch {}
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on 0.0.0.0:${PORT}`);
});
