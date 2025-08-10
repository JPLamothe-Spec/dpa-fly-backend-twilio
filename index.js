// index.js — Twilio <Connect><Stream> full duplex (keeps health + 0.0.0.0 bind)
require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Health & root
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.status(200).send("DPA backend (Twilio full-duplex) is live ✅"));

// Twilio webhook → switch to CONNECT/STREAM so Twilio will play our audio back
app.post("/twilio/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="wss://${host}/media-stream" />
      </Connect>
    </Response>
  `.trim();
  res.set("Content-Type", "text/xml");
  res.set("Content-Length", Buffer.byteLength(twiml, "utf8").toString());
  res.status(200).send(twiml);
});

// HTTP server + WS upgrade
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  try {
    if (request.url !== "/media-stream") { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, async (ws) => {
      console.log("✅ Twilio WebSocket connected");

      // Lazy-load stream handler to keep boot safe
      let handleStream;
      try { ({ handleStream } = require("./stream-handler")); }
      catch (e) { console.error("❌ Failed to load stream-handler:", e); ws.close(); return; }

      try { handleStream(ws); }
      catch (e) { console.error("❌ handleStream crashed:", e); try { ws.close(); } catch {} }
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

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));
