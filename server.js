// server.js — Twilio <Stream> ↔ OpenAI Realtime bridge (persona from env)
// Production-safe: debounced input commits, persona from env, Twilio μ-law end-to-end.

if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch {}
}

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const { personaFromEnv } = require("./persona");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ---- Healthcheck for Fly ----
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ---- Config ----
const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Twilio sends 20 ms G.711 µ-law frames at 8 kHz
const TWILIO_SAMPLE_RATE = 8000;
const TWILIO_FRAME_MS = 20;

// Commit policy
const MIN_COMMIT_MS = 120;       // commit only if ≥120ms buffered
const TRICKLE_INTERVAL_MS = 600; // periodic commit cadence while speech flows

// ---- Twilio Voice Webhook → returns TwiML with <Stream> ----
app.post("/twilio/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const wsUrl = `wss://${host}${process.env.TWILIO_STREAM_PATH || "/call"}`;

  const twiml =
    `<Response>` +
      `<Connect>` +
        `<Stream url="${wsUrl}" track="inbound_track"/>` +
      `</Connect>` +
      `<Pause length="${process.env.TWIML_PAUSE_LEN || "600"}"/>` +
    `</Response>`;

  console.log("➡️ /twilio/voice hit (POST)");
  console.log("🧾 TwiML returned:\n" + twiml);
  res.type("text/xml").send(twiml);
});

// ---- HTTP(S) server + WS upgrade ----
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const wanted = process.env.TWILIO_STREAM_PATH || "/call";
  const path = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (path !== wanted) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// ---- Helpers for buffering/commits ----
function makeAudioBuffer() {
  return {
    chunks: [],
    ms: 0,
    push(base64Mulaw20ms) {
      this.chunks.push(base64Mulaw20ms);
      this.ms += TWILIO_FRAME_MS;
    },
    clear() {
      this.chunks = [];
      this.ms = 0;
    },
    hasMin() {
      return this.ms >= MIN_COMMIT_MS;
    },
    takeAllAsBase64() {
      const out = this.chunks.join("");
      this.clear();
      return out;
    }
  };
}

