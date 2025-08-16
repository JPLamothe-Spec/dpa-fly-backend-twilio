/**
 * server.js — Twilio <-> OpenAI Realtime bridge (CommonJS)
 * Changes:
 *  - Wait for session readiness before greeting (fixes “silent” start)
 *  - Restore live transcript logging (user + assistant)
 *  - Guard against empty commits (no more input_audio_buffer_commit_empty)
 *  - Health endpoints for Fly smoke checks
 *  - “Don’t call the caller Anna” guardrails aligned with persona.js
 */

const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const path = require("path");
const http = require("http");

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// --- Load persona (must be CommonJS) ---
const persona = (() => {
  try {
    return require(path.resolve(__dirname, "persona.js"));
  } catch (e) {
    console.error("Failed to load persona.js; using safe defaults:", e?.message || e);
    return {
      name: "Anna",
      language: "en",
      voice: "shimmer",
      scope: "dev_test_personal_assistant",
      instructions: "",
      greeting: "Hi, this is Anna. Are we testing or doing a real task?",
    };
  }
})();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- Health endpoints so Fly smoke checks pass ---
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/healthz", (_req, res) =>
  res.status(200).json({ ok: true, model: OPENAI_REALTIME_MODEL, voice: persona.voice })
);

// --- TwiML to connect Media Streams to our WS endpoint ---
app.post("/twilio/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const wsUrl = `wss://${host}/call`;

  console.log("➡️ /twilio/voice hit (POST)");
  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Response>\n` +
    `  <Connect>\n` +
    `    <Stream url="${wsUrl}" track="inbound_track" />\n` +
    `  </Connect>\n` +
    `  <Pause length="600"/>\n` +
    `</Response>`;
  console.log("🧾 TwiML returned:\n" + twiml);
  res.type("text/xml").send(twiml);
});

// --- HTTP + WS servers ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/call" });

// Build final system prompt from persona
function buildSystemInstructions(p) {
  return [
    p.instructions?.trim() || "",
    `You are ${p.name}, also known as DPA.`,
    `Default to Test Mode unless caller requests a real task.`,
    `Never address the caller by any name. Do NOT call the caller "Anna" — that's your own name.`,
    `Speak only ${p.language || "en"}. Keep replies to one short sentence, then a concise follow-up question.`,
    `Stay on-topic for testing capability, quality, and response times.`,
    `If unclear, ask one brief, targeted question.`,
    `JP is the creator of DPA; refer to them as "JP".`,
  ]
    .filter(Boolean)
    .join("\n");
}

