// index.js — Stable duplex: cached greeting (no early cancel), optional barge-in (OFF by default),
// Whisper ASR → GPT (with hybrid intent incl. AU phone capture + decline) → TTS replies,
// Dev Mode toggle by voice; when ON, assume caller is JP and converse naturally to improve DPA.

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

// 🔊 British-accented female by default
const TTS_VOICE  = process.env.TTS_VOICE  || "verse";
const TTS_MODEL  = process.env.TTS_MODEL  || "gpt-4o-mini-tts";

// Barge-in defaults OFF for stability
const BARGE_IN_ENABLED =
  String(process.env.BARGE_IN_ENABLED || "false").toLowerCase() === "true";
const SPEECH_THRESH = Number(process.env.BARGE_IN_THRESH || 22);
const HOT_FRAMES    = Number(process.env.BARGE_IN_FRAMES || 8);
const SILENCE_BEFORE_REPLY_MS = Number(process.env.SILENCE_BEFORE_REPLY_MS || 500);

// Greeting safety
const GREETING_SAFETY_MS = Number(process.env.GREETING_SAFETY_MS || 2800);

// Goodbye guard
const GOODBYE_GUARD_WINDOW_MS = Number(process.env.GOODBYE_GUARD_WINDOW_MS || 2500);
const GOODBYE_MIN_TOKENS      = Number(process.env.GOODBYE_MIN_TOKENS || 4);

// Dev Mode default from env; per-call voice toggle can override
const ANNA_DEV_MODE_DEFAULT =
  String(process.env.ANNA_DEV_MODE || "false").toLowerCase() === "true";

// Treat the dev-mode caller as this name
const DEV_CALLER_NAME = process.env.DEV_CALLER_NAME || "JP";

// ---------- μ-law energy helper (for optional barge-in)
function ulawEnergy(buf) {
  let acc = 0;
  for (let i = 0; i < buf.length; i++) acc += Math.abs(buf[i] - 0x7f);
  return acc / buf.length;
}

// ---- Phone capture helpers (AU-focused) ----
const AU_MOBILE_LEN = 10;

// Avoid collision-prone homophones
const DIGIT_WORDS = {
  "zero": "0", "oh": "0", "o": "0",
  "one": "1",
  "two": "2",
  "three": "3",
  "four": "4",
  "five": "5",
  "six": "6",
  "seven": "7",
  "eight": "8",
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

function extractDigitsFromTranscript(text) {
  const out = [];
  const toks = tokensFrom(text);
  const inline = (text || "").match(/\d+/g);
  if (inline) inline.forEach(s => out.push(...s.split("")));
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (MULTIPLIER_WORDS[t] && i + 1 < toks.length) {
      const next = DIGIT_WORDS[toks[i + 1]];
      if (next != null) { out.push(...Array(MULTIPLIER_WORDS[t]).fill(next)); i++; continue; }
    }
    const d = DIGIT_WORDS[t];
    if (d != null) out.push(d);
  }
  return out.join("");
}

function formatAuMobile(digits) {
  const d = digits.slice(0, AU_MOBILE_LEN);
  if (d.length < 4) return d;
  if (d.length <= 7) return `${d.slice(0,4)} ${d.slice(4)}`;
  return `${d.slice(0,4)} ${d.slice(4,7)} ${d.slice(7)}`;
}

