// index.js — Stable duplex: cached greeting (no early cancel), optional barge-in (OFF by default),
// Whisper ASR → GPT (with hybrid intent + AU phone capture) → TTS replies,
// Dev Mode that can be toggled by voice: “dev mode on/off”
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const FormData = require("form-data");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static") || "ffmpeg";
require("dotenv").config();

// ESM-friendly fetch shim for node-fetch v3 in CJS
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

// ---- Config (env-overridable)
const GREETING_TEXT =
  process.env.GREETING_TEXT ||
  "Hi, this is Anna, JP's digital personal assistant. Would you like me to pass on a message?";
const TTS_VOICE  = process.env.TTS_VOICE  || "alloy";
const TTS_MODEL  = process.env.TTS_MODEL  || "gpt-4o-mini-tts";

// Barge-in defaults OFF for stability; enable later via secret if desired
const BARGE_IN_ENABLED =
  String(process.env.BARGE_IN_ENABLED || "false").toLowerCase() === "true";
const SPEECH_THRESH = Number(process.env.BARGE_IN_THRESH || 22); // conservative
const HOT_FRAMES    = Number(process.env.BARGE_IN_FRAMES || 8);  // ~160ms at 20ms frames
const SILENCE_BEFORE_REPLY_MS = Number(process.env.SILENCE_BEFORE_REPLY_MS || 500);

// Greeting safety: if Twilio never echoes mark, we still start listening (but don't cancel greeting)
const GREETING_SAFETY_MS = Number(process.env.GREETING_SAFETY_MS || 2800);

// Goodbye guard: ignore tiny “bye” right after greeting (accidental)
const GOODBYE_GUARD_WINDOW_MS = Number(process.env.GOODBYE_GUARD_WINDOW_MS || 2500);
const GOODBYE_MIN_TOKENS      = Number(process.env.GOODBYE_MIN_TOKENS || 4);

// Dev Mode default from env; per-call voice toggle can override
const ANNA_DEV_MODE_DEFAULT =
  String(process.env.ANNA_DEV_MODE || "false").toLowerCase() === "true";

// ---------- μ-law energy helper (for optional barge-in)
function ulawEnergy(buf) {
  let acc = 0;
  for (let i = 0; i < buf.length; i++) acc += Math.abs(buf[i] - 0x7f);
  return acc / buf.length; // rough 0..128
}

// ---- Phone capture helpers (AU-focused) ----
const AU_MOBILE_LEN = 10;
const DIGIT_WORDS = {
  "zero": "0", "oh": "0", "o": "0",
  "one": "1", "won": "1",
  "two": "2", "to": "2", "too": "2",
  "three": "3", "tree": "3",
  "four": "4", "for": "4",
  "five": "5",
  "six": "6",
  "seven": "7",
  "eight": "8", "ate": "8",
  "nine": "9"
};
const MULTIPLIER_WORDS = { "double": 2, "triple": 3 };

function tokensFrom(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Extract digits from a text turn, supporting words + inline numbers + "double/triple X"
function extractDigitsFromTranscript(text) {
  const out = [];
  const toks = tokensFrom(text);

  // Also capture any contiguous numeric strings quickly
  const inline = (text || "").match(/\d+/g);
  if (inline) inline.forEach(s => out.push(...s.split("")));

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];

    if (MULTIPLIER_WORDS[t] && i + 1 < toks.length) {
      const next = DIGIT_WORDS[toks[i + 1]];
      if (next != null) {
        out.push(...Array(MULTIPLIER_WORDS[t]).fill(next));
        i++; // skip next
        continue;
      }
    }
    const d = DIGIT_WORDS[t];
    if (d != null) { out.push(d); continue; }
  }
  return out.join("");
}

// Format 04xxxxxxxx as 04xx xxx xxx (AU mobile)
function formatAuMobile(digits) {
  const d = digits.slice(0, AU_MOBILE_LEN);
  if (d.length < 4) return d;
  if (d.length <= 7) return `${d.slice(0,4)} ${d.slice(4)}`;
  return `${d.slice(0,4)} ${d.slice(4,7)} ${d.slice(7)}`;
}

// --- Twilio webhook: open full-duplex media stream using <Connect><Stream>
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

