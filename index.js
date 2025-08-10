// index.js — Twilio <Connect><Stream> full duplex
// Inbound: μ-law@8k -> ffmpeg -> PCM s16le@16k -> Whisper -> GPT
// Outbound: GPT reply -> OpenAI TTS -> μ-law@8k -> send back to Twilio

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
app.get("/", (_req, res) =>
  res.status(200).send("DPA backend (Twilio full-duplex) is live ✅")
);
app.get("/twilio/voice", (_req, res) =>
  res.status(200).send("Twilio voice webhook endpoint is live.")
);

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
  wss.handleUpgrade(request, socket, head, (ws) =>
    wss.emit("connection", ws, request)
  );
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
    const tx = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
    });
    const text = tx?.text?.trim() || "";
    if (text) console.log("📝 Whisper:", text);
    return text;
  } catch (e) {
    console.error("🛑 Whisper error:", e?.message || e);
    return "";
  }
}

async function dpaThink({ latestText, runningTranscript }) {
  try {
    const system = `You are Anna, JP's friendly Australian Digital Personal Assistant.
Keep replies short, warm, and proactive. Extract intent and suggested next action as strict JSON:
{"assistant_reply":"...", "intent":"...", "entities":{...}, "urgency":"low|med|high"}`;
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Latest caller text: "${latestText}"\nRunning transcript: "${runningTranscript}"`,
        },
      ],
    });
    const text = res.choices?.[0]?.message?.content || "";
    if (text) console.log("🤖 DPA:", text);

    // Try to pull JSON and get assistant_reply; fallback to whole text
    let reply = text;
    try {
      const match = text.match(/\{[\s\S]*\}$/);
      if (match) reply = JSON.parse(match[0]).assistant_reply || text;
    } catch {}
    return reply;
  } catch (e) {
    console.error("🛑 DPA (GPT) error:", e?.message || e);
    return "";
  }
}

// ---------- Inbound audio pipeline (μ-law→PCM16k) ----------
function startMulaw8kToPcm16k() {
  const ff = spawn(ffmpegPath, [
    "-f", "mulaw", "-ar", "8000", "-ac", "1", "-i", "pipe:0",
    "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1",
  ], { stdio: ["pipe", "pipe", "inherit"] });
  ff.on("error", (e) => console.error("❌ ffmpeg (inbound) error:", e));
  ff.on("close", (c, s) => console.log(`🧹 ffmpeg inbound closed (code=${c} signal=${s})`));
  return ff;
}

// ---------- WS handling ----------
wss.on("connection", (ws) => {
  console.log("✅ WebSocket connection established");

  let streamSid = null;
  const inboundFfmpeg = startMulaw8kToPcm16k();
  const tts = new TtsSender(ws);

  // ~1s chunking for transcription
  const TARGET_BYTES = 32000; // 1s @ 16k*2
  let runningTranscript = "";
  let pcmChunkBuffer = [];
  let pcmChunkBytes = 0;
  let flushInFlight = false;
  let closing = false;

  async function flushChunk() {
    if (closing || flushInFlight) return;
    flushInFlight = true;
    try {
      const chunk = Buffer.concat(pcmChunkBuffer);
      pcmChunkBuffer = [];
      pcmChunkBytes = 0;
      if (chunk.length === 0) return;

      const latestText = await transcribeChunk(chunk);
      if (latestText) {
        runningTranscript += (runningTranscript ? " " : "") + latestText;
        const reply = await dpaThink({ latestText, runningTranscript });
        if (reply) tts.speak(reply);
      }
    } catch (e) {
      console.error("flushChunk error:", e);
    } finally {
      flushInFlight = false;
    }
  }

  inboundFfmpeg.stdout.on("data", (chunk) => {
    pcmChunkBuffer.push(chunk);
    pcmChunkBytes += chunk.length;
    if (pcmChunkBytes >= TARGET_BYTES) flushChunk().catch(() => {});
  });

  ws.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString("utf8")); }
    catch (e) { console.error("⚠️ Non-JSON WS frame:", e); return; }

    switch (data.event) {
      case "connected":
        console.log("📞 Twilio media stream connected");
        break;

      case "start":
        streamSid = data.start?.streamSid;
        tts.setStreamSid(streamSid);
        console.log(`🔗 Stream started. streamSid=${streamSid || "unknown"}`);
        // Optional greeting:
        // tts.speak("Hi, this is Anna. How can I help today?");
        break;

      case "media": {
        const b64 = data.media?.payload;
        if (!b64) return;
        const mulaw = Buffer.from(b64, "base64");
        const ok = inboundFfmpeg.stdin.write(mulaw);
        if (!ok) {
          ws.pause?.();
          inboundFfmpeg.stdin.once("drain", () => ws.resume?.());
        }
        break;
      }

      case "mark":
        console.log(`✔️ Playback mark received: ${data.mark?.name || ""}`);
        break;

      case "stop":
        console.log("🛑 Twilio signaled stop — closing stream");
        closing = true;
        try { inboundFfmpeg.stdin.end(); } catch {}
        (async () => {
          try { await flushChunk(); } catch {}
          try { ws.close(); } catch {}
        })();
        break;

      default:
        break;
    }
  });

  ws.on("close", () => {
    console.log("❌ WebSocket connection closed");
    closing = true;
    try { inboundFfmpeg.stdin.end(); } catch {}
  });

  ws.on("error", (err) => {
    console.error("⚠️ WebSocket error:", err);
    closing = true;
    try { inboundFfmpeg.stdin.end(); } catch {}
    try { ws.close(); } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
