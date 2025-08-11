// index.js — Duplex with: cached greeting, VAD early-stop (low latency), phone capture OFF,
// Dev Mode ON by default (assumes JP), project brief injection, British female voice via VALID_VOICES in tts.js

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const FormData = require("form-data");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static") || "ffmpeg";
require("dotenv").config();

const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const {
  startPlaybackFromTTS,
  startPlaybackTone,
  warmGreeting,
  playCachedGreeting,
  clearGreetingCache,
  TtsController,
} = require("./tts");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ---- Config
const GREETING_TEXT =
  process.env.GREETING_TEXT ||
  "Hi, this is Anna, JP's digital personal assistant. Would you like me to pass on a message?";
const TTS_VOICE  = (process.env.TTS_VOICE || "verse").toLowerCase();
const TTS_MODEL  = process.env.TTS_MODEL  || "gpt-4o-mini-tts";
const BARGE_IN_ENABLED = String(process.env.BARGE_IN_ENABLED || "false").toLowerCase() === "true";
const SPEECH_THRESH = Number(process.env.BARGE_IN_THRESH || 22); // for VAD too
const SILENCE_BEFORE_REPLY_MS = Number(process.env.SILENCE_BEFORE_REPLY_MS || 0);

// VAD params (latency killer)
const VAD_SILENCE_MS = Number(process.env.VAD_SILENCE_MS || 500);    // stop after 0.5s silence
const VAD_MAX_WINDOW_MS = Number(process.env.VAD_MAX_WINDOW_MS || 2500); // hard cap

const GREETING_SAFETY_MS = Number(process.env.GREETING_SAFETY_MS || 2800);
const GOODBYE_GUARD_WINDOW_MS = Number(process.env.GOODBYE_GUARD_WINDOW_MS || 2500);
const GOODBYE_MIN_TOKENS = Number(process.env.GOODBYE_MIN_TOKENS || 4);

const ANNA_DEV_MODE_DEFAULT = String(process.env.ANNA_DEV_MODE || "true").toLowerCase() === "true";
const DEV_CALLER_NAME = process.env.DEV_CALLER_NAME || "JP";
const PHONE_CAPTURE_ENABLED = String(process.env.PHONE_CAPTURE_ENABLED || "false").toLowerCase() === "true";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// ---- Project brief (loaded at boot; editable without redeploy)
const PROJECT_BRIEF_PATH = process.env.PROJECT_BRIEF_PATH || "./project-brief.md";
let PROJECT_BRIEF = "";
try {
  PROJECT_BRIEF = fs.readFileSync(PROJECT_BRIEF_PATH, "utf8");
  console.log(`🧠 Loaded project brief (${PROJECT_BRIEF.length} chars)`);
} catch {
  console.log("🧠 No project brief file found; proceeding without it.");
}

