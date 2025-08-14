// index.js — Twilio <Stream> ↔ OpenAI Realtime bridge (persona from env)
// Production-safe: debounced input commits, live dev transcripts, persona entirely from env.

require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const { personaFromEnv } = require("./persona");

// ---- Config ----
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Twilio sends 20 ms G.711 µ-law frames at 8 kHz
const TWILIO_SAMPLE_RATE = 8000;
const TWILIO_FRAME_MS = 20;

// Commit policy: avoid "buffer too small" errors
const MIN_COMMIT_MS = 120;         // only commit if ≥ 120 ms buffered
const TRICKLE_INTERVAL_MS = 600;   // periodic trickle if enough buffered

// ---- Twilio Voice Webhook ----
app.post("/twilio/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const wsUrl = `wss://${host}/call`;

  const twiml = `
    <Response>
      <Connect>
        <Stream url="${wsUrl}" track="inbound_track"/>
      </Connect>
      <Pause length="30"/>
    </Response>
  `.trim();

  res.type("text/xml").send(twiml);
});

// ---- HTTP(S) server + WS upgrade ----
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/call") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
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
    // Concatenate base64 frames into one base64 string
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

  // Load persona + models from env
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

  // Buffer for input audio we’ll commit to OAI
  const inBuf = makeAudioBuffer();
  let trickleTimer = null;
  let streamSid = null;

  function startTrickle() {
    if (trickleTimer) return;
    trickleTimer = setInterval(() => {
      if (!oaiWS || oaiWS.readyState !== WebSocket.OPEN) return;
      if (!inBuf.hasMin()) return;
      const b64 = inBuf.takeAllAsBase64();
      // Append + commit
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
    // Twilio bidirectional media expects "media" events back
    if (twilioWS.readyState === WebSocket.OPEN) {
      const msg = {
        event: "media",
        media: { payload: base64Mulaw }
      };
      twilioWS.send(JSON.stringify(msg));
    }
  }

  // ---- Twilio events → buffer audio & control commits ----
  twilioWS.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
      case "start":
        streamSid = data.start?.streamSid;
        console.log("🎬 Twilio stream START:", { streamSid, voice: persona.voice, model: persona.ttsModel, dev: !!process.env.DEV_MODE });
        break;

      case "media": {
        const payload = data.media?.payload;
        if (!payload) return;
        // 20 ms G.711 µ-law base64 frame from Twilio
        inBuf.push(payload);
        // If OpenAI is ready and we’ve got at least one frame, append (no commit yet)
        if (oaiWS.readyState === WebSocket.OPEN) {
          oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
        }
        break;
      }

      case "mark":
      case "stop":
        console.log("🧵 Twilio event:", data.event);
        // Flush what we have if it meets minimum
        if (oaiWS.readyState === WebSocket.OPEN && inBuf.hasMin()) {
          const b64 = inBuf.takeAllAsBase64();
          oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
          oaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          console.log("🔊 committed (stop/mark) ≥%dms", MIN_COMMIT_MS);
        } else {
          inBuf.clear(); // drop partials to avoid empty-commit errors
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

    // Configure session: env persona + codecs to match Twilio
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions: persona.instructions,
        voice: persona.voice,
        // Input is G.711 µ-law @ 8 kHz from Twilio
        input_audio_format: { type: "g711_ulaw", sample_rate_hz: TWILIO_SAMPLE_RATE },
        // Output same so we can pass straight back to Twilio
        output_audio_format: { type: "g711_ulaw", sample_rate_hz: TWILIO_SAMPLE_RATE },
        // Keep ASR/latency sensible
        turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 100, silence_duration_ms: 200 },
        modalities: ["audio", "text"],
        input_audio_transcription: { model: persona.asrModel }
      }
    };

    oaiWS.send(JSON.stringify(sessionUpdate));
    console.log("✅ session.updated (ASR=%s)", persona.asrModel);

    // Start trickle commit timer
    startTrickle();
  });

  oaiWS.on("message", (msg) => {
    let evt;
    try { evt = JSON.parse(msg.toString()); } catch { return; }

    // Debug/dev logs similar to what you’ve been using
    switch (evt.type) {
      case "response.audio_transcript.delta":
        if (evt.delta?.length) console.log("🗣️ ANNA SAID:", evt.delta);
        break;

      case "response.audio_transcript.done":
        console.log("🔎 OAI event: response.audio_transcript.done");
        break;

      case "input_audio_buffer.speech_started":
        console.log("🔎 OAI event: input_audio_buffer.speech_started");
        break;

      case "input_audio_buffer.speech_stopped":
        console.log("🔎 OAI event: input_audio_buffer.speech_stopped");
        // Try to flush if we have enough buffered
        if (inBuf.hasMin()) {
          const b64 = inBuf.takeAllAsBase64();
          oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
          oaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          console.log("🔊 committed (speech_stopped) ≥%dms", MIN_COMMIT_MS);
        } else {
          inBuf.clear();
          // No commit — prevents "buffer too small" errors
          console.log("⚠️ skipped commit (only %dms buffered)", inBuf.ms);
        }
        break;

      case "conversation.item.input_audio_transcription.delta":
        if (evt.delta?.transcript) console.log("👂 YOU SAID (conv.delta):", evt.delta.transcript);
        else console.log("🔎 conv.delta arrived but no transcript field found");
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (evt.transcript) console.log("👂 YOU SAID (conv.completed):", evt.transcript);
        else console.log("🔎 conv.completed arrived but no transcript field found");
        break;

      // Audio from OpenAI to play to caller
      case "response.audio.delta":
        if (evt.delta) sendAudioToTwilio(evt.delta);
        break;

      case "response.completed":
      case "response.created":
      case "response.output_text.delta":
        // optional: add any extra logs you like
        break;

      case "error":
        console.log("🔻 OAI error:", JSON.stringify(evt, null, 2));
        break;

      default:
        // Uncomment to see everything:
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
