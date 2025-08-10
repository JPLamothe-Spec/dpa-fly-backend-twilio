const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
require("dotenv").config();

const { handleStream } = require("./stream-handler");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

// ✅ Health check endpoint for Fly.io
app.get("/health", (req, res) => res.send("ok"));

// ✅ Basic landing endpoint
app.get("/", (req, res) => res.send("DPA backend (Twilio inline ffmpeg) is live ✅"));

// ✅ Twilio webhook to start streaming
app.post("/twilio/voice", (req, res) => {
  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${req.headers.host}/media-stream" track="inbound_track" />
      </Start>
      <Pause length="60"/>
    </Response>
  `;
  res.type("text/xml");
  res.send(twiml.trim());
});

// ✅ HTTP server + WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/media-stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      console.log("✅ Twilio WebSocket connected");
      handleStream(ws);
    });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
