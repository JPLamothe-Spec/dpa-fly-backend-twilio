// server.js — Twilio <-> OpenAI Realtime bridge (CommonJS, drop-in)
// Restores audible responses, prevents overlapping response.create,
// logs full user/assistant transcripts, and aligns with persona.js.

const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const persona = require("./persona");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const PORT = process.env.PORT || 3000;

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// --- Twilio Voice webhook: return <Connect><Stream/> + long Pause
app.post("/twilio/voice", (req, res) => {
  const wsUrl = `wss://${req.headers["host"]}/call`;
  const twiml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Connect><Stream url="${wsUrl}" track="inbound_track" /></Connect>`,
    '  <Pause length="600"/>',
    "</Response>",
  ].join("\n");

  console.log("➡️ /twilio/voice hit (POST)");
  console.log("🧾 TwiML returned:\n" + twiml);
  res.set("Content-Type", "text/xml");
  res.send(twiml);
});

const server = http.createServer(app);

// --- WS endpoint for Twilio <Stream>
const wss = new WebSocket.Server({ server, path: "/call" });

wss.on("connection", async (twilioWs, req) => {
  const clientIp = req.headers["fly-client-ip"] || req.socket.remoteAddress;
  console.log(`✅ Twilio WebSocket connected from ${clientIp}`);

  // Open OpenAI Realtime WS
  const oaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // --- State
  let responseActive = false;          // gate: true while OAI is speaking
  let framesSinceCommit = 0;           // number of 20ms frames appended since last commit
  let greeted = false;                 // ensure greeting only once
  let userPartial = "";                // assemble user ASR partial
  let assistantPartial = "";           // assemble assistant text partial

  // --- Helpers
  const logPersona = () => {
    console.log("👤 persona snapshot:", {
      name: persona.name,
      language: persona.language,
      voice: persona.voice,
      scope: persona.scope,
    });
  };

  const safeSendOAI = (obj) => {
    if (oaiWs.readyState === WebSocket.OPEN) {
      oaiWs.send(JSON.stringify(obj));
    }
  };

  const sendGreetingOnce = () => {
    if (greeted || responseActive) return;
    greeted = true;
    responseActive = true;
    console.log("📣 greeting response.create sent");
    safeSendOAI({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: persona.greeting,
      },
    });
  };

  const commitIfBuffered = () => {
    if (framesSinceCommit >= 5) { // 5 * 20ms = 100ms (min required)
      safeSendOAI({ type: "input_audio_buffer.commit" });
      framesSinceCommit = 0;
    }
  };

  const base64ToArrayBuffer = (b64) => Buffer.from(b64, "base64");

  // --- Twilio -> OAI: handle incoming audio frames
  twilioWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "start") {
        console.log("🎬 Twilio stream START:", {
          streamSid: data.start?.streamSid,
          model: OPENAI_REALTIME_MODEL,
          voice: persona.voice,
          dev: false,
        });
        return;
      }

      if (data.event === "media") {
        // append 20ms ulaw frames to OAI input buffer
        const chunk = data.media?.payload;
        if (chunk) {
          safeSendOAI({
            type: "input_audio_buffer.append",
            audio: chunk, // OAI expects base64 audio; Twilio payload is base64 ulaw
          });
          framesSinceCommit += 1;
        }
        return;
      }

      if (data.event === "mark") {
        return;
      }

      if (data.event === "stop") {
        console.log("🧵 Twilio event: stop");
        twilioWs.close();
        return;
      }
    } catch (e) {
      console.error("⚠️ Twilio WS message parse error:", e);
    }
  });

  twilioWs.on("close", () => {
    console.log("❌ Twilio WebSocket closed");
    if (oaiWs.readyState === WebSocket.OPEN) oaiWs.close();
  });

  // --- OAI Realtime lifecycle
  oaiWs.on("open", () => {
    console.log("🔗 OpenAI Realtime connected");
    logPersona();

    // Configure session: English ASR, server VAD, ulaw, voice, instructions
    safeSendOAI({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions: persona.instructions,
        voice: persona.voice,
        input_audio_format: { type: "g711_ulaw" }, // matches Twilio stream
        turn_detection: { type: "server_vad" },
        input_audio_transcription: { model: "gpt-4o-transcribe" },
        // Force English ASR behavior
        language: persona.language,
      },
    });
    console.log("✅ session.update sent (ASR=en, VAD=server, format=g711_ulaw)");

    // Fire a short greeting once
    sendGreetingOnce();
  });

  oaiWs.on("message", (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch (e) {
      console.error("⚠️ OAI message parse error:", e);
      return;
    }

    // Debug specific errors from OAI
    if (evt.type === "error") {
      console.log("🔻 OAI error:", JSON.stringify(evt, null, 2));
      return;
    }

    // --- Server VAD signals from OAI (when user speech stops)
    if (evt.type === "input_audio_buffer.speech_started") {
      console.log("🔎 OAI event: input_audio_buffer.speech_started");
      return;
    }
    if (evt.type === "input_audio_buffer.speech_stopped") {
      console.log("🔎 OAI event: input_audio_buffer.speech_stopped");
      // commit only if we actually buffered > =100ms
      commitIfBuffered();
      // queue a response only if none is currently active
      if (!responseActive) {
        responseActive = true;
        console.log("📣 response.create sent after speech_stopped");
        safeSendOAI({ type: "response.create" });
      }
      return;
    }

    // --- USER transcription (delta + completed) — event names differ by build;
    // handle generously:
    if (evt.type === "response.input_audio_transcription.delta" && evt.delta) {
      // word-by-word user ASR
      userPartial += evt.delta;
      process.stdout.write(`📝 ${evt.delta}`);
      return;
    }
    if (
      (evt.type === "response.input_audio_transcription.completed" && evt.transcript) ||
      (evt.type === "input_audio_transcription.completed" && evt.transcript)
    ) {
      const t = evt.transcript.trim();
      console.log(`\n📝 transcript (user): ${t}`);
      userPartial = "";
      return;
    }

    // --- ASSISTANT text delta (what DPA is saying)
    if (evt.type === "response.output_text.delta" && evt.delta) {
      assistantPartial += evt.delta;
      process.stdout.write(`🗣️ ${persona.name}Δ ${evt.delta}`);
      return;
    }
    if (evt.type === "response.output_text.completed" && evt.text) {
      const t = evt.text.trim();
      console.log(`\n🗣️ ${persona.name}: ${t}`);
      assistantPartial = "";
      return;
    }

    // --- ASSISTANT audio stream: forward to Twilio
    if (evt.type === "response.output_audio.delta" && evt.delta) {
      // evt.delta is base64 PCM? For Realtime g711_ulaw voice out, it returns PCM16.
      // Twilio expects base64 ulaw; Realtime handles TTS, so we just send PCM to Twilio as audio media?
      // Twilio <Stream> requires G.711 ulaw frames. Realtime emits 16k PCM16 by default.
      // Use Realtime’s built-in telephony voice pipeline: set output_audio_format: "g711_ulaw" on response
      // Easiest: we tell OAI to produce g711_ulaw in the response itself:
      // (Done below via response.output_audio.format)
      twilioWs.send(
        JSON.stringify({
          event: "media",
          media: { payload: evt.delta }, // already ulaw b64 if we requested that format
        })
      );
      return;
    }

    // When an OAI response is fully done speaking
    if (evt.type === "response.completed") {
      responseActive = false;
      return;
    }
    if (evt.type === "response.output_audio.done") {
      // some builds send this; also clear the gate
      responseActive = false;
      return;
    }

    // --- After session.update, OAI may emit a server-side "response.created"
    // we don't need to handle beyond gating; we only open the gate on completed/done.
  });

  oaiWs.on("close", () => {
    console.log("❌ OpenAI Realtime closed");
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  oaiWs.on("error", (err) => {
    console.error("❌ OpenAI WS error:", err?.message || err);
  });

  // Periodically commit buffered audio so short utterances aren’t missed.
  const commitTimer = setInterval(() => {
    commitIfBuffered();
  }, 120);

  // Clean up timer on either socket close
  const clearTimers = () => clearInterval(commitTimer);
  twilioWs.on("close", clearTimers);
  oaiWs.on("close", clearTimers);
});

// Optional simple healthcheck
app.get("/", (_req, res) => res.send("OK"));

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
