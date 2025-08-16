/**
 * server.js — Twilio <-> OpenAI Realtime bridge with persona.js alignment
 * - Uses persona.js (CommonJS) as single source of truth
 * - Short greeting, no caller naming, JP noted as creator
 * - Full transcript logging (assistant + user)
 * - Keeps audio passthrough g711_ulaw and server VAD
 */

const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const fetch = require("node-fetch");
const path = require("path");
const http = require("http");

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// ---- Load persona.js (CommonJS) ----
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

// --- TwiML: connect Twilio Media Stream to our WS endpoint ---
app.post("/twilio/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const wsUrl = `wss://${host}/call`; // IMPORTANT: secure wss
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

// Utility: build strict system instructions aligned with persona
function buildSystemInstructions(p) {
  return [
    p.instructions?.trim() || "",
    `You are ${p.name}, also known as DPA.`,
    `Mode: Test Mode unless caller explicitly requests a real task.`,
    `Never address the caller by any name. Do not call the caller "Anna"; "Anna" is your own name.`,
    `Speak only ${p.language || "en"}. Keep replies to one short sentence, then a concise follow-up question.`,
    `Stay on-topic for testing capability, quality, and response times.`,
    `If unclear, ask one brief, targeted question.`,
    `JP is the creator of DPA. If you refer to JP, call them "JP".`,
  ]
    .filter(Boolean)
    .join("\n");
}

// --- Bridge: Twilio WS <-> OpenAI Realtime WS ---
wss.on("connection", async (twilioWS, req) => {
  const remoteAddr = req.socket.remoteAddress;
  console.log(`✅ Twilio WebSocket connected from ${remoteAddr}`);

  // Create OpenAI Realtime WS
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

  // Buffers for transcript logging
  let currentAssistantText = "";
  let currentUserText = "";

  // Helper: flush assistant text to logs
  const flushAssistantText = (label = persona.name) => {
    const text = currentAssistantText.trim();
    if (text) {
      console.log(`🗣️ ${label}: ${text}`);
      currentAssistantText = "";
    }
  };

  // Helper: flush user text to logs
  const flushUserText = () => {
    const text = currentUserText.trim();
    if (text) {
      console.log(`👤 User: ${text}`);
      currentUserText = "";
    }
  };

  // ---- Twilio -> OpenAI audio handling ----
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
          console.log("⚠️ append failed: OpenAI WS not ready yet");
          return;
        }
        // Forward G.711 ulaw audio frames (base64) directly
        oaiWS.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          })
        );
      } else if (data.event === "mark" || data.event === "ping") {
        // ignore
      } else if (data.event === "stop") {
        console.log("🧵 Twilio event: stop");
        if (oaiConnected) {
          // Let OAI finalize any pending input
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

  // ---- OpenAI Realtime events ----
  oaiWS.on("open", () => {
    oaiConnected = true;
    console.log("🔗 OpenAI Realtime connected");

    // session.update — configure formats, VAD, voice, and system instructions
    const sessionUpdate = {
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw", // IMPORTANT: string, not object
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad" },
        voice: persona.voice || "shimmer",
        instructions: buildSystemInstructions(persona),
        // Ensure the model can speak and produce text
        modalities: ["audio", "text"],
      },
    };
    oaiWS.send(JSON.stringify(sessionUpdate));
    console.log(
      `✅ session.update sent (ASR=${persona.language}, VAD=server, format=g711_ulaw)`
    );

    // Send initial short greeting from persona
    const initialGreeting =
      persona.greeting && persona.greeting.trim()
        ? persona.greeting.trim()
        : `Hi, this is ${persona.name}. Are we testing right now, or is there a real task?`;

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

    // Debug low-level errors
    if (evt.type === "error") {
      console.log("🔻 OAI error:", JSON.stringify(evt, null, 2));
    }

    // VAD indicators (useful in logs)
    if (evt.type === "input_audio_buffer.speech_started") {
      console.log("🔎 OAI event: input_audio_buffer.speech_started");
      // start fresh user buffer
      currentUserText = "";
    }
    if (evt.type === "input_audio_buffer.speech_stopped") {
      console.log("🔎 OAI event: input_audio_buffer.speech_stopped");
      // Let the model process; transcript will come via transcription events
    }

    // --- USER transcript (real-time deltas & final) ---
    // Newer Realtime models emit transcription as:
    //   response.input_audio_transcription.delta / .completed
    if (evt.type === "response.input_audio_transcription.delta") {
      currentUserText += evt.delta || "";
    }
    if (evt.type === "response.input_audio_transcription.completed") {
      flushUserText();
    }

    // --- ASSISTANT text output (deltas & final) ---
    if (evt.type === "response.output_text.delta") {
      // Accumulate assistant text deltas to log human-readable lines
      currentAssistantText += evt.delta || "";
      // Optional: live token stream marker (compact)
      const chunk = (evt.delta || "").trim();
      if (chunk) {
        // Show compact live chunks in one line with a Δ marker
        console.log(`🗣️ ${persona.name}Δ ${chunk}`);
      }
    }
    if (evt.type === "response.completed") {
      // Finalize assistant output line
      flushAssistantText(persona.name);
    }

    // --- ASSISTANT audio (forward to Twilio) ---
    if (evt.type === "response.output_audio.delta" && evt.delta) {
      // evt.delta is base64 g711_ulaw data
      // Wrap into Twilio "media" message format
      const twilioMedia = {
        event: "media",
        media: { payload: evt.delta },
      };
      if (twilioWS.readyState === WebSocket.OPEN) {
        twilioWS.send(JSON.stringify(twilioMedia));
      }
    }

    // When the model wants to speak or proceed, it may emit tool/response states; no extra action needed here
  });

  oaiWS.on("close", () => {
    console.log("❌ OpenAI Realtime closed");
    if (twilioWS.readyState === WebSocket.OPEN) twilioWS.close();
  });

  oaiWS.on("error", (err) => {
    console.error("❗ OpenAI WS error:", err?.message || err);
  });
});

// ---- Start server ----
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
