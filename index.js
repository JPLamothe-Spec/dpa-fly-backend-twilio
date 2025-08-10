// index.js — Twilio <Connect><Stream> full duplex
// Inbound: μ-law@8k -> ffmpeg -> PCM s16le@16k -> Whisper -> DPA (GPT-4o-mini)
// Outbound: DPA reply -> OpenAI TTS -> μ-law@8k -> send over Twilio WS

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");
const { TtsSender } = require("./tts");
require("dotenv").config();

const PORT = process.env.PORT || 3000;
const app = express();

app.use((req, _res, next) => {
  console.log(`➡️  ${req.method} ${req.originalUrl} Host:${req.headers.host}`);
  next();
});
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health
app.get("/", (_req, res) => res.status(200).send("DPA backend (Twilio full-duplex) is live ✅"));
app.get("/twilio/voice", (_req, res) => res.status(200).send("Twilio voice webhook endpoint is live."));

// Twilio webhook → bidirectional stream
app.post("/twilio/voice", (req, res) => {
  const host = req.headers.host;
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
  if (request.url !== "/media-stream") return socket.destroy();
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});

// ---------- OpenAI ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// WAV header for 16k mono s16le
function pcmToWav16kMono(pcmBuffer) {
  const byteRate = 16000 * 2;
  const blockAlign = 2;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

async function transcribeChunk(pcmChunk) {
  try {
    const wav = pcmToWav16kMono(pcmChunk);
    const file = await toFile(wav, "chunk.wav", { type: "audio/wav" });
    const tx = await openai.audio.transcriptions.create({ file, model: "whisper-1" });
    const text = tx?.text?.trim() || "";
    if (text) console.log("📝 Whisper:", text);
    return text;
  } catch (e) {
    console.error("🛑 Whisper error:", e?.message || e);
    return "";
  }
}

async function dpaThink({ latestText, runningTransc
