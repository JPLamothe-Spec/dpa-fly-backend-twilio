// index.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// --- Health & root first (so Fly checks pass) ---
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.status(200).send("DPA backend (Twilio inline ffmpeg) is live ✅"));

// --- Twilio webhook to start media stream ---
app.post("/twilio/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const wsUrl = `wss://${host}/media-stream`;
  const twiml = `
    <Response>
      <Start>
        <Stream url="${wsUrl}" track="inbound_track" />
      </Start>
      <Pause length="30"/>
    </Response>
  `.trim();
  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
});

// --- HTTP server + controlled WS upgrade ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  try {
    if (request.url !== "/media-stream") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, async (ws) => {
      console.log("✅ Twilio WebSocket connected");

      // Lazy-require so heavy deps can't break /health at boot
      let handleStream;
      try {
        ({ handleStream } = require("./stream-handler"));
      } catch (e) {
        console.error("❌ Failed to load stream-handler:", e);
        ws.close();
        return;
      }

      try {
        handleStream(ws);
      } catch (e) {
        console.error("❌ handleStream crashed:", e);
        try { ws.close(); } catch {}
      }
    });
  } catch (e) {
    console.error("upgrade error:", e);
    try { socket.destroy(); } catch {}
  }
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on 0.0.0.0:${PORT}`);
});

// Guardrails: don't let async errors crash the process
process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));

