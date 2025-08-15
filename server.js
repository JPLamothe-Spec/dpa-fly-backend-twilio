// server.js (CommonJS) — Twilio <-> OpenAI Realtime bridge with server VAD + English-only
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const app = express();

// Twilio webhook: return TwiML that starts a bidirectional media stream
app.post("/twilio/voice", express.urlencoded({ extended: false }), (req, res) => {
  const wsUrl = `${req.protocol === "https" ? "wss" : "ws"}://${req.get("host")}/call`;
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

// 20ms per Twilio frame @ 8kHz PCMU -> 160 bytes
const TWILIO_FRAME_BYTES = 160;

// Utility: chunk a Buffer into fixed sizes
function* chunksOf(buf, size) {
  for (let i = 0; i < buf.length; i += size) {
    yield buf.subarray(i, Math.min(i + size, buf.length));
  }
}

wss.on("connection", (twilioWS, req) => {
  const remote = req.socket.remoteAddress;
  console.log(`✅ Twilio WebSocket connected from ${remote}`);

  // Connect to OpenAI Realtime
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

  // Buffer inbound Twilio audio frames and batch-send to OpenAI (no commits; server VAD on)
  let inboundBuf = Buffer.alloc(0);
  let inboundFrames = 0;

  const flushInbound = () => {
    if (inboundFrames === 0) return;
    const b64 = inboundBuf.toString("base64");
    try {
      oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      console.log(`🔊 appended ${inboundFrames} frame(s) ≈${inboundFrames * 20}ms (${inboundBuf.length} bytes)`);
    } catch {}
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
        console.log("🎬 Twilio stream START:", {
          streamSid,
          model: OAI_MODEL,
          voice: "shimmer",
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
        try { twilioWS.close(); } catch {}
        try { oaiWS.close(); } catch {}
        break;
      }
    }
  });

  twilioWS.on("close", () => {
    console.log("❌ Twilio WebSocket closed");
    try { oaiWS.close(); } catch {}
  });
  twilioWS.on("error", (e) => console.log("⚠️ Twilio WS error:", e?.message || e));

  // --- OpenAI WS handlers ---
  oaiWS.on("open", () => {
    console.log("🔗 OpenAI Realtime connected");

    // Configure session: server VAD, formats, English-only transcription, G.711 µ-law in/out
    oaiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad", prefix_padding_ms: 300, silence_duration_ms: 200 },
        input_audio_format: { type: "g711_ulaw", sample_rate: 8000, channels: 1 },
        output_audio_format: { type: "g711_ulaw", sample_rate: 8000, channels: 1 },
        input_audio_transcription: { model: "gpt-4o-mini-transcribe", language: "en" },
        instructions: "You are DPA. Speak only English. Be brief and helpful on phone calls.",
      },
    }));

    oaiWS.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: "Hello! This is DPA. How can I help you today?",
        conversation: { turn_detection: { type: "server_vad" } },
      },
    }));

    console.log("✅ session.update sent (ASR=en, VAD=server, format=g711_ulaw)");
  });

  oaiWS.on("message", (data) => {
    let evt; try { evt = JSON.parse(data.toString()); } catch { return; }

    if (evt.type?.startsWith("error")) {
      console.log("🔻 OAI error:", JSON.stringify(evt, null, 2));
      return;
    }

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

    if (
      evt.type === "response.audio_transcript.delta" ||
      evt.type === "response.audio_transcript.done"
    ) {
      if (evt.type.endsWith(".delta") && evt.delta) process.stdout.write(`📝 ${evt.delta}`);
      else if (evt.transcript) console.log(`\n📝 transcript: ${evt.transcript}`);
      else console.log(`\n🔎 OAI event: ${evt.type}`);
      return;
    }

    if (
      evt.type === "input_audio_buffer.speech_started" ||
      evt.type === "input_audio_buffer.speech_stopped"
    ) {
      console.log(`🔎 OAI event: ${evt.type}`);
      return;
    }
  });

  oaiWS.on("close", () => {
    console.log("❌ OpenAI Realtime closed");
    try { twilioWS.close(); } catch {}
  });
  oaiWS.on("error", (e) => console.log("⚠️ OAI WS error:", e?.message || e));

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
  console.log(`POST /twilio/voice  -> returns TwiML`);
  console.log(`WS   /call           -> Twilio Media Stream entrypoint`);
});
