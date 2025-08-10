// index.js — Twilio <Stream> -> inline ffmpeg (mulaw@8k -> pcm_s16le@16k), no transcoder.js

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static"); // install: npm i ffmpeg-static
require("dotenv").config();

const PORT = process.env.PORT || 3000;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- Health checks
app.get("/", (_req, res) => res.status(200).send("DPA backend (Twilio inline ffmpeg) is live ✅"));
app.get("/twilio/voice", (_req, res) => res.status(200).send("Twilio voice webhook endpoint is live."));

// --- Twilio webhook: answer and start Media Stream
app.post("/twilio/voice", (req, res) => {
  // Keep the call open with a Pause so the stream can flow
  const host = req.headers.host;
  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${host}/media-stream" track="inbound_track" />
      </Start>
      <Pause length="30"/>
    </Response>
  `.trim();

  res.set("Content-Type", "text/xml");
  res.set("Content-Length", Buffer.byteLength(twiml, "utf8").toString());
  res.status(200).send(twiml);
});

// --- HTTP server + WS (manual upgrade so path is flexible on Fly)
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Utility: start one ffmpeg process per call to upsample μ-law 8k -> PCM s16le 16k
function startInlineFfmpeg() {
  // ffmpeg -f mulaw -ar 8000 -ac 1 -i pipe:0 -f s16le -ar 16000 -ac 1 pipe:1
  const ff = spawn(ffmpegPath, [
    "-f", "mulaw",
    "-ar", "8000",
    "-ac", "1",
    "-i", "pipe:0",
    "-f", "s16le",
    "-ar", "16000",
    "-ac", "1",
    "pipe:1"
  ], { stdio: ["pipe", "pipe", "inherit"] });

  ff.on("error", (e) => console.error("❌ ffmpeg error:", e));
  ff.on("close", (code, signal) => {
    console.log(`🧹 ffmpeg closed (code=${code} signal=${signal})`);
  });

  return ff;
}

// Placeholder: wire your 16k PCM to GPT or another engine here
function onPcm16000(buffer) {
  // TODO: stream buffer to your AI engine
  // For now we’ll just log the size occasionally
  console.log(`🎧 PCM16k chunk: ${buffer.length} bytes`);
}

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/media-stream") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws, req) => {
  console.log("✅ WebSocket connection established");

  // ffmpeg pipeline for this call
  const ff = startInlineFfmpeg();

  // Pump transcoded PCM16k to handler
  ff.stdout.on("data", (chunk) => onPcm16000(chunk));

  ws.on("message", (msg) => {
    // Twilio sends JSON frames (connected, start, media, mark, stop)
    let data;
    try {
      data = JSON.parse(msg.toString("utf8"));
    } catch (e) {
      console.error("⚠️ Non-JSON WS frame:", e);
      return;
    }

    switch (data.event) {
      case "connected":
        console.log("📞 Twilio media stream connected");
        break;

      case "start":
        console.log(`🔗 Stream started. streamSid=${data.start?.streamSid || "unknown"}`);
        break;

      case "media": {
        // Base64 μ-law @8kHz audio
        const b64 = data.media?.payload;
        if (!b64) return;
        const mulaw = Buffer.from(b64, "base64");
        // Write μ-law bytes to ffmpeg stdin; it will output PCM16k on stdout
        const ok = ff.stdin.write(mulaw);
        if (!ok) {
          // Backpressure (rare with these sizes) — pause WS a tick
          ws.pause?.();
          ff.stdin.once("drain", () => ws.resume?.());
        }
        break;
      }

      case "mark":
        // optional: handle your own progress markers
        break;

      case "stop":
        console.log("🛑 Twilio signaled stop — closing stream");
        try { ff.stdin.end(); } catch {}
        ws.close();
        break;

      default:
        // ignore
        break;
    }
  });

  ws.on("close", () => {
    console.log("❌ WebSocket connection closed");
    try { ff.stdin.end(); } catch {}
  });

  ws.on("error", (err) => {
    console.error("⚠️ WebSocket error:", err);
    try { ff.stdin.end(); } catch {}
    try { ws.close(); } catch {}
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
