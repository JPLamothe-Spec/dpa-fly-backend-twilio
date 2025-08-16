/**
 * Twilio <-> OpenAI Realtime bridge (CommonJS)
 * Fixes:
 *  - Remove all manual input_audio_buffer.commit calls (server_vad commits)
 *  - Trigger response.create on greeting and on each VAD speech_stopped
 *  - Restore/expand transcript logging
 */

const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const path = require("path");
const http = require("http");

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

const persona = (() => {
  try {
    return require(path.resolve(__dirname, "persona.js"));
  } catch (e) {
    console.error("Failed to load persona.js:", e?.message || e);
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

// Health for Fly smoke checks
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/healthz", (_req, res) =>
  res.status(200).json({ ok: true, model: MODEL, voice: persona.voice })
);

// TwiML
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

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/call" });

function buildSystem(p) {
  return [
    p.instructions,
    `You are ${p.name}, also known as DPA.`,
    `Turn detection uses server VAD; respond after the caller finishes.`,
    `Never address the caller by any name. Do NOT call the caller "Anna".`,
    `Speak only ${p.language}. Keep replies to one short sentence + a concise follow-up.`,
    `Stay on testing the assistant's capability, quality, and response times.`,
    `JP is the creator of DPA; refer to them as "JP".`,
  ]
    .filter(Boolean)
    .join("\n");
}

wss.on("connection", (twilioWS, req) => {
  console.log(`✅ Twilio WebSocket connected from ${req.socket.remoteAddress}`);

  const oaiURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;
  const oaiWS = new WebSocket(oaiURL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  let oaiReady = false;

  // transcript buffers
  let userText = "";
  let assistantText = "";

  function logFlushUser() {
    if (userText.trim()) {
      console.log(`👤 User: ${userText.trim()}`);
      userText = "";
    }
  }
  function logFlushAssistant() {
    if (assistantText.trim()) {
      console.log(`🗣️ ${persona.name}: ${assistantText.trim()}`);
      assistantText = "";
    }
  }

  // ----- Twilio -> OpenAI -----
  twilioWS.on("message", (m) => {
    try {
      const data = JSON.parse(m.toString());

      if (data.event === "start") {
        console.log("🎬 Twilio stream START:", {
          streamSid: data.start?.streamSid,
          model: MODEL,
          voice: persona.voice,
          dev: false,
        });
        return;
      }

      if (data.event === "media" && data.media?.payload && oaiReady) {
        oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
        return;
      }

      if (data.event === "stop") {
        console.log("🧵 Twilio event: stop");
        // IMPORTANT: no manual commit when server_vad is enabled.
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
  twilioWS.on("error", (e) => console.error("❗ Twilio WS error:", e?.message || e));

  // ----- OpenAI -> Twilio -----
  function sendGreeting() {
    const text =
      persona.greeting ||
      `Hi, this is ${persona.name}. Are we testing right now, or is there a real task?`;
    const msg = {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: text,
        conversation: "none", // explicit one-off
      },
    };
    oaiWS.send(JSON.stringify(msg));
    console.log("📣 greeting response.create sent");
  }

  // When the user stops speaking, explicitly ask for a response
  function askModelToRespond() {
    const msg = {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        conversation: "auto",
      },
    };
    oaiWS.send(JSON.stringify(msg));
    console.log("📣 response.create sent after speech_stopped");
  }

  oaiWS.on("open", () => {
    console.log("🔗 OpenAI Realtime connected");
    console.log("👤 persona snapshot:", {
      name: persona.name,
      language: persona.language,
      voice: persona.voice,
      scope: persona.scope,
    });

    // set up session
    const upd = {
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: persona.voice,
        turn_detection: { type: "server_vad" },
        modalities: ["audio", "text"],
        instructions: buildSystem(persona),
      },
    };
    oaiWS.send(JSON.stringify(upd));
    console.log(`✅ session.update sent (ASR=${persona.language}, VAD=server, format=g711_ulaw)`);

    // fallback: greet if session.updated doesn’t arrive quickly
    setTimeout(() => {
      if (!oaiReady) {
        sendGreeting();
      }
    }, 300);
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
      return;
    }

    if (evt.type === "session.updated") {
      oaiReady = true;
      sendGreeting();
      return;
    }

    if (evt.type === "input_audio_buffer.speech_started") {
      console.log("🔎 OAI event: input_audio_buffer.speech_started");
      userText = "";
      return;
    }
    if (evt.type === "input_audio_buffer.speech_stopped") {
      console.log("🔎 OAI event: input_audio_buffer.speech_stopped");
      // No manual commit; ask the model to respond.
      askModelToRespond();
      return;
    }

    // user transcript
    if (evt.type === "response.input_audio_transcription.delta") {
      userText += evt.delta || "";
      return;
    }
    if (evt.type === "response.input_audio_transcription.completed") {
      logFlushUser();
      return;
    }

    // assistant text transcript
    if (evt.type === "response.output_text.delta") {
      assistantText += evt.delta || "";
      const d = (evt.delta || "").trim();
      if (d) console.log(`🗣️ ${persona.name}Δ ${d}`);
      return;
    }
    if (evt.type === "response.completed") {
      logFlushAssistant();
      return;
    }

    // assistant audio to Twilio
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
  oaiWS.on("error", (e) => console.error("❗ OpenAI WS error:", e?.message || e));
});

process.on("uncaughtException", (e) => console.error("💥 uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("💥 unhandledRejection:", e));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