wss.on("connection", (twilioWS, req) => {
  const remoteAddr = req.socket.remoteAddress;
  console.log(`✅ Twilio WebSocket connected from ${remoteAddr}`);

  // Connect to OpenAI Realtime
  const oaiURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    OPENAI_REALTIME_MODEL
  )}`;
  const oaiWS = new WebSocket(oaiURL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  let oaiConnected = false;
  let sessionReady = false;

  // Media/frame accounting
  let framesSinceLog = 0;
  let msSinceLog = 0;
  let audioBufferedSinceLastCommit = false;

  // Transcript buffers
  let currentAssistantText = "";
  let currentUserText = "";

  function flushAssistantText() {
    const text = currentAssistantText.trim();
    if (text) {
      console.log(`🗣️ ${persona.name}: ${text}`);
      currentAssistantText = "";
    }
  }
  function flushUserText() {
    const text = currentUserText.trim();
    if (text) {
      console.log(`👤 User: ${text}`);
      currentUserText = "";
    }
  }

  // ---------- Twilio -> OpenAI ----------
  twilioWS.on("message", (msg) => {
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

      if (data.event === "media" && data.media?.payload) {
        if (!oaiConnected) return; // drop until OAI is ready

        // forward to OpenAI
        oaiWS.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          })
        );

        // logging cadence ~= 10 frames -> ~200ms
        framesSinceLog += 1;
        msSinceLog += 20; // Twilio frames are ~20ms
        audioBufferedSinceLastCommit = true;
        if (framesSinceLog >= 10) {
          console.log(`🔊 appended +${framesSinceLog} frame(s) (~${msSinceLog}ms chunk)`);
          framesSinceLog = 0;
          msSinceLog = 0;
        }
        return;
      }

      if (data.event === "stop") {
        console.log("🧵 Twilio event: stop");
        // Only commit if we actually buffered audio
        if (oaiConnected && audioBufferedSinceLastCommit) {
          oaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          audioBufferedSinceLastCommit = false;
        }
        return;
      }
    } catch (e) {
      console.error("❗ Twilio message parse error:", e);
    }
  });

  twilioWS.on("close", () => {
    console.log("❌ Twilio WebSocket closed");
    if (oaiWS.readyState === WebSocket.OPEN) oaiWS.close();
  });
  twilioWS.on("error", (err) => {
    console.error("❗ Twilio WS error:", err?.message || err);
  });

  // ---------- OpenAI -> Twilio ----------
  oaiWS.on("open", () => {
    oaiConnected = true;
    console.log("🔗 OpenAI Realtime connected");
    console.log("👤 persona snapshot:", {
      name: persona.name,
      language: persona.language,
      voice: persona.voice,
      scope: persona.scope,
    });

    const sessionUpdate = {
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: persona.voice || "shimmer",
        turn_detection: { type: "server_vad" },
        modalities: ["audio", "text"],
        instructions: buildSystemInstructions(persona),
      },
    };
    oaiWS.send(JSON.stringify(sessionUpdate));
    console.log(`✅ session.update sent (ASR=${persona.language}, VAD=server, format=g711_ulaw)`);

    // If we don't receive session.updated quickly, send greeting anyway
    setTimeout(() => {
      if (!sessionReady) sendGreeting();
    }, 250);
  });

  function sendGreeting() {
    const initialGreeting =
      persona.greeting?.trim() ||
      `Hi, this is ${persona.name}. Are we testing right now, or is there a real task?`;
    const create = {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: initialGreeting,
        conversation: "auto",
      },
    };
    oaiWS.send(JSON.stringify(create));
  }

  oaiWS.on("message", (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (evt.type === "error") {
      console.log("🔻 OAI error:", JSON.stringify(evt, null, 2));
    }

    if (evt.type === "session.updated") {
      sessionReady = true;
      // greet once session is definitely ready
      sendGreeting();
      return;
    }

    if (evt.type === "input_audio_buffer.speech_started") {
      console.log("🔎 OAI event: input_audio_buffer.speech_started");
      currentUserText = "";
      return;
    }
    if (evt.type === "input_audio_buffer.speech_stopped") {
      console.log("🔎 OAI event: input_audio_buffer.speech_stopped");
      return;
    }

    // --- User transcript (if emitted by API) ---
    if (evt.type === "response.input_audio_transcription.delta") {
      currentUserText += evt.delta || "";
      return;
    }
    if (evt.type === "response.input_audio_transcription.completed") {
      flushUserText();
      return;
    }

    // --- Assistant text stream ---
    if (evt.type === "response.output_text.delta") {
      currentAssistantText += evt.delta || "";
      const chunk = (evt.delta || "").trim();
      if (chunk) console.log(`🗣️ ${persona.name}Δ ${chunk}`);
      return;
    }
    if (evt.type === "response.completed") {
      flushAssistantText();
      return;
    }

    // --- Assistant audio -> Twilio ---
    if (evt.type === "response.output_audio.delta" && evt.delta) {
      if (twilioWS.readyState === WebSocket.OPEN) {
        twilioWS.send(JSON.stringify({ event: "media", media: { payload: evt.delta } }));
      }
      return;
    }
  });

  oaiWS.on("close", () => {
    console.log("❌ OpenAI Realtime closed");
    if (twilioWS.readyState === WebSocket.OPEN) twilioWS.close();
  });
  oaiWS.on("error", (err) => {
    console.error("❗ OpenAI WS error:", err?.message || err);
  });
});

// Safety logs
process.on("uncaughtException", (e) => console.error("💥 uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("💥 unhandledRejection:", e));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
