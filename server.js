// server.js (CommonJS) — Twilio <-> OpenAI Realtime bridge w/ persona, testing-mode, concise logs
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

// --- Load persona.json (defaults if missing) ---
function loadPersona() {
  try {
    const p = path.resolve(__dirname, "persona.json");
    const raw = fs.readFileSync(p, "utf8");
    const persona = JSON.parse(raw || "{}");
    return {
      name: persona.name || "Anna",
      language: persona.language || "en",
      voice: persona.voice || "shimmer",
      scope: persona.scope || "personal_assistant",
      instructions: persona.instructions || "",
    };
  } catch {
    return {
      name: "Anna",
      language: "en",
      voice: "shimmer",
      scope: "personal_assistant",
      instructions: "",
    };
  }
}

const persona = loadPersona();

const app = express();

// Twilio webhook: return TwiML that starts a bidirectional media stream
app.post("/twilio/voice", express.urlencoded({ extended: false }), (req, res) => {
  const wsUrl = `${req.protocol === "https" ? "wss" : "ws"}://${req.get("host")}/call`;
  const twiml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<Response>" +
    `  <Connect>` +
    `    <Stream url="${wsUrl}" track="inbound_track" />` +
    `  </Connect>` +
    // Keep the call open; the model talks back over the stream
    `  <Pause length="600"/>` +
    "</Response>";
  console.log("➡️ /twilio/voice hit (POST)");
  console.log("🧾 TwiML returned:\n" + twiml);
  res.type("text/xml").send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/call" });

// 20ms per Twilio frame @ 8kHz PCMU -> 160 bytes
const TWILIO_FRAME_BYTES = 160;

// Utility: chunk a Buffer into fixed sizes
function* chunksOf(buf, size) {
  for (let i = 0; i < buf.length; i += size) {
    yield buf.subarray(i, Math.min(i + size, buf.length));
  }
}

// Compose strict, test-focused instructions derived from persona + improvements
function buildSystemInstructions(p) {
  const lines = [
    // Persona base
    p.instructions?.trim() || "",
    // Identity & role clarity
    `You are ${p.name}, also known as DPA.`,
    `You are part of our dev team and currently in TESTING MODE.`,
    `JP is the creator of DPA. Address the caller as "you" (do NOT guess their name).`,
    `Do NOT call the user "${p.name}" — that's your own name.`,
    // Language & tone
    `Speak only ${p.language === "en" ? "English" : p.language}. Keep responses concise (ideally 1 short sentence).`,
    // Scope & behavior
    `Stay on-topic for testing DPA's capability, quality, and response times.`,
    `Acknowledge testing context when appropriate. Avoid unrelated suggestions or tutorials unless asked.`,
    `If unclear, ask a brief, targeted question instead of rambling.`,
  ]
    .filter(Boolean)
    .join("\n");
  return lines;
}

wss.on("connection", (twilioWS, req) => {
  const remote = req.socket.remoteAddress;
  console.log(`✅ Twilio WebSocket connected from ${remote}`);

  // Connect to OpenAI Realtime (WS)
  const oaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OAI_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let streamSid = null;

  // Buffer inbound Twilio audio frames and batch-send to OpenAI (server VAD handles commits)
  let inboundBuf = Buffer.alloc(0);
  let inboundFrames = 0;

  const flushInbound = () => {
    if (inboundFrames === 0) return;
    const b64 = inboundBuf.toString("base64");
    try {
      oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      console.log(`🔊 appended +${inboundFrames} frame(s) (~${inboundFrames * 20}ms chunk)`);
    } catch {}
    inboundBuf = Buffer.alloc(0);
    inboundFrames = 0;
  };

  // --- Twilio WS handlers ---
  twilioWS.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start": {
        streamSid = msg.start?.streamSid;
        console.log("🎬 Twilio stream START:", {
          streamSid,
          model: OAI_MODEL,
          voice: persona.voice || "shimmer",
          dev: false,
        });
        break;
      }
      case "media": {
        const payloadB64 = msg.media?.payload;
        if (!payloadB64) return;
        const chunk = Buffer.from(payloadB64, "base64");
        if (chunk.length === 0) return;
        inboundBuf = Buffer.concat([inboundBuf, chunk]);
        inboundFrames += Math.floor(chunk.length / TWILIO_FRAME_BYTES);
        if (inboundFrames >= 10) flushInbound(); // ~200ms
        break;
      }
      case "stop": {
        console.log("🧵 Twilio event: stop");
        flushInbound();
        try {
          twilioWS.close();
        } catch {}
        try {
          oaiWS.close();
        } catch {}
        break;
      }
    }
  });

  twilioWS.on("close", () => {
    console.log("❌ Twilio WebSocket closed");
    try {
      oaiWS.close();
    } catch {}
  });

  twilioWS.on("error", (e) => {
    console.log("⚠️ Twilio WS error:", e?.message || e);
  });

  // --- OpenAI WS handlers ---
  oaiWS.on("open", () => {
    console.log("🔗 OpenAI Realtime connected");

    const systemInstructions = buildSystemInstructions(persona);

    // Log the persona snapshot for this call
    console.log("👤 persona snapshot:", {
      name: persona.name,
      language: persona.language,
      voice: persona.voice,
      scope: persona.scope,
      instructions: systemInstructions.split("\n").join(" "),
    });

    // Configure session (use STRING formats to avoid invalid_type)
    oaiWS.send(
      JSON.stringify({
        type: "session.update",
        session: {
          // Server-side VAD, snappy for testing
          turn_detection: {
            type: "server_vad",
            prefix_padding_ms: 250,
            silence_duration_ms: 220,
          },
          // G.711 µ-law in/out (Twilio)
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",

          // Force ASR language to persona.language
          input_audio_transcription: {
            model: "gpt-4o-mini-transcribe",
            language: persona.language || "en",
          },

          // Voice and general system style
          voice: persona.voice || "shimmer",
          instructions: systemInstructions,
        },
      })
    );

    // Tight greeting to prevent “rant”
    // Use conversation:"auto" (object caused errors in preview builds)
    oaiWS.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `Hi, I'm ${persona.name}. We're in testing mode, JP — what would you like to try first?`,
          conversation: "auto",
        },
      })
    );

    console.log("✅ session.update sent (ASR=persona.language, VAD=server, format=g711_ulaw)");
  });

  // Assemble assistant transcript lines per response for clearer logs
  let currentAssistantLine = "";

  oaiWS.on("message", (data) => {
    let evt;
    try {
      evt = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (evt.type?.startsWith("error")) {
      console.log("🔻 OAI error:", JSON.stringify(evt, null, 2));
      return;
    }

    // Speech boundary markers (user speaking)
    if (
      evt.type === "input_audio_buffer.speech_started" ||
      evt.type === "input_audio_buffer.speech_stopped"
    ) {
      console.log(`🔎 OAI event: ${evt.type}`);
      return;
    }

    // Forward assistant audio deltas to Twilio (20ms PCMU frames)
    if (
      evt.type === "response.audio.delta" ||
      evt.type === "response.output_audio.delta" ||
      evt.type === "output_audio.delta"
    ) {
      const b64 = evt.delta || evt.audio;
      if (!b64) return;
      const pcmu = Buffer.from(b64, "base64");
      for (const frame of chunksOf(pcmu, TWILIO_FRAME_BYTES)) {
        const mediaMsg = { event: "media", streamSid, media: { payload: frame.toString("base64") } };
        try {
          twilioWS.send(JSON.stringify(mediaMsg));
        } catch {}
      }
      return;
    }

    // Assistant transcript (audio the model is sending back)
    if (evt.type === "response.audio_transcript.delta" && evt.delta) {
      // Use a compact, visible marker; avoid flooding but keep readable
      process.stdout.write(`🗣️ ${persona.name}Δ ${evt.delta}`);
      currentAssistantLine += evt.delta;
      return;
    }
    if (evt.type === "response.audio_transcript.done") {
      if (currentAssistantLine.trim()) {
        console.log(`\n🗣️ ${persona.name}: ${currentAssistantLine.trim()}`);
      } else {
        console.log(`\n🗣️ ${persona.name}: [no transcript text]`);
      }
      currentAssistantLine = "";
      return;
    }

    // (Optional) other response.* events can be verbose in preview builds — keep quiet unless needed
  });

  oaiWS.on("close", () => {
    console.log("❌ OpenAI Realtime closed");
    try {
      twilioWS.close();
    } catch {}
  });

  oaiWS.on("error", (e) => {
    console.log("⚠️ OAI WS error:", e?.message || e);
  });

  // Heartbeats keep both sides healthy
  const twilioPing = setInterval(() => {
    if (twilioWS.readyState === WebSocket.OPEN) {
      try {
        twilioWS.ping();
      } catch {}
    }
  }, 15000);
  const oaiPing = setInterval(() => {
    if (oaiWS.readyState === WebSocket.OPEN) {
      try {
        oaiWS.ping();
      } catch {}
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(twilioPing);
    clearInterval(oaiPing);
  };
  twilioWS.on("close", cleanup);
  oaiWS.on("close", cleanup);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Listening on 0.0.0.0:${PORT}`);
  console.log(`POST /twilio/voice -> returns TwiML`);
  console.log(`WS   /call        -> Twilio Media Stream entrypoint`);
});
