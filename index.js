// index.js — Full duplex with cached fast greeting + robust barge-in + 1-turn ASR (Whisper) -> GPT -> TTS reply
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const FormData = require("form-data");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static") || "ffmpeg";
require("dotenv").config();

// ESM-friendly fetch shim
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const {
  startPlaybackFromTTS,
  startPlaybackTone,
  warmGreeting,
  playCachedGreeting,
  TtsController,
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

// ---------- μ-law energy (for barge-in) ----------
function ulawEnergy(buf) {
  let acc = 0;
  for (let i = 0; i < buf.length; i++) acc += Math.abs(buf[i] - 0x7f);
  return acc / buf.length; // ~0..128 (rough)
}
// More conservative to avoid line-noise false positives:
const SPEECH_THRESH = Number(process.env.BARGE_IN_THRESH || 18);
const HOT_FRAMES = Number(process.env.BARGE_IN_FRAMES || 6); // ~120ms @ 20ms frames
const SILENCE_BEFORE_REPLY_MS = Number(process.env.SILENCE_BEFORE_REPLY_MS || 400);

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

// ---- Single WebSocket server + single upgrade handler
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

  // Conversation state
  let collecting = false;
  let buffers = [];
  let collectTimer = null;
  let greetingDone = false;
  let collectAttempts = 0;
  let ttsController = null;
  let lastSpeechAt = 0;

  // Barge-in gating
  let allowBargeIn = false;      // disabled during greeting
  let speechHotCount = 0;        // consecutive hot frames
  let greetingSafetyTimer = null;

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

        // Greet
        if (!process.env.OPENAI_API_KEY) {
          console.log("🔊 Playback mode: Tone (no OPENAI_API_KEY set)");
          ttsController = new TtsController();
          startPlaybackTone({ ws, streamSid, logPrefix: "TONE", controller: ttsController })
            .catch((e) => console.error("TTS/playback error (tone):", e?.message || e));
        } else {
          console.log("🔊 Playback mode: OpenAI TTS (cached)");
          ttsController = new TtsController();
          playCachedGreeting({
            ws, streamSid,
            text: GREETING_TEXT,
            voice: TTS_VOICE,
            model: TTS_MODEL,
            controller: ttsController,
          }).catch((e) => console.error("TTS/playback error:", e?.message || e));
        }

        // While greeting is playing, barge-in is disabled
        allowBargeIn = false;
        greetingDone = false;
        stopCollecting();

        // Safety: if Twilio never echoes mark, enable listening after ~2.5s
        if (greetingSafetyTimer) clearTimeout(greetingSafetyTimer);
        greetingSafetyTimer = setTimeout(() => {
          if (!greetingDone) {
            console.log("⏱️ Greeting safety timeout — enabling barge-in & listening");
            allowBargeIn = true;
            greetingDone = true;
            startCollectingWindow(4500);
          }
        }, 2500);
        break;

      case "media":
        if (data?.media?.payload) {
          const chunk = Buffer.from(data.media.payload, "base64");

          // Barge-in detection (only if enabled)
          if (allowBargeIn) {
            const e = ulawEnergy(chunk);
            if (e > SPEECH_THRESH) {
              speechHotCount = Math.min(HOT_FRAMES + 1, speechHotCount + 1);
              lastSpeechAt = Date.now();
              if (speechHotCount >= HOT_FRAMES) {
                if (ttsController && !ttsController.cancelled) {
                  ttsController.cancel();
                  console.log("🔇 Barge-in: caller speech detected — cancelling TTS");
                }
                // If greeting hadn't finished, switch to listening immediately
                if (!greetingDone) {
                  greetingDone = true;
                  startCollectingWindow(4500);
                }
              }
            } else {
              // cool down quickly to avoid sticky state
              speechHotCount = Math.max(0, speechHotCount - 2);
            }
          }

          if (collecting) buffers.push(chunk);
        }
        break;

      case "mark":
        console.log("📍 Twilio mark:", data?.mark?.name);
        if ((data?.mark?.name === "tts-done" || data?.mark?.name === "TONE-done") && !greetingDone) {
          greetingDone = true;
          allowBargeIn = true;               // enable barge-in AFTER greeting is done
          if (greetingSafetyTimer) { clearTimeout(greetingSafetyTimer); greetingSafetyTimer = null; }
          startCollectingWindow(4000);        // begin first listen window
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
    if (greetingSafetyTimer) { clearTimeout(greetingSafetyTimer); greetingSafetyTimer = null; }
    console.log("❌ WebSocket closed");
  });

  ws.on("error", (err) => {
    console.error("⚠️ WebSocket error:", err?.message || err);
    try { ws.close(); } catch {}
  });

  // ----- Collect → ASR → GPT → TTS reply -----
  function startCollectingWindow(ms) {
    stopCollecting(); // reset
    collecting = true;
    buffers = [];
    collectAttempts += 1;

    collectTimer = setTimeout(async () => {
      collecting = false;
      const mulaw = Buffer.concat(buffers);
      buffers = [];

      // If we captured almost nothing, retry once with a longer window
      const isLikelySilence = mulaw.length < (160 * 10); // ~200ms of audio at 8k μ-law
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

        // Wait for a brief quiet period before replying
        const now = Date.now();
        const waitMs = Math.max(0, SILENCE_BEFORE_REPLY_MS - (now - lastSpeechAt));
        if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

        ttsController = new TtsController();
        await startPlaybackFromTTS({
          ws, streamSid, text: reply,
          voice: TTS_VOICE, model: TTS_MODEL,
          controller: ttsController
        });

        // New window to keep the convo going
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
    if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
  }
});

// --- Audio & AI helpers ---
function convertMulaw8kToWav16k(mulawBuffer) {
  return new Promise((resolve, reject) => {
    const args = [
      "-f", "mulaw", "-ar", "8000", "-ac", "1", "-i", "pipe:0",
      "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1",
    ];
    const p = spawn(ffmpegPath, args);
    const chunks = [];
    p.stdout.on("data", (b) => chunks.push(b));
    p.stderr.on("data", () => {});
    p.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg (mulaw->wav) exited ${code}`)));
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
  const system =
    "You are Anna, JP's friendly Australian digital assistant. Keep replies short and helpful.";
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