function looksLikePhoneIntent(text = "") {
  const t = (text || "").toLowerCase();
  return /\b(my (mobile|cell|number|phone)|call me( back)? on|reach me on|you can call me on|it's|is|^0?4|oh four|zero four|o four)\b/.test(t);
}

function userCancelsNumberMode(text = "") {
  const t = (text || "").toLowerCase();
  return /\b(not digits|stop digits|cancel number|no number|ignore number|not giving (you )?my number|i'?m not (trying to )?say digits|don'?t take my number)\b/.test(t);
}

// --- Twilio webhook: <Connect><Stream>
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

// ---- WebSocket
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

  // Barge-in state
  let allowBargeIn = false;
  let speechHotCount = 0;
  let greetingSafetyTimer = null;
  let firstListenStartedAt = 0;

  // Phone capture state
  let phoneDigits = "";
  let expectingPhone = false;

  // Dev Mode per call
  let devModeActive = ANNA_DEV_MODE_DEFAULT;
  let devKnownName = null;

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

        // Greeting
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

        allowBargeIn = false;
        greetingDone = false;
        stopCollecting();

        if (greetingSafetyTimer) clearTimeout(greetingSafetyTimer);
        greetingSafetyTimer = setTimeout(() => {
          if (!greetingDone) {
            console.log("⏱️ Greeting safety timeout — starting listen (barge-in disabled)");
            greetingDone = true;
            startCollectingWindow(4500);
            firstListenStartedAt = Date.now();
          }
        }, GREETING_SAFETY_MS);
        break;

      case "media": {
        if (data?.media?.payload) {
          const chunk = Buffer.from(data.media.payload, "base64");
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

  // ----- Collect → ASR → intents/dev/phone → GPT → TTS -----
  function startCollectingWindow(ms) {
    stopCollecting();
    collecting = true;
    buffers = [];
    collectAttempts += 1;

    collectTimer = setTimeout(async () => {
      collecting = false;
      const mulaw = Buffer.concat(buffers);
      buffers = [];

      const isLikelySilence = mulaw.length < (160 * 10);
      if (isLikelySilence && collectAttempts < 2) {
        console.log("🤫 Low audio captured — extending collection window");
        return startCollectingWindow(5000);
      }

      try {
        const wav16k = await convertMulaw8kToWav16k(mulaw);

        // Whisper with better bias
        const transcriptRaw = await transcribeWithWhisper(wav16k, {
          language: "en",
          prompt:
            "Transcribe short phone-call phrases. Recognise 'no' and 'I don’t want to leave a message'. " +
            "Do not invent numbers. Keep it concise."
        });
        const transcript = (transcriptRaw || "").trim();
        console.log("📝 Transcript:", transcript);

        // Goodbye guard
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

        // === Phone capture (disabled in dev mode) ===
        if (devModeActive) {
          expectingPhone = false;
          phoneDigits = "";
        } else {
          if (userCancelsNumberMode(transcript)) {
            expectingPhone = false;
            phoneDigits = "";
            await speakAndContinue("No worries — I’ll ignore numbers for now. What would you like to test?");
            collectAttempts = 0;
            return startCollectingWindow(5000);
          }
          const phoneIntent = looksLikePhoneIntent(transcript);
          const allowDigitParse = expectingPhone || phoneIntent;

          let handledByPhoneFlow = false;
          if (allowDigitParse) {
            const newlyHeard = extractDigitsFromTranscript(transcript);
            if (newlyHeard) {
              expectingPhone = true;
              phoneDigits += newlyHeard;
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
                const pretty = formatAuMobile(phoneDigits);
                await speakAndContinue(`Just to confirm, is your number ${pretty}?`);
                handledByPhoneFlow = true;
              }
            }
          }
          if (handledByPhoneFlow) { collectAttempts = 0; return startCollectingWindow(5000); }
        }

        // === Intents (before GPT) ===
        const intent = simpleIntent(transcript);

        if (intent.type === "dev_on") {
          devModeActive = true;
          devKnownName = DEV_CALLER_NAME;
          console.log("🛠️ Dev mode ENABLED (via voice); assuming caller is", devKnownName);
          await speakAndContinue(`Dev mode enabled. Hey ${devKnownName}, I’m ready to iterate. What should we test first?`);
          collectAttempts = 0; return startCollectingWindow(5000);
        }
        if (intent.type === "dev_off") {
          devModeActive = false;
          devKnownName = null;
          console.log("🛠️ Dev mode DISABLED (via voice)");
          await speakAndContinue("Dev mode disabled. I’ll keep it simple for callers.");
          collectAttempts = 0; return startCollectingWindow(5000);
        }
        if (intent.type === "cancel_numbers") {
          expectingPhone = false;
          phoneDigits = "";
          await speakAndContinue("Got it — I’ll stop capturing numbers. What would you like me to do?");
          collectAttempts = 0; return startCollectingWindow(5000);
        }
        if (intent.type === "decline") {
          if (devModeActive) {
            await speakAndContinue(`All good, ${DEV_CALLER_NAME}. Let’s debug instead — what behaviour should we tweak?`);
          } else {
            await speakAndContinue("No worries. If there’s nothing to pass on, I can help another time.");
          }
          collectAttempts = 0; return startCollectingWindow(5000);
        }

        if (intent.type === "empty") {
          await speakAndContinue("Sorry, I didn’t catch that. What would you like me to do?");
          collectAttempts = 0; return startCollectingWindow(5000);
        }
        if (intent.type === "check_audio") {
          await speakAndContinue("Yes, I can hear you. How can I help?");
          collectAttempts = 0; return startCollectingWindow(5000);
        }
        if (intent.type === "affirm") {
          await speakAndContinue("Great — what would you like me to pass on to JP?");
          collectAttempts = 0; return startCollectingWindow(5000);
        }
        if (intent.type === "goodbye") {
          await speakAndContinue("No worries — I’ll be here if you need me. Bye for now!");
          collectAttempts = 0; return;
        }

        // === Normal GPT path ===
        const reply = await generateReply({
          userText: transcript,
          devMode: devModeActive,
          knownName: devKnownName
        });
        console.log("🤖 GPT reply:", reply);

        await speakAndContinue(reply);
        collectAttempts = 0;
        startCollectingWindow(5000);
      } catch (e) {
        console.error("❌ ASR/Reply error:", e?.message || e);
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

async function transcribeWithWhisper(wavBuffer, opts = {}) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required for Whisper");
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", wavBuffer, { filename: "audio.wav", contentType: "audio/wav" });
  if (opts.language) form.append("language", opts.language);
  if (opts.prompt) form.append("prompt", opts.prompt);

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!resp.ok) throw new Error(`Whisper failed: ${resp.status} ${await resp.text().catch(() => "")}`);
  const json = await resp.json();
  return json.text || "";
}

// ---------- Intents ----------
function simpleIntent(userText = "") {
  const t = (userText || "").trim().toLowerCase();
  if (!t) return { type: "empty" };

  if (/\b(bye|goodbye|see you|catch you|talk later)\b/.test(t)) return { type: "goodbye" };
  if (/\b(can you hear me|are you there|hello)\b/.test(t)) return { type: "check_audio" };
  if (/^(yes|yeah|yep|sure|please|ok|okay|that would be great|i would|i do)\b/.test(t) && t.split(/\s+/).length <= 6)
    return { type: "affirm" };

  // decline / no-message
  if (/\b(i (do not|don't) (want|wish) to (leave|give) (a )?message|no,? (i )?(don'?t|do not) (want|wish) to leave (a )?message|no message|not leaving (a )?message)\b/.test(t))
    return { type: "decline" };
  if (/^no\.?$/i.test(t)) return { type: "decline" };

  // dev toggles
  if (/\b(dev mode on|developer mode on)\b/i.test(t)) return { type: "dev_on" };
  if (/\b(dev mode off|developer mode off)\b/i.test(t)) return { type: "dev_off" };

  // stop number capture
  if (/\b(not digits|stop digits|cancel number|no number|ignore number|not giving (you )?my number|i'?m not (trying to )?say digits|don'?t take my number)\b/.test(t))
    return { type: "cancel_numbers" };

  return { type: "freeform" };
}

async function generateReply({ userText, devMode, knownName }) {
  if (!process.env.OPENAI_API_KEY) return "Sorry, I didn’t catch that.";

  const system = devMode
    ? (
      `You are Anna, JP’s Australian digital personal assistant AND a core member of the DPA build team.
Caller is ${knownName || "JP"} (developer) on a live PHONE CALL. Speak naturally, be concise, and help improve the system.
Offer brief diagnostics when relevant (greeting complete? any barge-in? digits captured? rough latency?). Avoid jargon unless asked.
Never say "I can’t hear you"; if transcript is empty, say "Sorry, I didn’t catch that." In dev mode, prioritise helpful suggestions and next steps.`
    )
    : (
      "You are Anna, JP’s Australian digital personal assistant on a live phone call. " +
      "Primary task: take a short message, confirm name and callback number (04xx xxx xxx format), be concise and natural. " +
      "Never say 'I can’t hear you'; only use 'Sorry, I didn’t catch that' if transcript is empty. " +
      "Do not end the call unless the caller clearly asks to end."
    );

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
  return text || (devMode ? "Righto — what should we tweak first?" : "Got it. What would you like me to pass on to JP?");
}

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`🚀 Server running on 0.0.0.0:${PORT}`);
  if (process.env.OPENAI_API_KEY) {
    try {
      await warmGreeting({ text: GREETING_TEXT, voice: TTS_VOICE, model: TTS_MODEL });
    } catch (e) {
      console.error("⚠️ Greeting warm failed:", e?.message || e);
    }
  }
});
