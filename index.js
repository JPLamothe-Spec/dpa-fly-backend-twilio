// index.js — Twilio <Connect><Stream> (bidirectional)
// Inbound: μ-law@8k -> ffmpeg -> PCM s16le@16k -> Whisper -> DPA (GPT-4o-mini)
// Outbound: DPA reply -> OpenAI TTS (wav/16k) -> ffmpeg -> μ-law@8k -> send to Twilio WS

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");
require("dotenv").config();

const PORT = process.env.PORT || 3000;
const app = express();

app.use((req, _res, next) => {
  console.log(`➡️  ${req.method} ${req.originalUrl} Host:${req.headers.host}`);
  next();
});
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- Health
app.get("/", (_req, res) => res.status(200).send("DPA backend (Twilio bidirectional) is live ✅"));
app.get("/twilio/voice", (_req, res) => res.status(200).send("Twilio voice webhook endpoint is live."));

// --- Twilio webhook: bidirectional stream
app.post("/twilio/voice", (req, res) => {
  const host = req.headers.host;
  // Bidirectional: <Connect><Stream/>
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

// --- HTTP server + WS upgrade
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/media-stream") return socket.destroy();
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});

// ---------- OpenAI clients ----------
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
        { role: "user", content: `Latest caller text: "${latestText}"\nRunning transcript: "${runningTranscript}"` }
      ]
    });
    const text = res.choices?.[0]?.message?.content || "";
    if (text) console.log("🤖 DPA:", text);
    // Try to parse a JSON block from the content; fallback to whole text
    let assistantReply = text;
    try {
      const match = text.match(/\{[\s\S]*\}$/);
      if (match) {
        const j = JSON.parse(match[0]);
        assistantReply = j.assistant_reply || text;
      }
    } catch {}
    return assistantReply;
  } catch (e) {
    console.error("🛑 DPA (GPT) error:", e?.message || e);
    return "";
  }
}

// ---------- Audio pipelines ----------
function startMulaw8kToPcm16k() {
  // In: μ-law@8k (pipe:0)  Out: s16le@16k (pipe:1)
  const ff = spawn(ffmpegPath, [
    "-f", "mulaw", "-ar", "8000", "-ac", "1", "-i", "pipe:0",
    "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1"
  ], { stdio: ["pipe", "pipe", "inherit"] });
  ff.on("error", (e) => console.error("❌ ffmpeg (inbound) error:", e));
  ff.on("close", (c, s) => console.log(`🧹 ffmpeg inbound closed (code=${c} signal=${s})`));
  return ff;
}

async function ttsToMulaw8k(text) {
  // 1) synthesize with OpenAI TTS -> WAV/16k mono
  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: text,
    format: "wav"
  });
  const wavBuf = Buffer.from(await speech.arrayBuffer());

  // 2) ffmpeg: WAV/16k -> raw μ-law@8k (headerless)
  return await new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      "-f", "wav", "-i", "pipe:0",
      "-f", "mulaw", "-ar", "8000", "-ac", "1", "pipe:1"
    ], { stdio: ["pipe", "pipe", "inherit"] });

    const chunks = [];
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg outbound exited ${code}`));
    });

    ff.stdin.end(wavBuf);
  });
}

// break a μ-law buffer into ~20ms frames (160 bytes at 8kHz)
function* frameMulaw(mu) {
  const FRAME = 160; // 20ms
  for (let i = 0; i < mu.length; i += FRAME) {
    yield mu.subarray(i, Math.min(i + FRAME, mu.length));
  }
}

// ---------- WS handling ----------
wss.on("connection", (ws) => {
  console.log("✅ WebSocket connection established");

  let streamSid = null;
  const inboundFfmpeg = startMulaw8kToPcm16k();

  // live transcript buffering (~1s)
  const TARGET_BYTES = 32000; // 1s @ 16k*2
  let runningTranscript = "";
  let pcmChunkBuffer = [];
  let pcmChunkBytes = 0;
  let flushInFlight = false;
  let closing = false;

  // Outbound audio queue (so we don't overlap)
  const speakQueue = [];
  let speaking = false;
  let markCounter = 0;

  function sendToTwilio(json) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(json));
  }

  async function speak(text) {
    if (!text?.trim()) return;
    speakQueue.push(text);
    if (speaking) return;
    speaking = true;
    while (speakQueue.length && !closing) {
      const utterance = speakQueue.shift();
      try {
        // Synthesize + convert
        const mu = await ttsToMulaw8k(utterance);
        // Send frames (Twilio buffers; headerless μ-law/8k base64) + mark
        for (const fr of frameMulaw(mu)) {
          sendToTwilio({
            event: "media",
            streamSid,
            media: { payload: fr.toString("base64") }
          });
        }
        const name = `utt-${++markCounter}`;
        sendToTwilio({ event: "mark", streamSid, mark: { name } });
      } catch (e) {
        console.error("TTS send error:", e?.message || e);
      }
    }
    speaking = false;
  }

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
        if (reply) speak(reply).catch(() => {});
      }
    } catch (e) {
      console.error("flushChunk error:", e);
    } finally {
      flushInFlight = false;
    }
  }

  // inbound pipeline: μ-law -> PCM16k -> chunk -> Whisper/GPT
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
        console.log(`🔗 Stream started. streamSid=${streamSid || "unknown"} tracks=${(data.start?.tracks||[]).join(",")}`);
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
        // Twilio sends this back after it finishes playing what we sent.
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
