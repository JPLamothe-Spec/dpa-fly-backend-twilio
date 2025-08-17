// server.js (CommonJS) — Twilio <-> OpenAI Realtime with server VAD, ulaw, and persona alignment
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const persona = require("./persona"); // <- uses your persona.js

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const app = express();
app.set("trust proxy", true);

// Health
app.get("/healthz", (_, res) => res.status(200).send("ok"));

// Twilio webhook -> start Media Stream
app.post("/twilio/voice", express.urlencoded({ extended: false }), (req, res) => {
  const xfProto = (req.get("x-forwarded-proto") || "").split(",")[0].trim();
  const scheme = xfProto === "http" ? "ws" : "wss"; // prefer wss
  const wsUrl = `${scheme}://${req.get("host")}/call`;

  const twiml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Connect>`,
    `    <Stream url="${wsUrl}" track="inbound_track" />`,
    `  </Connect>`,
    `  <Pause length="600"/>`,
    "</Response>",
  ].join("");

  console.log("➡️ /twilio/voice hit (POST)");
  console.log("🧾 TwiML returned:\n" + twiml);
  res.type("text/xml").send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/call" });

// Twilio PCMU: 20ms at 8kHz -> 160 bytes
const TWILIO_FRAME_BYTES = 160;

// chunk helper
function* chunksOf(buf, size) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, Math.min(i + size, buf.length));
}

wss.on("connection", (twilioWS, req) => {
  console.log(`✅ Twilio WebSocket connected from ${req.socket.remoteAddress}`);

  // Connect to OpenAI Realtime
  const oaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OAI_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  let oaiReady = false;
  let streamSid = null;

  // prevent overlapping response.create
  let responseActive = false;
  let greeted = false;

  // live transcript buffers
  let userPartial = "";
  let asstPartial = "";

  // batch input audio for server VAD (append only)
  let inboundBuf = Buffer.alloc(0);
  let inboundFrames = 0;

  const flushInbound = () => {
    if (!inboundFrames) return;
    if (!oaiReady || oaiWS.readyState !== WebSocket.OPEN) {
      // keep buffer until OpenAI socket is open
      return;
    }
    const b64 = inboundBuf.toString("base64");
    try {
      oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      console.log(`🔊 appended ${inboundFrames} frame(s) ≈${inboundFrames * 20}ms (${inboundBuf.length} bytes)`);
      inboundBuf = Buffer.alloc(0);
      inboundFrames = 0;
    } catch {}
  };

  const queueInbound = (chunk) => {
    inboundBuf = Buffer.concat([inboundBuf, chunk]);
    inboundFrames += Math.floor(chunk.length / TWILIO_FRAME_BYTES);
    if (inboundFrames >= 10) flushInbound(); // ~200ms
  };

  const sendGreetingOnce = () => {
    if (greeted || responseActive || !oaiReady) return;
    greeted = true;
    responseActive = true;
    console.log("📣 greeting response.create sent");
    oaiWS.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        conversation: "auto",
        instructions: persona.greeting,         // <- short dev greeting
        output_audio_format: "g711_ulaw",
      },
    }));
  };

  // ---- Twilio handlers ----
  twilioWS.on("message", (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.event) {
      case "start": {
        streamSid = msg.start?.streamSid;
        console.log("🎬 Twilio stream START:", {
          streamSid,
          model: OAI_MODEL,
          voice: persona.voice,
          dev: false,
        });
        break;
      }
      case "media": {
        const payloadB64 = msg.media?.payload;
        if (!payloadB64) return;
        const chunk = Buffer.from(payloadB64, "base64");
        if (!chunk.length) return;
        queueInbound(chunk);
        break;
      }
      case "stop": {
        console.log("🧵 Twilio event: stop");
        flushInbound();
        try { twilioWS.close(); } catch {}
        try { oaiWS.close(); } catch {}
        break;
      }
    }
  });

  twilioWS.on("close", () => { console.log("❌ Twilio WebSocket closed"); try { oaiWS.close(); } catch {} });
  twilioWS.on("error", (e) => console.log("⚠️ Twilio WS error:", e?.message || e));

  // ---- OpenAI handlers ----
  oaiWS.on("open", () => {
    oaiReady = true;
    console.log("🔗 OpenAI Realtime connected");
    console.log("👤 persona snapshot:", {
      name: persona.name,
      language: persona.language,
      voice: persona.voice,
      scope: persona.scope,
    });

    // Session config aligned with persona
    oaiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        // Server VAD
        turn_detection: { type: "server_vad", prefix_padding_ms: 300, silence_duration_ms: 200 },
        // Formats MUST be strings
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        // English-only ASR
        input_audio_transcription: { model: "gpt-4o-mini-transcribe", language: persona.language },
        // Voice + behavior
        voice: persona.voice,
        language: persona.language,
        instructions: persona.instructions,     // <- full behavior contract (incl. “don’t call user Anna”)
        modalities: ["audio", "text"],
      },
    }));
    console.log("✅ session.update sent (ASR=en, VAD=server, format=g711_ulaw)");

    // Flush any audio buffered before OAI was ready
    flushInbound();

    // Single, short greeting
    sendGreetingOnce();
  });

  oaiWS.on("message", (data) => {
    let evt; try { evt = JSON.parse(data.toString()); } catch { return; }

    if (evt.type?.startsWith("error") || evt.type === "error") {
      console.log("🔻 OAI error:", JSON.stringify(evt, null, 2));
      return;
    }

    // VAD events (for visibility)
    if (evt.type === "input_audio_buffer.speech_started") {
      console.log("🔎 OAI event: input_audio_buffer.speech_started");
      return;
    }
    if (evt.type === "input_audio_buffer.speech_stopped") {
      console.log("🔎 OAI event: input_audio_buffer.speech_stopped");
      flushInbound();
      if (!responseActive) {
        responseActive = true;
        console.log("📣 response.create sent after speech_stopped");
        oaiWS.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            conversation: "auto",
            output_audio_format: "g711_ulaw",
          },
        }));
      }
      return;
    }

    // --- USER transcript events (handle multiple possible shapes) ---
    if (evt.type === "response.input_audio_transcription.delta" && evt.delta) {
      userPartial += evt.delta;
      process.stdout.write(`📝 ${evt.delta}`);
      return;
    }
    if (
      (evt.type === "response.input_audio_transcription.completed" && evt.transcript) ||
      (evt.type === "input_audio_transcription.completed" && evt.transcript) ||
      (evt.type === "response.audio_transcript.done" && evt.transcript) ||
      (evt.type === "response.transcript.completed" && evt.transcript)
    ) {
      console.log(`\n📝 transcript (user): ${evt.transcript.trim()}`);
      userPartial = "";
      return;
    }

    // --- ASSISTANT text (what Anna says) ---
    if (evt.type === "response.output_text.delta" && evt.delta) {
      asstPartial += evt.delta;
      process.stdout.write(`🗣️ ${persona.name}Δ ${evt.delta}`);
      return;
    }
    if (
      (evt.type === "response.output_text.completed" && evt.text) ||
      (evt.type === "response.completed" && evt.output_text)
    ) {
      const text = evt.text || evt.output_text || "";
      console.log(`\n🗣️ ${persona.name}: ${text.trim()}`);
      asstPartial = "";
      return;
    }

    // --- ASSISTANT audio (µ-law) -> Twilio ---
    if (
      evt.type === "response.output_audio.delta" ||
      evt.type === "response.audio.delta" ||
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

    // --- Response lifecycle: release the gate when done ---
    if (
      evt.type === "response.completed" ||
      evt.type === "response.output_audio.done" ||
      evt.type === "response.finalize"
    ) {
      responseActive = false;
      return;
    }
  });

  oaiWS.on("close", () => { console.log("❌ OpenAI Realtime closed"); try { twilioWS.close(); } catch {} });
  oaiWS.on("error", (e) => console.log("⚠️ OAI WS error:", e?.message || e));

  // Heartbeats
  const twilioPing = setInterval(() => {
    if (twilioWS.readyState === WebSocket.OPEN) try { twilioWS.ping(); } catch {}
  }, 15000);
  const oaiPing = setInterval(() => {
    if (oaiWS.readyState === WebSocket.OPEN) try { oaiWS.ping(); } catch {}
  }, 15000);

  const cleanup = () => { clearInterval(twilioPing); clearInterval(oaiPing); };
  twilioWS.on("close", cleanup);
  oaiWS.on("close", cleanup);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Listening on 0.0.0.0:${PORT}`);
  console.log(`POST /twilio/voice -> returns TwiML`);
  console.log(`WS   /call          -> Twilio Media Stream entrypoint`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