// ---- Helpers
const AU_MOBILE_LEN = 10;
const DIGIT_WORDS = { "zero":"0","oh":"0","o":"0","one":"1","two":"2","three":"3","four":"4","five":"5","six":"6","seven":"7","eight":"8","nine":"9" };
const MULTIPLIER_WORDS = { "double": 2, "triple": 3 };
function tokensFrom(text){return (text||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean);}
function extractDigitsFromTranscript(text){const out=[];const toks=tokensFrom(text);const inline=(text||"").match(/\d+/g);if(inline) inline.forEach(s=>out.push(...s.split("")));for(let i=0;i<toks.length;i++){const t=toks[i];if(MULTIPLIER_WORDS[t]&&i+1<toks.length){const next=DIGIT_WORDS[toks[i+1]];if(next!=null){out.push(...Array(MULTIPLIER_WORDS[t]).fill(next));i++;continue;}}const d=DIGIT_WORDS[t];if(d!=null) out.push(d);}return out.join("");}
function formatAuMobile(d){const s=d.slice(0,AU_MOBILE_LEN);if(s.length<4) return s;if(s.length<=7) return `${s.slice(0,4)} ${s.slice(4)}`;return `${s.slice(0,4)} ${s.slice(4,7)} ${s.slice(7)}`;}
function looksLikePhoneIntent(t=""){t=(t||"").toLowerCase();return /\b(my (mobile|cell|number|phone)|call me( back)? on|reach me on|you can call me on|it's|is|^0?4|oh four|zero four|o four)\b/.test(t);}
function userCancelsNumberMode(t=""){t=(t||"").toLowerCase();return /\b(not digits|stop digits|cancel number|no number|ignore number|not giving (you )?my number|i'?m not (trying to )?say digits|don'?t take my number)\b/.test(t);}
function ulawEnergy(buf){let acc=0;for(let i=0;i<buf.length;i++) acc+=Math.abs(buf[i]-0x7f);return acc/buf.length;}

// ---- Twilio webhook
app.post("/twilio/voice", (req, res) => {
  console.log("➡️ /twilio/voice hit");
  const host = req.headers.host;
  const twiml = `<Response><Connect><Stream url="wss://${host}/media-stream"/></Connect></Response>`;
  res.type("text/xml").send(twiml);
});
app.get("/", (_req,res)=>res.status(200).send("DPA backend is live"));
app.get("/health", (_req,res)=>res.status(200).send("ok"));

// Admin: flush TTS cache (use after changing TTS_VOICE)
app.post("/admin/flush-tts-cache", (req,res)=>{
  const token = req.headers["x-admin-token"] || "";
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(403).json({ok:false,error:"forbidden"});
  clearGreetingCache();
  return res.json({ok:true});
});

const server = http.createServer(app);

// ---- WebSocket + session
const wss = new WebSocket.Server({ noServer: true });
server.on("upgrade",(request,socket,head)=>{
  if (request.url === "/media-stream") wss.handleUpgrade(request,socket,head,(ws)=>wss.emit("connection",ws,request));
  else socket.destroy();
});

wss.on("connection",(ws)=>{
  console.log("✅ Twilio WebSocket connected");

  let streamSid=null;
  let collecting=false, buffers=[], collectTimer=null, greetingDone=false, collectAttempts=0;
  let ttsController=null, lastSpeechAt=0, vadStartAt=0, vadSilenceSince=null;

  // Phone capture OFF by default
  let phoneDigits="", expectingPhone=false;

  // Dev mode ON
  let devModeActive = ANNA_DEV_MODE_DEFAULT;
  let devKnownName = devModeActive ? DEV_CALLER_NAME : null;
  if (ANNA_DEV_MODE_DEFAULT) console.log("🛠️ Dev mode ENABLED (startup); assuming caller is", DEV_CALLER_NAME);

  ws.on("message", async (msg)=>{
    let data; try { data = JSON.parse(msg.toString()); } catch { return; }

    switch(data.event){
      case "connected":
        console.log("📞 Twilio media stream connected"); break;

      case "start":
        streamSid = data.start?.streamSid || null;
        console.log(`🔗 Stream started. streamSid=${streamSid}`);
        console.log(`🔧 Runtime: devMode=${devModeActive} phoneCapture=${PHONE_CAPTURE_ENABLED} voice=${TTS_VOICE}`);

        // Greeting
        if (!process.env.OPENAI_API_KEY){
          console.log("🔊 Playback mode: Tone (no OPENAI_API_KEY set)");
          ttsController = new TtsController();
          startPlaybackTone({ ws, streamSid, logPrefix:"TONE", controller: ttsController }).catch(e=>console.error("TTS/playback error (tone):", e?.message || e));
        } else {
          console.log("🔊 Playback mode: OpenAI TTS (cached)");
          ttsController = new TtsController();
          playCachedGreeting({ ws, streamSid, text: GREETING_TEXT, voice: TTS_VOICE, model: TTS_MODEL, controller: ttsController })
            .catch(e=>console.error("TTS/playback error:", e?.message || e));
        }

        greetingDone=false; collecting=false; stopCollecting();
        setTimeout(()=>{
          if (!greetingDone){
            console.log("⏱️ Greeting safety timeout — starting listen (barge-in disabled)");
            greetingDone=true; startCollectingVAD();
          }
        }, GREETING_SAFETY_MS);
        break;

      case "media": {
        const b64 = data?.media?.payload;
        if (!b64) break;
        const chunk = Buffer.from(b64,"base64");
        // VAD tracking (always on; independent of barge-in)
        const e = ulawEnergy(chunk);
        if (e > SPEECH_THRESH) { lastSpeechAt = Date.now(); vadSilenceSince = null; }
        else { if (!vadSilenceSince) vadSilenceSince = Date.now(); }

        if (collecting) buffers.push(chunk);
        break;
      }

      case "mark":
        console.log("📍 Twilio mark:", data?.mark?.name);
        if ((data?.mark?.name === "tts-done" || data?.mark?.name === "TONE-done") && !greetingDone){
          greetingDone = true;
          startCollectingVAD();
        }
        break;

      case "stop":
        console.log("🛑 Twilio signaled stop — closing stream");
        try { ws.close(); } catch {}
        break;
    }
  });

  ws.on("close", ()=>{ stopCollecting(); console.log("❌ WebSocket closed"); });
  ws.on("error", err=>{ console.error("⚠️ WebSocket error:", err?.message || err); try{ws.close();}catch{} });

  // ===== VAD-driven collection (end early on ~500ms silence, cap at 2.5s) =====
  function startCollectingVAD(){
    stopCollecting();
    collecting = true; buffers = []; collectAttempts += 1;
    vadStartAt = Date.now(); vadSilenceSince = null; lastSpeechAt = Date.now();

    // Poll for silence end
    const poll = setInterval(async ()=>{
      const now = Date.now();
      const hitSilence = vadSilenceSince && (now - vadSilenceSince) >= VAD_SILENCE_MS;
      const hitMax = (now - vadStartAt) >= VAD_MAX_WINDOW_MS;
      if (hitSilence || hitMax){
        clearInterval(poll);
        collecting = false;
        const mulaw = Buffer.concat(buffers); buffers = [];
        await processTurn(mulaw);
      }
    }, 30);
  }

  async function processTurn(mulaw){
    const isLikelySilence = mulaw.length < (160 * 6); // ~120ms
    if (isLikelySilence && collectAttempts < 3) {
      console.log("🤫 Low audio captured — retry listen");
      return startCollectingVAD();
    }
    try{
      const wav16k = await convertMulaw8kToWav16k(mulaw);
      const transcriptRaw = await transcribeWithWhisper(wav16k, {
        language: "en",
        prompt:
          "Transcribe short phone-call phrases. Recognise declines like 'no'. " +
          "Do not invent numbers. Keep it concise."
      });
      const transcript = (transcriptRaw || "").trim();
      console.log("📝 Transcript:", transcript);

      // Goodbye guard
      const wordCount = transcript.split(/\s+/).filter(Boolean).length;
      const looksLikeGoodbye = /\b(bye|goodbye|see\s+you|catch\s+you)\b/i.test(transcript);
      if ((Date.now()-vadStartAt) < GOODBYE_GUARD_WINDOW_MS && looksLikeGoodbye && wordCount < GOODBYE_MIN_TOKENS){
        console.log("🙈 Ignoring early short 'goodbye' (guard active)");
        collectAttempts = 0; return startCollectingVAD();
      }

      // Phone capture OFF in dev or when feature disabled
      if (ANNA_DEV_MODE_DEFAULT || !PHONE_CAPTURE_ENABLED){ expectingPhone=false; phoneDigits=""; }

      // Intents
      const intent = simpleIntent(transcript);
      if (intent.type === "dev_on"){ console.log("🛠️ Dev mode ENABLED (voice)"); devModeActive=true; devKnownName=DEV_CALLER_NAME; await speakAndContinue(`Dev mode on. Hey ${devKnownName}, ready to iterate.`); collectAttempts=0; return startCollectingVAD(); }
      if (intent.type === "dev_off"){ console.log("🛠️ Dev mode DISABLED (voice)"); devModeActive=false; devKnownName=null; await speakAndContinue("Dev mode off. Keeping it simple."); collectAttempts=0; return startCollectingVAD(); }
      if (intent.type === "decline"){ await speakAndContinue(devModeActive?`All good, ${DEV_CALLER_NAME}. What should we test next?`:"No worries. I can help another time."); collectAttempts=0; return startCollectingVAD(); }
      if (intent.type === "empty"){ await speakAndContinue("Sorry, I didn’t catch that. How can I help?"); collectAttempts=0; return startCollectingVAD(); }
      if (intent.type === "check_audio"){ await speakAndContinue("Yep, I can hear you."); collectAttempts=0; return startCollectingVAD(); }
      if (intent.type === "goodbye"){ await speakAndContinue("Bye for now!"); return; }

      // Normal GPT path (concise + brief injected project context in dev mode)
      const reply = await generateReply({ userText: transcript, devMode: devModeActive, knownName: devKnownName, projectBrief: PROJECT_BRIEF });
      console.log("🤖 GPT reply:", reply);

      await speakAndContinue(reply);
      collectAttempts = 0;
      startCollectingVAD();
    } catch(e){
      console.error("❌ ASR/Reply error:", e?.message || e);
      collectAttempts = 0;
      startCollectingVAD();
    }
  }

  function stopCollecting(){ collecting=false; buffers=[]; if (collectTimer){ clearTimeout(collectTimer); collectTimer=null; } }

  async function speakAndContinue(text){
    const now = Date.now();
    const waitMs = Math.max(0, SILENCE_BEFORE_REPLY_MS - (now - lastSpeechAt));
    if (waitMs > 0) await new Promise(r=>setTimeout(r, waitMs));
    ttsController = new TtsController();
    await startPlaybackFromTTS({ ws, streamSid, text, voice: TTS_VOICE, model: TTS_MODEL, controller: ttsController });
  }
});

// --- Audio & AI helpers
function convertMulaw8kToWav16k(mulawBuffer) {
  return new Promise((resolve, reject) => {
    const args = ["-f","mulaw","-ar","8000","-ac","1","-i","pipe:0","-ar","16000","-ac","1","-f","wav","pipe:1"];
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

// Intents
function simpleIntent(userText=""){
  const t = (userText||"").trim().toLowerCase();
  if (!t) return { type: "empty" };
  if (/\b(bye|goodbye|see you|catch you|talk later)\b/.test(t)) return { type:"goodbye" };
  if (/\b(can you hear me|are you there|hello)\b/.test(t)) return { type:"check_audio" };
  if (/\b(i (do not|don't) (want|wish) to (leave|give) (a )?message|no message|not leaving (a )?message)\b/.test(t)) return { type:"decline" };
  if (/^no\.?$/i.test(t)) return { type:"decline" };
  if (/\b(dev mode on|developer mode on)\b/i.test(t)) return { type:"dev_on" };
  if (/\b(dev mode off|developer mode off)\b/i.test(t)) return { type:"dev_off" };
  if (/\b(not digits|stop digits|cancel number|no number|ignore number|not giving (you )?my number|i'?m not (trying to )?say digits|don'?t take my number)\b/.test(t)) return { type:"cancel_numbers" };
  return { type:"freeform" };
}

async function generateReply({ userText, devMode, knownName, projectBrief }) {
  if (!process.env.OPENAI_API_KEY) return "Sorry, I didn’t catch that.";
  const brief = projectBrief ? `\n\nPROJECT BRIEF (for dev mode):\n${projectBrief}\n` : "";
  const system = devMode
    ? (
      `You are Anna, JP’s English-accented digital personal assistant AND a core member of the DPA build team.
Caller is ${knownName || "JP"} (developer) on a live PHONE CALL. Be very concise (≤ 12 words).
Surface helpful diagnostics only when useful. Avoid numbers unless explicitly asked.${brief}`
    )
    : (
      "You are Anna, JP’s digital personal assistant on a live phone call. Primary task: take a short message, confirm name and callback number (04xx xxx xxx). Be concise and natural. Avoid 'I can’t hear you'."
    );

  const messages = [
    { role: "system", content: system },
    { role: "assistant", content: "Hi, this is Anna, JP’s digital personal assistant. Would you like me to pass on a message?" },
    { role: "user", content: userText || "" }
  ];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: devMode ? 0.3 : 0.5, max_tokens: 60, messages })
  });
  if (!resp.ok) throw new Error(`Chat failed: ${resp.status} ${await resp.text().catch(()=> "")}`);
  const json = await resp.json();
  const text = json.choices?.[0]?.message?.content?.trim();
  return text || (devMode ? "Ready. What should we tweak first?" : "Got it. What would you like me to pass on?");
}

// Server
server.listen(PORT,"0.0.0.0", async ()=>{
  console.log(`🚀 Server running on 0.0.0.0:${PORT}`);
  if (process.env.OPENAI_API_KEY) {
    try { await warmGreeting({ text: GREETING_TEXT, voice: TTS_VOICE, model: TTS_MODEL }); }
    catch (e) { console.error("⚠️ Greeting warm failed:", e?.message || e); }
  }
});
