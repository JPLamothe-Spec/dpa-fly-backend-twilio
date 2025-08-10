const express = require("express");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Health check endpoint for Fly.io
app.get("/", (req, res) => {
  res.status(200).send("Twilio backend live");
});

// Simple GET endpoint to test if webhook URL is live (optional)
app.get("/twilio/voice", (req, res) => {
  res.status(200).send("Twilio voice webhook endpoint is live.");
});

// Twilio webhook to answer calls and start Media Stream with 16kHz PCM
app.post("/twilio/voice", (req, res) => {
  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${req.headers.host}/media-stream" track="inbound_track" />
      </Start>
    </Response>
  `.trim();

  res.type("text/xml");
  res.send(twiml);
});

// Create HTTP server and WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Handle WebSocket upgrades for media streaming
server.on("upgrade", (request, socket, head) => {
  if (request.url === "/media-stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Handle incoming WebSocket connections and raw 16kHz PCM audio
wss.on("connection", (ws) => {
  console.log("✅ WebSocket connection established");

  ws.on("message", (message) => {
    // Raw 16kHz PCM audio chunks arrive here
    console.log(`📨 Received audio chunk: ${message.length} bytes`);

    // TODO: Add your AI transcription or processing logic here
  });

  ws.on("close", () => {
    console.log("❌ WebSocket connection closed");
  });

  ws.on("error", (err) => {
    console.error("⚠️ WebSocket error:", err);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
