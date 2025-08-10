// index.js — Twilio <Stream> -> inline ffmpeg (mulaw@8k -> pcm_s16le@16k)
// + Live transcription (Whisper) + DPA brain (GPT-4o-mini)
// + End-of-call summary (optional email via SendGrid)

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");         // npm i ffmpeg-static
const OpenAI = require("openai");                    // npm i openai
const { toFile } = require("openai/uploads");
const sgMail = (() => { try { return require("@sendgrid/mail"); } catch { return null; } })(); // npm i @sendgrid/mail
require("dotenv").config();

const PORT = process.env.PORT || 3000;
const app = express();

// 🔊 request logging
app.use((req, _res, next) => {
  console.log(`➡️  ${req.method} ${req.originalUrl} Host:${req.headers.host}`);
  next();
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health checks
app.get("/", (_req, res) => res.status(200).send("DPA backend (Twilio inline ffmpeg) is live ✅"));
app.get("/twilio/voice", (_req, res) => res.status(200).send("Twilio voice webhook endpoint is live."));

// Twilio webhook: answer and start Media Stream
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

// HTTP + WS (manual upgrade)
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
  const byteRate = 16000 * 2; // 16k * 16-bit mono
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
  } catch (e) {
    console.error("🛑 DPA (GPT) error:", e?.message || e);
  }
}

// End-of-call summary
async function summarizeCall(transcript) {
  if (!transcript?.trim()) return null;
  const system = `You are Anna, JP's Australian Digital Personal Assistant.
Summarize crisply as strict JSON:
{"summary":"...", "sentiment":"positive|neutral|negative",
 "urgency":"low|med|high", "entities":{...}, "action_items":["..."]}`;
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Full transcript:\n${transcript}` }
    ]
  });
  const text = res.choices?.[0]?.message?.content || "";
  console.log("🧾 Call Summary:", text);
  return text;
}

// Optional email via SendGrid
async function emailSummary(subject, html) {
  try {
    if (!sgMail) return;
    const apiKey = process.env.SENDGRID_API_KEY;
    const to = process.env.SUMMARY_TO_EMAIL || "jplamothe15@gmail.com";
    const from = process.env.SUMMARY_FROM_EMAIL; // e.g. no-reply@digitalpa.io (verified in SendGrid)
    if (!apiKey || !to || !from) {
      console.log("📭 Email skipped (missing SENDGRID_API_KEY or SUMMARY_TO_EMAIL or SUMMARY_FROM_EMAIL).");
      return;
    }
    sgMail.setApiKey(apiKey);
    await sgMail.send({ to, from, subject, html });
    console.log("📧 Summary emailed to", to);
  } catch (e) {
    console.error("Email error:", e?.message || e);
  }
}

// ---------- media stream handling ----------
function startInlineFfmpeg() {
  // ffmpeg -f mulaw -ar 8000 -ac 1 -i pipe:0 -f s16le -ar 16000 -ac 1 pipe:1
  const ff = spawn(ffmpegPath, [
    "-f", "mulaw", "-ar", "8000", "-ac", "1", "-i", "pipe:0",
    "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1"
  ], { stdio: ["pipe", "pipe", "inherit"] });

  ff.on("error", (e) => console.error("❌ ffmpeg error:", e));
  ff.on("close", (code, signal) => console.log(`🧹 ffmpeg closed (code=${code} signal=${signal})`));
  return ff;
}

wss.on("connection", (ws) => {
  console.log("✅ WebSocket connection established");

  const ff = startInlineFfmpeg();

  // ~1s chunks to Whisper (at 16kHz * 2 bytes = ~32KB/s)
  const TARGET_BYTES = 32000;
  let runningTranscript = "";
  let pcmChunkBuffer = [];
  let pcmChunkBytes = 0;
  let flushInFlight = false;

  // guard so we don't flush after call ends
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
        dpaThink({ latestText, runningTranscript }).catch(() => {});
      }
    } catch (e) {
      console.error("flushChunk error:", e);
    } finally {
      flushInFlight = false;
    }
  }

  ff.stdout.on("data", (chunk) => {
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
        console.log("📞 Twilio media stream connected"); break;
      case "start":
        console.log(`🔗 Stream started. streamSid=${data.start?.streamSid || "unknown"}`); break;
      case "media": {
        const b64 = data.media?.payload;
        if (!b64) return;
        const mulaw = Buffer.from(b64, "base64");
        const ok = ff.stdin.write(mulaw);
        if (!ok) { ws.pause?.(); ff.stdin.once("drain", () => ws.resume?.()); }
        break;
      }
      case "mark": break;
      case "stop": {
        console.log("🛑 Twilio signaled stop — closing stream");
        closing = true;
        try { ff.stdin.end(); } catch {}
        (async () => {
          try {
            // final flush
            await flushChunk();
            if (runningTranscript?.trim()) {
              const summary = await summarizeCall(runningTranscript);
              await emailSummary("DPA Call Summary", `<pre>${summary}</pre>`);
            } else {
              console.log("🧾 No transcript collected; skipping summary.");
            }
          } catch (e) {
            console.error("Finalization error:", e);
          } finally {
            try { ws.close(); } catch {}
          }
        })();
        break;
      }
      default: break;
    }
  });

  ws.on("close", () => {
    console.log("❌ WebSocket connection closed");
    closing = true;
    try { ff.stdin.end(); } catch {}
  });

  ws.on("error", (err) => {
    console.error("⚠️ WebSocket error:", err);
    closing = true;
    try { ff.stdin.end(); } catch {}
    try { ws.close(); } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
