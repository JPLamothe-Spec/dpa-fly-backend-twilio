/**
 * server.js — Twilio <-> OpenAI Realtime bridge (CommonJS)
 * Fixes:
 *  - Removed node-fetch (ESM import crash)
 *  - Added GET / and /healthz for Fly smoke checks
 *  - Full transcript logging (user + assistant)
 *  - Persona alignment & “don’t call the caller Anna”
 */

const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const path = require("path");
const http = require("http");

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// --- Load persona ---
const persona = (() => {
  try {
    return require(path.resolve(__dirname, "persona.js"));
  } catch (e) {
    console.error("Failed to load persona.js; using safe defaults:", e?.message || e);
    return {
      name: "Anna",
      language: "en",
      voice: "shimmer",
      scope: "personal_assistant",
      instructions: "",
      greeting: "Hi, this is Anna. Are we testing or doing a real task?",
    };
  }
})();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- Health endpoints for Fly smoke checks ---
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});
app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true, model: OPENAI_REALTIME_MODEL, voice: persona.voice });
});

// --- TwiML: connect Twilio Media Stream to our WS endpoint ---
app.post("/twilio/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const wsUrl = `wss://${host}/call`;
  console.log("➡️ /twilio/voice hit (POST)");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" track="inbound_track" />
  </Connect>
  <Pause length="600"/>
</Response>`;
  console.log("🧾 TwiML returned:\n" + twiml);
  res.type("text/xml").send(twiml);
});

// --- HTTP server + WS server for Twilio ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/call" });

// Helpers
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

wss.on("connection", async (twilioWS, req) => {
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

  // Transcript buffers
  let currentAssistantText = "";
  let currentUserText = "";

  const flushAssistantText = (label = persona.name) => {
    const text = currentAssistantText.trim();
    if (text) {
      console.log(`🗣️ ${label}: ${text}`);
      currentAssistantText = "";
    }
  };
  const flushUserText = () => {
    const text = currentUserText.trim();
    if (text) {
      console.log(`👤 User: ${text}`);
      currentUserText = "";
    }
  };

  // Twilio -> OpenAI
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
      } else if (data.event === "media" && data.media?.payload) {
        if (!oaiConnected) {
          // Avoid noisy “readyState 0 (CONNECTING)” logs
          return;
        }
        oaiWS.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          })
        );
      } else if (data.event === "stop") {
        console.log("🧵 Twilio event: stop");
        if (oaiConnected) {
          oaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        }
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

  // OpenAI -> Twilio
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
        turn_detection: { type: "server_vad" },
        voice: persona.voice || "shimmer",
        instructions: buildSystemInstructions(persona),
        modalities: ["audio", "text"],
      },
    };
    oaiWS.send(JSON.stringify(sessionUpdate));
    console.log(
      `✅ session.update sent (ASR=${persona.language}, VAD=server, format=g711_ulaw)`
    );

    // Short greeting
    const initialGreeting =
      persona.greeting?.trim() ||
      `Hi, this is ${persona.name}. Are we testing right now, or is there a real task?`;

    oaiWS.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: initialGreeting,
          conversation: "auto",
        },
      })
    );
  });

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

    if (evt.type === "input_audio_buffer.speech_started") {
      console.log("🔎 OAI event: input_audio_buffer.speech_started");
      currentUserText = "";
    }
    if (evt.type === "input_audio_buffer.speech_stopped") {
      console.log("🔎 OAI event: input_audio_buffer.speech_stopped");
    }

    // User transcript (if model emits it)
    if (evt.type === "response.input_audio_transcription.delta") {
      currentUserText += evt.delta || "";
    }
    if (evt.type === "response.input_audio_transcription.completed") {
      flushUserText();
    }

    // Assistant text stream
    if (evt.type === "response.output_text.delta") {
      currentAssistantText += evt.delta || "";
      const chunk = (evt.delta || "").trim();
      if (chunk) console.log(`🗣️ ${persona.name}Δ ${chunk}`);
    }
    if (evt.type === "response.completed") {
      flushAssistantText(persona.name);
    }

    // Assistant audio -> Twilio
    if (evt.type === "response.output_audio.delta" && evt.delta) {
      const twilioMedia = { event: "media", media: { payload: evt.delta } };
      if (twilioWS.readyState === WebSocket.OPEN) {
        twilioWS.send(JSON.stringify(twilioMedia));
      }
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

// Process-level safety logs
process.on("uncaughtException", (e) => console.error("💥 uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("💥 unhandledRejection:", e));

// Start
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
