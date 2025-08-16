// server.js — Twilio <-> OpenAI Realtime bridge (CommonJS, port 3000)
// Reconciled baseline: wss forced, persona-aware, verbose live logs, short intro, testing mode.

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

// --- Persona loading (persona.json) ---
function loadPersona() {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, "persona.json"), "utf8");
    const p = JSON.parse(raw || "{}");
    return {
      name: p.name || "Anna",
      language: p.language || "en",
      voice: p.voice || "shimmer",
      scope: p.scope || "personal_assistant",
      instructions: p.instructions || "",
    };
  } catch {
    return { name: "Anna", language: "en", voice: "shimmer", scope: "personal_assistant", instructions: "" };
  }
}
const persona = loadPersona();

const app = express();
app.set("trust proxy", true);

// Health
app.get("/", (_req, res) => res.status(200).send("OK"));

// Twilio webhook -> TwiML (ALWAYS wss://)
app.post("/twilio/voice", express.urlencoded({ extended: false }), (req, res) => {
  const wsUrl = `wss://${req.get("host")}/call`;
  const twiml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<Response>" +
    `  <Connect>` +
    `    <Stream url="${wsUrl}" track="inbound_track" />` +
    `  </Connect>` +
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

// Build strict, test-focused instructions
function buildSystemInstructions(p) {
  return [
    p.instructions?.trim() || "",
    `You are ${p.name}, also known as DPA.`,
    `You are part of our dev team and currently in TESTING MODE.`,
    `JP is the creator of DPA. Address the caller as "you"; do NOT guess their name.`,
    `Do NOT call the user "${p.name}" — that's your own name.`,
    `Speak only ${p.language === "en" ? "English" : p.language}. Keep replies very concise (ideally 1 short sentence).`,
    `Stay on-topic for testing capability, quality, and response times. No unrelated suggestions unless asked.`,
    `If unclear, ask one brief, targeted question.`,
  ]
    .filter(Boolean)
    .join("\n");
}

wss.on("connection", (twilioWS, req) => {
  const remote = req.socket.remoteAddress;
  console.log(`✅ Twilio WebSocket connected from ${remote}`);

  // Connect to OpenAI Realtime
  const oaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OAI_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  let streamSid = null;
  // Buffer inbound Twilio audio frames and batch-send to OpenAI (no commits; server VAD on)
  let inboundBuf = Buffer.alloc(0);
  let inboundFrames = 0;

  const flushInbound = () => {
    if (inboundFrames === 0) return;
    try {
      oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: inboundBuf.toString("base64") }));
      console.log(`🔊 appended +${inboundFrames} frame(s) (~${inboundFrames * 20}ms chunk)`);
    } catch (e) {
      console.log("⚠️ append failed:", e?.message || e);
    }
    inboundBuf = Buffer.alloc(0);
    inboundFrames = 0;
  };

  // --- Twilio WS handlers ---
  twilioWS.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.event) {
      case "start": {
        streamSid = msg.start?.streamSid;
        console.log("🎬 Twilio stream START:", { streamSid, model: OAI_MODEL, voice: persona.voice, dev: false });
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
      case "mark": {
        // optional: Twilio <Mark> events if ever used
        console.log("🏷️ Twilio mark:", msg.mark?.name || "(no name)");
        break;
      }
      case "stop": {
        console.log("🧵 Twilio event: stop");
        flushInbound();
        try { twilioWS.close(); } catch {}
        try { oaiWS.close(); } catch {}
        break;
      }
      default:
        // other Twilio events (e.g., dtmf) are ignored
        break;
    }
  });

  twilioWS.on("close", () => {
    console.log("❌ Twilio WebSocket closed");
    try { oaiWS.close(); } catch {}
  });
  twilioWS.on("error", (e) => console.log("⚠️ Twilio WS error:", e?.message || e));
  twilioWS.on("pong", () => { /* keep-alive */ });

  // --- OpenAI WS handlers ---
  oaiWS.on("open", () => {
    console.log("🔗 OpenAI Realtime connected");

    const systemInstructions = buildSystemInstructions(persona);
    console.log("👤 persona snapshot:", {
      name: persona.name,
      language: persona.language,
      voice: persona.voice,
      scope: persona.scope,
      instructions: systemInstructions.replace(/\s+/g, " "),
    });

    // Use string formats & conversation:"auto" to avoid invalid_type errors seen earlier
    oaiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad", prefix_padding_ms: 250, silence_duration_ms: 220 },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "gpt-4o-mini-transcribe", language: persona.language || "en" },
        voice: persona.voice || "shimmer",
        instructions: systemInstructions,
      },
    }));

    // Short greeting (no ramble)
    oaiWS.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Hi, I'm ${persona.name}. We're in testing mode, JP — what would you like to try first?`,
        conversation: "auto",
      },
    }));

    console.log("✅ session.update sent (ASR=persona.language, VAD=server, format=g711_ulaw)");
  });

  // Stream assistant transcript to logs
  let currentAssistantLine = "";
  oaiWS.on("message", (data) => {
    let evt; try { evt = JSON.parse(data.toString()); } catch { return; }

    if (evt.type?.startsWith("error")) {
      console.log("🔻 OAI error:", JSON.stringify(evt, null, 2));
      return;
    }

    // Useful VAD boundaries for debugging
    if (evt.type === "input_audio_buffer.speech_started" || evt.type === "input_audio_buffer.speech_stopped") {
      console.log(`🔎 OAI event: ${evt.type}`);
      return;
    }

    // Forward audio back to Twilio in 20ms frames
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
        try { twilioWS.send(JSON.stringify(mediaMsg)); } catch {}
      }
      return;
    }

    // Assistant transcript (delta + final line)
    if (evt.type === "response.audio_transcript.delta" && evt.delta) {
      process.stdout.write(`🗣️ ${persona.name}Δ ${evt.delta}`);
      currentAssistantLine += evt.delta;
      return;
    }
    if (evt.type === "response.audio_transcript.done") {
      console.log(`\n🗣️ ${persona.name}: ${currentAssistantLine.trim() || "[no transcript text]"}`);
      currentAssistantLine = "";
      return;
    }

    // Optionally log other response.* events (muted by default)
    // if (evt.type?.startsWith("response.")) console.log("ℹ️", evt.type);
  });

  oaiWS.on("close", () => {
    console.log("❌ OpenAI Realtime closed");
    try { twilioWS.close(); } catch {}
  });
  oaiWS.on("error", (e) => console.log("⚠️ OAI WS error:", e?.message || e));

  // Heartbeats
  const twilioPing = setInterval(() => {
    if (twilioWS.readyState === WebSocket.OPEN) { try { twilioWS.ping(); } catch {} }
  }, 15000);
  const oaiPing = setInterval(() => {
    if (oaiWS.readyState === WebSocket.OPEN) { try { oaiWS.ping(); } catch {} }
  }, 15000);
  const cleanup = () => { clearInterval(twilioPing); clearInterval(oaiPing); };
  twilioWS.on("close", cleanup);
  oaiWS.on("close", cleanup);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Listening on 0.0.0.0:${PORT}`);
  console.log(`POST /twilio/voice -> returns TwiML`);
  console.log(`WS   /call        -> Twilio Media Stream entrypoint`);
});
