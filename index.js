// index.js — Twilio <Stream> -> inline ffmpeg (mulaw@8k -> pcm_s16le@16k)
// + Live transcription (Whisper) + DPA brain (GPT-4o-mini). No transcoder.js needed.

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");         // npm i ffmpeg-static
const OpenAI = require("openai");                    // npm i openai
const { toFile } = require("openai/uploads");        // helper to send Buffer as a file
require("dotenv").config();

const PORT = process.env.PORT || 3000;
const app = express();

// --- noisy request logging to help live-debug
app.use((req, _res, next) => {
  console.log(`➡️  ${req.method} ${req.originalUrl} Host:${req.headers.host}`);
  next();
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- Health checks
app.get("/", (_req, res) => res.status(200).send("DPA backend (Twilio inline ffmpeg) is live ✅"));
app.get("/twilio/voice", (_req, res) => res.status(200).send("Twilio voice webhook endpoint is live."));

// --- Twilio webhook: answer and start Media Stream
app.post("/twilio/voice", (req, res) => {
  const host = req.headers.host;
  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${host}/media-stream" track="inbound_track" />
      </Start>
      <Pause length="60"/>
    </Response>
  `.trim();

  res.set("Content-Type", "text/xml");
  res.set("Content-Length", Buffer.byteLength(twiml, "utf8").toString());
  res.status(200).send(twiml);
});

// --- HTTP server + WS (manual upgrade so path is flexible on Fly)
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/media-stream") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});

// ---------- AI bits (Whisper + GPT-4o-mini) ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// tiny wav header helper for 16k mono s16le (PCM) buffers
function pcmToWav16kMono(pcmBuffer) {
  const byteRate = 16000 * 2; // 16k * 16-bit mono bytes/sec
  const blockAlign = 2;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);         // PCM header size
  header.writeUInt16LE(1, 20);          // PCM format
  header.writeUInt16LE(1, 22);          // channels: mono
  header.writeUInt32LE(16000, 24);      // sample rate
  header.writeUInt32LE(byteRate, 28);   // byte rate
  header.writeUInt16LE(blockAlign, 32); // block align
  header.writeUInt16LE(16, 34);         // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

async function transcribeChunk(pcmChunk) {
  try {
    const wav = pcmToWav16kMono(pcmChunk);
    const file = await toFile(wav, "chunk.wav", { type: "audio/wav" });
    const tx = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1"
    });
    const text = tx?.text?.trim();
    if (text) console.log("📝 Whisper:", text);
    return text || "";
  } catch (e) {
    console.error("🛑 Whisper error:", e?.message || e);
    return "";
  }
}

async function dpaThink({ latestText, runningTranscript }) {
  try {
    const system = `You are Anna, JP's friendly Australian Digital Personal Assistant.
Keep replies short, warm, and proactive. Extract intent and suggested next action as JSON like:
{"assistant_reply":"...", "intent":"...", "entities":{...}, "urgency":"low|med|high"}`;
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Latest caller text: "${latestText}"\nRunning transcript: "${runningTranscript}"` }
      ]
    });
    const text = res.choices?.[0]?.message?.content || "";
    if (text) console.log("🤖 DPA:", text);
  } catch (e) {
    console.error("🛑 DPA (GPT) error:", e?.message || e);
  }
}

// ---------- media stream handling ----------
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
  ff.on("close", (code, signal) => console.log(`🧹 ffmpeg closed (code=${code} signal=${signal})`));
  return ff;
}

wss.on("connection", (ws) => {
  console.log("✅ WebSocket connection established");

  const ff = startInlineFfmpeg();

  // --- chunking 16k PCM to ~2s windows for Whisper ---
  let runningTranscript = "";
  let pcmChunkBuffer = [];
  let pcmChunkBytes = 0;
  let flushInFlight = false;
  const TARGET_BYTES = 32000 * 2; // ~= 2 seconds (32kB/sec * 2)

  async function flushChunk() {
    if (flushInFlight) return;
    flushInFlight = true;
    try {
      const chunk = Buffer.concat(pcmChunkBuffer);
      pcmChunkBuffer = [];
      pcmChunkBytes = 0;
      if (chunk.length === 0) return;

      const latestText = await transcribeChunk(chunk);
      if (latestText) {
        runningTranscript += (runningTranscript ? " " : "") + latestText;
        // think about the delta (keeps things snappy)
        dpaThink({ latestText, runningTranscript }).catch(() => {});
      }
    } catch (e) {
      console.error("flushChunk error:", e);
    } finally {
      flushInFlight = false;
    }
  }

  // the transcoded PCM16k stream from ffmpeg
  ff.stdout.on("data", (chunk) => {
    // optional: observe PCM flow
    // console.log(`🎧 PCM16k chunk: ${chunk.length} bytes`);
    pcmChunkBuffer.push(chunk);
    pcmChunkBytes += chunk.length;
    if (pcmChunkBytes >= TARGET_BYTES) {
      flushChunk().catch(() => {});
    }
  });

  ws.on("message", (msg) => {
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
        const b64 = data.media?.payload;
        if (!b64) return;
        const mulaw = Buffer.from(b64, "base64");
        const ok = ff.stdin.write(mulaw);
        if (!ok) {
          ws.pause?.();
          ff.stdin.once("drain", () => ws.resume?.());
        }
        break;
      }

      case "mark":
        break;

      case "stop":
        console.log("🛑 Twilio signaled stop — closing stream");
        try { ff.stdin.end(); } catch {}
        // flush any remaining audio for a last transcript slice
        flushChunk().finally(() => ws.close());
        break;

      default:
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
