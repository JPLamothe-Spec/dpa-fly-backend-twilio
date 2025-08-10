// index.js — Full duplex + optional 1-turn ASR (Whisper) -> GPT -> TTS reply
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const FormData = require("form-data");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static") || "ffmpeg";
require("dotenv").config();

// ESM-friendly fetch shim (avoids CommonJS crash with node-fetch v3)
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const { startPlaybackFromTTS, startPlaybackTone } = require("./tts");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// --- Twilio webhook: open full-duplex media stream
app.post("/twilio/voice", (req, res) => {
  const host = req.headers.host;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="wss://${host}/media-stream" track="both_tracks"/>
      </Connect>
    </Response>
  `.trim();
  res.type("text/xml").send(twiml);
});

// Health
app.get("/", (_req, res) => res.status(200).send("DPA backend is live"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/media-stream") {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  console.log("✅ Twilio WebSocket connected");

  let streamSid = null;
  let collecting = false;
  let buffers = [];
  let collectTimer = null;
  let greetingDone = false;

  ws.on("message", async (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
      case "connected":
        console.log("📞 Twilio media stream connected");
        break;

      case "start":
        streamSid = data.start?.streamSid || null;
        console.log(`🔗 Stream started. streamSid=${streamSid}`);

        // Greeting (Mode A tone if no key, Mode B OpenAI TTS if key)
        const greeting = "Hi, this is Anna, JP's digital personal assistant. Would you like me to pass on a message?";
        if (!process.env.OPENAI_API_KEY) {
          console.log("🔊 Playback mode: Tone (no OPENAI_API_KEY set)");
          startPlaybackTone({ ws, streamSid, logPrefix: "TONE" })
            .catch((e) => console.error("TTS/playback error (tone):", e?.message || e));
        } else {
          console.log("🔊 Playback mode: OpenAI TTS");
          startPlaybackFromTTS({
            ws, streamSid, text: greeting,
            voice: process.env.TTS_VOICE || "alloy",
            model: process.env.TTS_MODEL || "gpt-4o-mini-tts",
          }).catch((e) => console.error("TTS/playback error:", e?.message || e));
        }

        // Start a simple 1-turn collect → transcribe → reply cycle
        startCollecting();
        break;

      case "media":
        if (collecting && data?.media?.payload) {
          buffers.push(Buffer.from(data.media.payload, "base64"));
        }
        break;

      case "mark":
        // Twilio echoes marks after it finishes playing our audio
        console.log("📍 Twilio mark:", data?.mark?.name);
        if (data?.mark?.name === "tts-done" || data?.mark?.name === "TONE-done") {
          greetingDone = true;
        }
        break;

      case "stop":
        console.log("🛑 Twilio signaled stop — closing stream");
        try { ws.close(); } catch {}
        break;
    }
  });

  ws.on("close", () => console.log("❌ WebSocket closed"));
  ws.on("error", (err) => {
    console.error("⚠️ WebSocket error:", err?.message || err);
    try { ws.close(); } catch {}
  });

  function startCollecting() {
    collecting = true;
    buffers = [];
    if (collectTimer) clearTimeout(collectTimer);

    // Collect ~4s of caller speech, then process one-turn
    collectTimer = setTimeout(async () => {
      collecting = false;
      const mulaw = Buffer.concat(buffers);
      buffers = [];

      if (!mulaw.length) return;

      try {
        const wav16k = await convertMulaw8kToWav16k(mulaw);
        const transcript = await transcribeWithWhisper(wav16k);
        console.log("📝 Transcript:", transcript);

        const reply = await generateReply(transcript);
        console.log("🤖 GPT reply:", reply);

        // If greeting hasn't completed, wait briefly for mark; otherwise, continue.
        const waitUntil = Date.now() + 2000; // up to ~2s
        while (!greetingDone && Date.now() < waitUntil) {
          await new Promise(r => setTimeout(r, 50));
        }

        await startPlaybackFromTTS({
          ws, streamSid, text: reply,
          voice: process.env.TTS_VOICE || "alloy",
          model: process.env.TTS_MODEL || "gpt-4o-mini-tts",
        });
      } catch (e) {
        console.error("❌ ASR/Reply error:", e?.message || e);
      }
    }, 4000);
  }
});

// --- Helpers: audio convert + Whisper + GPT
function convertMulaw8kToWav16k(mulawBuffer) {
  return new Promise((resolve, reject) => {
    const args = [
      "-f", "mulaw",
      "-ar", "8000",
      "-ac", "1",
      "-i", "pipe:0",
      "-ar", "16000",
      "-ac", "1",
      "-f", "wav",
      "pipe:1",
    ];
    const p = spawn(ffmpegPath, args);
    const chunks = [];
    p.stdout.on("data", (b) => chunks.push(b));
    p.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg (mulaw->wav) exited ${code}`))
    );
    p.on("error", reject);
    p.stdin.end(mulawBuffer);
  });
}

async function transcribeWithWhisper(wavBuffer) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required for Whisper");
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", wavBuffer, { filename: "audio.wav", contentType: "audio/wav" });

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!resp.ok) throw new Error(`Whisper failed: ${resp.status} ${await resp.text().catch(() => "")}`);
  const json = await resp.json();
  return json.text || "";
}

async function generateReply(userText) {
  if (!process.env.OPENAI_API_KEY) return "Sorry, I didn’t catch that.";
  const system = "You are Anna, JP's friendly Australian digital assistant. Keep replies short and helpful.";
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.5,
      max_tokens: 120,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText || "The caller said nothing." }
      ],
    }),
  });
  if (!resp.ok) throw new Error(`Chat failed: ${resp.status} ${await resp.text().catch(() => "")}`);
  const json = await resp.json();
  return json.choices?.[0]?.message?.content?.trim() || "Okay.";
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on 0.0.0.0:${PORT}`);
});