// ---- WS connection per call ----
wss.on("connection", (twilioWS, req) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`✅ Twilio WebSocket connected from ${ip}`);

  if (!OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY is not set");
    twilioWS.close();
    return;
  }

  const persona = personaFromEnv();
  console.log("🧠 Persona loaded:", {
    voice: persona.voice,
    asrModel: persona.asrModel,
    ttsModel: persona.ttsModel
  });

  // Connect to OpenAI Realtime (websocket)
  const oaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(persona.ttsModel)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  const inBuf = makeAudioBuffer();
  let trickleTimer = null;
  let streamSid = null;

  function startTrickle() {
    if (trickleTimer) return;
    trickleTimer = setInterval(() => {
      if (!oaiWS || oaiWS.readyState !== WebSocket.OPEN) return;
      if (!inBuf.hasMin()) return;
      const b64 = inBuf.takeAllAsBase64();
      oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      oaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      console.log("🔊 committed ~%dms cause=trickle (no respond)", MIN_COMMIT_MS);
    }, TRICKLE_INTERVAL_MS);
  }

  function stopTrickle() {
    if (trickleTimer) clearInterval(trickleTimer);
    trickleTimer = null;
  }

  // Forward OpenAI audio back to Twilio
  function sendAudioToTwilio(base64Mulaw) {
    if (twilioWS.readyState === WebSocket.OPEN) {
      twilioWS.send(JSON.stringify({ event: "media", media: { payload: base64Mulaw } }));
    }
  }

  // ---- Twilio events → buffer audio (NO per-frame append to OpenAI) ----
  twilioWS.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
      case "start":
        streamSid = data.start?.streamSid;
        console.log("🎬 Twilio stream START:", {
          streamSid, voice: persona.voice, model: persona.ttsModel, dev: !!process.env.DEV_MODE
        });
        break;

      case "media": {
        const payload = data.media?.payload;
        if (!payload) return;
        inBuf.push(payload); // buffer 20ms μ-law frames
        break;
      }

      case "mark":
      case "stop":
        console.log("🧵 Twilio event:", data.event);
        if (oaiWS.readyState === WebSocket.OPEN && inBuf.hasMin()) {
          const b64 = inBuf.takeAllAsBase64();
          oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
          oaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          console.log("🔊 committed (stop/mark) ≥%dms", MIN_COMMIT_MS);
        } else {
          inBuf.clear();
        }
        break;

      default:
        break;
    }
  });

  twilioWS.on("close", () => {
    console.log("❌ Twilio WebSocket closed");
    stopTrickle();
    if (oaiWS && oaiWS.readyState === WebSocket.OPEN) oaiWS.close();
  });

  twilioWS.on("error", (err) => console.error("⚠️ Twilio WS error:", err));

  // ---- OpenAI Realtime handlers ----
  oaiWS.on("open", () => {
    console.log("🔗 OpenAI Realtime connected");

    // IMPORTANT: input/output audio formats MUST be strings (not objects)
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions: persona.instructions,
        voice: persona.voice,
        input_audio_format: "g711_ulaw",                  // Twilio μ-law
        input_audio_language: persona.language || "en-AU",// optional but helpful
        output_audio_format: "g711_ulaw",                 // to stream straight back to Twilio
        modalities: ["audio", "text"],
        // Basic VAD settings to keep latency sensible
        turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 100, silence_duration_ms: 200 },
        input_audio_transcription: { model: persona.asrModel }
      }
    };

    oaiWS.send(JSON.stringify(sessionUpdate));
    console.log("✅ session.updated (ASR=%s, format=g711_ulaw)", persona.asrModel);

    startTrickle();
  });

  oaiWS.on("message", (msg) => {
    let evt;
    try { evt = JSON.parse(msg.toString()); } catch { return; }

    switch (evt.type) {
      // (optional) assistant transcript
      case "response.audio_transcript.delta":
        if (evt.delta?.length) console.log("🗣️ ANNA SAID:", evt.delta);
        break;

      case "response.audio_transcript.done":
        console.log("🔎 OAI event: response.audio_transcript.done");
        break;

      // Speech segmentation hints
      case "input_audio_buffer.speech_started":
        console.log("🔎 OAI event: input_audio_buffer.speech_started");
        break;

      case "input_audio_buffer.speech_stopped":
        console.log("🔎 OAI event: input_audio_buffer.speech_stopped");
        if (inBuf.hasMin()) {
          const b64 = inBuf.takeAllAsBase64();
          oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
          oaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          console.log("🔊 committed (speech_stopped) ≥%dms", MIN_COMMIT_MS);
        } else {
          console.log("⚠️ skipped commit (only %dms buffered)", inBuf.ms);
          inBuf.clear();
        }
        break;

      // Caller transcript (if model emits)
      case "conversation.item.input_audio_transcription.delta":
        if (evt.delta?.transcript) console.log("👂 YOU SAID (conv.delta):", evt.delta.transcript);
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (evt.transcript) console.log("👂 YOU SAID (conv.completed):", evt.transcript);
        break;

      // Audio from OpenAI back to caller
      case "response.audio.delta":
        if (evt.delta) sendAudioToTwilio(evt.delta);
        break;

      case "error":
        console.log("🔻 OAI error:", JSON.stringify(evt, null, 2));
        break;

      default:
        // console.log("OAI evt:", evt.type);
        break;
    }
  });

  oaiWS.on("close", () => {
    console.log("❌ OpenAI Realtime closed");
    stopTrickle();
    if (twilioWS.readyState === WebSocket.OPEN) twilioWS.close();
  });

  oaiWS.on("error", (err) => console.error("⚠️ OpenAI WS error:", err));
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
