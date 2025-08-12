// index.js — DPA with Twilio <Connect><Stream> + OpenAI Realtime GPT-4o
// Voice: Coral (British/Aus female), with improved turn-taking

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;
const VOICE = process.env.OPENAI_VOICE || "coral";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// VAD config
const MAX_TURN_MS = 5000;
const SILENCE_MS = 900;
const SPEECH_THRESH = 34;
const SILENCE_FRAMES_REQUIRED = 8;
const MIN_COMMIT_BYTES = 400; // ~100ms @ G.711 μ-law

let oai, activeResponse = false;

// --- Twilio webhook ---
app.post("/twilio/voice", (req, res) => {
  const twiml = `
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/call" track="inbound_track"/>
      </Connect>
      <Pause length="30"/>
    </Response>
  `;
  res.type("text/xml");
  res.send(twiml.trim());
});

app.get("/", (req, res) => res.send("DPA backend live"));

// --- HTTP server ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/call") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleTwilioStream(ws);
    });
  }
});

function handleTwilioStream(ws) {
  console.log("✅ Twilio WebSocket connected");

  // --- OpenAI Realtime WS ---
  const oaiUrl = `wss://api.openai.com/v1/realtime?model=${MODEL}`;
  oai = new WebSocket(oaiUrl, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
  });

  oai.on("open", () => {
    console.log("🔗 OpenAI Realtime connected");
    // Update session with transcription + voice
    oai.send(JSON.stringify({
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        modalities: ["audio", "text"],
        voice: VOICE,
        input_audio_transcription: { model: "whisper-1" },
        instructions: "You are Anna, JP's friendly Australian/British digital assistant."
      }
    }));
    // Initial greeting
    requestResponse({ instructions: "Hi, this is Anna, JP’s digital personal assistant. How can I help you today?" });
  });

  let mulawChunks = [];
  let bytesBuffered = 0;
  let lastSpeechAt = Date.now();
  let turnStartedAt = Date.now();
  let silenceFrames = 0;

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.event === "media") {
      const mulaw = Buffer.from(data.media.payload, "base64");
      mulawChunks.push(mulaw);
      bytesBuffered += mulaw.length;

      // crude energy detect
      const e = ulawEnergy(mulaw);
      if (e > SPEECH_THRESH) {
        lastSpeechAt = Date.now();
        silenceFrames = 0;
      } else {
        silenceFrames = Math.min(silenceFrames + 1, 1000);
      }

      oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
    } else if (data.event === "start") {
      console.log(`🎬 Twilio stream START: streamSid=${data.start.streamSid}, voice=${VOICE}, model=${MODEL}`);
      turnStartedAt = Date.now();
    } else if (data.event === "stop") {
      console.log("🛑 Twilio STOP event");
      oai.close();
      ws.close();
    }
  });

  // VAD polling
  const vadPoll = setInterval(() => {
    const now = Date.now();
    const hitMax = now - turnStartedAt >= MAX_TURN_MS;
    const longSilence = now - lastSpeechAt >= SILENCE_MS;
    const haveAudio = bytesBuffered >= MIN_COMMIT_BYTES && mulawChunks.length > 0;

    if ((hitMax || (longSilence && silenceFrames >= SILENCE_FRAMES_REQUIRED)) && haveAudio) {
      commitIfReady(hitMax ? "max" : "silence", true);
      silenceFrames = 0;
    }
  }, 50);

  function commitIfReady(cause, respond) {
    const audio = Buffer.concat(mulawChunks);
    if (audio.length < MIN_COMMIT_BYTES) return;
    console.log(`🔊 committed ~${Math.round(audio.length / 160)}ms (${audio.length} bytes) cause=${cause}`);
    oai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    mulawChunks = [];
    bytesBuffered = 0;
    turnStartedAt = Date.now();
    if (respond) requestResponse({});
  }

  function requestResponse(extra) {
    if (activeResponse) return;
    activeResponse = true;
    oai.send(JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio", "text"], ...extra }
    }));
  }

  // --- OAI incoming events ---
  oai.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === "response.input_audio_transcription.delta" && msg.delta) {
      console.log("👂 YOU SAID:", String(msg.delta));
    }
    if (msg.type === "response.output_text.delta" && msg.delta) {
      console.log("🗣 ANNA SAID:", String(msg.delta));
    }
    if (msg.type === "response.completed" || msg.type === "response.done" || msg.type === "response.output_audio.done") {
      activeResponse = false;
    }
    if (msg.type === "response.output_audio.delta" && msg.audio) {
      ws.send(JSON.stringify({ event: "media", media: { payload: msg.audio } }));
    }
    if (msg.type === "error") {
      console.error("❌ OAI error:", msg);
    }
  });

  ws.on("close", () => {
    clearInterval(vadPoll);
    if (oai) oai.close();
    console.log("❌ Twilio WS closed");
  });
}

function ulawEnergy(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += Math.abs(buf[i] - 127);
  return sum / buf.length;
}

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