// ---- Single WebSocket server + single upgrade handler (avoid double-upgrade crash)
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

  // Barge-in state (kept OFF during greeting)
  let allowBargeIn = false;
  let speechHotCount = 0;
  let greetingSafetyTimer = null;
  let firstListenStartedAt = 0;

  // Phone capture state
  let phoneDigits = "";           // accumulates across turns
  let expectingPhone = false;     // set true when we ask for a number

  // Per-call Dev Mode flag; can be toggled by voice
  let devModeActive = ANNA_DEV_MODE_DEFAULT;

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

        // Play greeting (never cancel it)
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

        // During greeting: no barge-in; do not collect yet
        allowBargeIn = false;
        greetingDone = false;
        stopCollecting();

        // Safety: if Twilio never echoes tts-done, start listening after timeout WITHOUT enabling barge-in
        if (greetingSafetyTimer) clearTimeout(greetingSafetyTimer);
        greetingSafetyTimer = setTimeout(() => {
          if (!greetingDone) {
            console.log("⏱️ Greeting safety timeout — starting listen (barge-in disabled)");
            greetingDone = true; // behave as if greeting completed
            startCollectingWindow(4500);
            firstListenStartedAt = Date.now();
          }
        }, GREETING_SAFETY_MS);
        break;

      case "media": {
        if (data?.media?.payload) {
          const chunk = Buffer.from(data.media.payload, "base64");

          // Optional barge-in (disabled by default and always disabled during greeting)
          if (BARGE_IN_ENABLED && allowBargeIn) {
            const e = ulawEnergy(chunk);
            if (e > SPEECH_THRESH) {
              speechHotCount = Math.min(HOT_FRAMES + 1, speechHotCount + 1);
              lastSpeechAt = Date.now();
              if (speechHotCount >= HOT_FRAMES) {
                if (ttsController && !ttsController.cancelled) {
                  ttsController.cancel();
                  console.log("🔇 Barge-in: caller speech detected — cancelling TTS");
                }
              }
            } else {
              speechHotCount = Math.max(0, speechHotCount - 2);
            }
          }

          if (collecting) buffers.push(chunk);
        }
        break;
      }

      case "mark":
        console.log("📍 Twilio mark:", data?.mark?.name);
        if ((data?.mark?.name === "tts-done" || data?.mark?.name === "TONE-done") && !greetingDone) {
          greetingDone = true;
          if (greetingSafetyTimer) { clearTimeout(greetingSafetyTimer); greetingSafetyTimer = null; }
          // After greeting we may allow barge-in (kept OFF by default for stability)
          allowBargeIn = BARGE_IN_ENABLED;
          startCollectingWindow(4000);
          firstListenStartedAt = Date.now();
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

  // ----- Collect → ASR → (hybrid intent/phone/dev toggles) → GPT → TTS reply -----
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
        const transcriptRaw = await transcribeWithWhisper(wav16k);
        const transcript = (transcriptRaw || "").trim();
        console.log("📝 Transcript:", transcript);

        // Guard against accidental early "goodbye" right after greeting
        const withinGoodbyeGuard =
          firstListenStartedAt > 0 &&
          (Date.now() - firstListenStartedAt) < GOODBYE_GUARD_WINDOW_MS;
        const wordCount = transcript.split(/\s+/).filter(Boolean).length;
        const looksLikeGoodbye = /\b(bye|goodbye|see\s+you|catch\s+you)\b/i.test(transcript);

        if (withinGoodbyeGuard && looksLikeGoodbye && wordCount < GOODBYE_MIN_TOKENS) {
          console.log("🙈 Ignoring early short 'goodbye' (guard active)");
          collectAttempts = 0;
          return startCollectingWindow(5000);
        }

        // === Phone capture branch (runs before GPT) ===
        let handledByPhoneFlow = false;
        const newlyHeard = extractDigitsFromTranscript(transcript);
        if (newlyHeard) {
          // If caller started giving a number, enter phone capture mode
          expectingPhone = true;
          phoneDigits += newlyHeard;
          // Trim to max length
          if (phoneDigits.length > AU_MOBILE_LEN) phoneDigits = phoneDigits.slice(0, AU_MOBILE_LEN);
        }

        if (expectingPhone) {
          if (phoneDigits.length === 0) {
            await speakAndContinue("What’s the best number for JP to call you back on? Please say it digit by digit.");
            handledByPhoneFlow = true;
          } else if (phoneDigits.length < AU_MOBILE_LEN) {
            const remaining = AU_MOBILE_LEN - phoneDigits.length;
            await speakAndContinue(`I have ${formatAuMobile(phoneDigits)}. Please say the next ${remaining} digit${remaining===1?"":"s"}, one at a time.`);
            handledByPhoneFlow = true;
          } else {
            // We have 10 digits — confirm
            const pretty = formatAuMobile(phoneDigits);
            await speakAndContinue(`Just to confirm, is your number ${pretty}?`);
            handledByPhoneFlow = true;
            // Stay in expectingPhone=true; next user turn should confirm yes/no
          }
        }

        if (handledByPhoneFlow) {
          // Open another listen window and return early
          collectAttempts = 0;
          return startCollectingWindow(5000);
        }

        // === Hybrid intent for short phrases & dev mode toggles (before GPT) ===
        const intent = simpleIntent(transcript);

        if (intent.type === "dev_on") {
          devModeActive = true;
          await speakAndContinue("Dev mode enabled. I’ll share brief diagnostics as we test.");
          collectAttempts = 0; return startCollectingWindow(5000);
        }
        if (intent.type === "dev_off") {
          devModeActive = false;
          await speakAndContinue("Dev mode disabled. I’ll keep it simple for callers.");
          collectAttempts = 0; return startCollectingWindow(5000);
        }

        if (intent.type === "empty") {
          await speakAndContinue("Sorry, I didn’t catch that. What message would you like me to pass on to JP?");
          collectAttempts = 0; return startCollectingWindow(5000);
        }
        if (intent.type === "check_audio") {
          await speakAndContinue("Yes, I can hear you. What would you like me to pass on to JP?");
          collectAttempts = 0; return startCollectingWindow(5000);
        }
        if (intent.type === "affirm") {
          await speakAndContinue("Great — what would you like me to pass on to JP?");
          collectAttempts = 0; return startCollectingWindow(5000);
        }
        if (intent.type === "goodbye") {
          await speakAndContinue("No worries — I’ll be here if you need me. Bye for now!");
          collectAttempts = 0; return; // likely caller will hang up
        }

        // === Normal GPT path ===
        const reply = await generateReply(transcript, devModeActive);
        console.log("🤖 GPT reply:", reply);

        await speakAndContinue(reply);

        // Keep the convo going with a new window
        collectAttempts = 0;
        startCollectingWindow(5000);
      } catch (e) {
        console.error("❌ ASR/Reply error:", e?.message || e);
        // Recover by opening another listen window
        collectAttempts = 0;
        startCollectingWindow(5000);
      }
    }, ms);
  }

  function stopCollecting() {
    collecting = false;
    buffers = [];
    if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
  }

  async function speakAndContinue(text) {
    // brief quiet period before speaking
    const now = Date.now();
    const waitMs = Math.max(0, SILENCE_BEFORE_REPLY_MS - (now - lastSpeechAt));
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

    ttsController = new TtsController();
    await startPlaybackFromTTS({
      ws, streamSid, text,
      voice: TTS_VOICE, model: TTS_MODEL,
      controller: ttsController
    });
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

// ---------- Hybrid intent + GPT ----------
function simpleIntent(userText = "") {
  const t = (userText || "").trim().toLowerCase();

  if (!t) return { type: "empty" };

  // explicit goodbyes
  if (/\b(bye|goodbye|see you|catch you|talk later)\b/.test(t)) {
    return { type: "goodbye" };
  }

  // user checking audio
  if (/\b(can you hear me|are you there|hello)\b/.test(t)) {
    return { type: "check_audio" };
  }

  // short affirmations
  if (/^(yes|yeah|yep|sure|please|ok|okay|that would be great|i would|i do)\b/.test(t) && t.split(/\s+/).length <= 6) {
    return { type: "affirm" };
  }

  // dev mode toggles (voice)
  if (/\b(dev mode on|developer mode on)\b/i.test(t)) return { type: "dev_on" };
  if (/\b(dev mode off|developer mode off)\b/i.test(t)) return { type: "dev_off" };

  return { type: "freeform" };
}

async function generateReply(userText, devMode) {
  if (!process.env.OPENAI_API_KEY) return "Sorry, I didn’t catch that.";

  // Voice-safe + dual-mode system prompt
  const system = devMode
    ? (
      "You are Anna, JP’s Australian digital personal assistant AND a core member of the DPA build team. " +
      "Context: You are on a live PHONE CALL fed by ASR transcripts. Keep replies natural and concise for callers. " +
      "When speaking with JP (a developer) or when the user asks about performance, ALSO provide brief engineering insights " +
      "inline and helpful next steps. Use plain English, no jargon unless asked. " +
      "Diagnostics you may surface succinctly when relevant: 'greeting played fully?', 'any barge-in?', 'ASR captured digits?', " +
      "'latency since last speech (approx)?', 'did we hit safety timeout?', 'suggested thresholds or prompts'. " +
      "NEVER say 'I can’t hear you'; instead use 'Sorry, I didn’t catch that' only when the transcript is empty. " +
      "Primary task for normal callers: take a short message for JP, confirm name and callback number, and read back numbers in 04xx xxx xxx format."
    )
    : (
      "You are Anna, JP’s Australian digital personal assistant on a live phone call. " +
      "Your primary task is to take a short message for JP, confirm the caller’s name and callback number, " +
      "read back numbers in 04xx xxx xxx format, and be concise and natural. " +
      "Avoid saying 'I can’t hear you'; only say 'Sorry, I didn’t catch that' if the transcript is empty. " +
      "Do not end the call or say goodbye unless the caller clearly asks to end."
    );

  // Seed minimal context so the model knows the call setup
  const messages = [
    { role: "system", content: system },
    { role: "assistant", content: "Hi, this is Anna, JP’s digital personal assistant. Would you like me to pass on a message?" },
    { role: "user", content: userText || "" }
  ];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: devMode ? 0.4 : 0.5,
      max_tokens: 140,
      messages
    }),
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`Chat failed: ${resp.status} ${errTxt}`);
  }
  const json = await resp.json();
  const text = json.choices?.[0]?.message?.content?.trim();
  return text || "Got it. What would you like me to pass on to JP?";
}

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`🚀 Server running on 0.0.0.0:${PORT}`);
  // Warm the greeting cache at boot so greeting plays immediately on first call
  if (process.env.OPENAI_API_KEY) {
    try {
      await warmGreeting({ text: GREETING_TEXT, voice: TTS_VOICE, model: TTS_MODEL });
    } catch (e) {
      console.error("⚠️ Greeting warm failed:", e?.message || e);
    }
  }
});
