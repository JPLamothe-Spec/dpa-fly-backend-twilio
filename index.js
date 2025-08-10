// index.js — Full duplex + 1-turn ASR (Whisper) -> GPT -> TTS reply, with FAST cached greeting
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const FormData = require("form-data");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static") || "ffmpeg";
require("dotenv").config();

// Native-friendly fetch shim (node-fetch v3 in CJS)
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const {
  startPlaybackFromTTS,
  startPlaybackTone,
  warmGreeting,
  playCachedGreeting,
} = require("./tts");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const GREETING_TEXT =
  process.env.GREETING_TEXT ||
  "Hi, this is Anna, JP's digital personal assistant. Would you like me to pass on a message?";
const TTS_VOICE = process.env.TTS_VOICE || "alloy";
const TTS_MODEL = process.env.TTS_MODEL || "gpt-4o-mini-tts";

// --- Twilio webhook: open full-duplex media stream
app.post("/twilio/voice", (req, res) => {
  console.log("➡️ /twilio/voice hit");
  const host = req.headers.host;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="wss://${host}/media-stream"/>
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

  // collection state
  let collecting = false;
  let buffers = [];
  let collectTimer = null;
  let greetingDone = false;
  let collectAttempts = 0;

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

        if (!process.env.OPENAI_API_KEY) {
          console.log("🔊 Playback mode: Tone (no OPENAI_API_KEY set)");
          startPlaybackTone({ ws, streamSid, logPrefix: "TONE" })
            .catch((e) => console.error("TTS/playback error (tone):", e?.message || e));
        } else {
          console.log("🔊 Playback mode: OpenAI TTS (cached)");
          // Play cached greeting immediately; fallback to live TTS if not warmed yet
          playCachedGreeting({
            ws,
            streamSid,
            text: GREETING_TEXT,
            voice: TTS_VOICE,
            model: TTS_MODEL,
          }).catch((e) => console.error("TTS/playback error:", e?.message || e));
        }

        // IMPORTANT: wait for greeting mark before starting the 1st collect window
        stopCollecting(); // ensure clean slate
        break;

      case "media":
        if (collecting && data?.media?.payload) {
          buffers.push(Buffer.from(data.media.payload, "base64"));
        }
        break;

      case "mark":
        console.log("📍 Twilio mark:", data?.mark?.name);
        if ((data?.mark?.name === "tts-done" || data?.mark?.name === "TONE-done") && !greetingDone) {
          greetingDone = true;
          // Start a fresh 4s collection NOW that the greeting finished
          startCollectingWindow(4000);
        }
        break;

      case "stop":
        console.log("🛑 Twilio signaled stop — closing stream");
        try { ws.close(); } catch {}
        break;
    }
  });

  ws.on("close", () => {
    stopCollecting();
    console.log("❌ WebSocket closed");
  });

  ws.on("error", (err) => {
    console.error("⚠️ WebSocket error:", err?.message || err);
    try { ws.close(); } catch {}
  });

  function startCollectingWindow(ms) {
    stopCollecting(); // reset any previous window
    collecting = true;
    buffers = [];
    collectAttempts += 1;

    collectTimer = setTimeout(async () => {
      collecting = false;
      const mulaw = Buffer.concat(buffers);
      buffers = [];

      // If near-empty or likely silence, one retry with a longer window
      const isLikelySilence = mulaw.length < 160 * 10; // < ~200ms of audio
      if (isLikelySilence && collectAttempts < 2) {
        console.log("🤫 Low audio captured — extending collection window");
        return startCollectingWindow(5000);
      }

      try {
        const wav16k = await convertMulaw8kToWav16k(mulaw);
        const transcript = await transcribeWithWhisper(wav16k);
        console.log("📝 Transcript:", transcript);

        const reply = await generateReply(transcript);
        console.log("🤖 GPT reply:", reply);

        await startPlaybackFromTTS({
          ws, streamSid, text: reply,
          voice: TTS_VOICE,
          model: TTS_MODEL,
        });

        // (Optional) queue another collection window for a second turn
        collectAttempts = 0;
        startCollectingWindow(5000);
      } catch (e) {
        console.error("❌ ASR/Reply error:", e?.message || e);
      }
    }, ms);
  }

  function stopCollecting() {
    collecting = false;
    buffers = [];
    if (collectTimer) {
      clearTimeout(collectTimer);
      collectTimer = null;
    }
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

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`🚀 Server running on 0.0.0.0:${PORT}`);
  // Warm the greeting cache at boot so greeting plays immediately on first call
  if (process.env.OPENAI_API_KEY) {
    try {
      await warmGreeting({ text: GREETING_TEXT, voice: TTS_VOICE, model: TTS_MODEL });
    } catch {}
  }
});
