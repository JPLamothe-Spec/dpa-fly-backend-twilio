// server.js (CommonJS) — Twilio <-> OpenAI Realtime bridge
// Logs both user + assistant transcripts in Fly live logs

const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

// --- Persona (optional) ---
let persona = {
  name: "Anna",
  language: "en",
  voice: "shimmer",
  scope: "personal_assistant",
  instructions:
    "You are Anna (DPA), part of our dev team. Stay in English. Keep replies concise and on-topic for testing. Acknowledge when you're being tested and avoid offering unrelated services. Be courteous, collaborative, and helpful."
};
try {
  const p = path.join(process.cwd(), "persona.json");
  if (fs.existsSync(p)) {
    const loaded = JSON.parse(fs.readFileSync(p, "utf8"));
    persona = { ...persona, ...loaded };
  }
} catch (e) {
  console.log("⚠️ Could not read persona.json, using defaults:", e?.message || e);
}

const app = express();

// Twilio webhook: return TwiML that starts a bidirectional media stream
app.post("/twilio/voice", express.urlencoded({ extended: false }), (req, res) => {
  const wsUrl = `wss://${req.get("host")}/call`;
  const twiml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Connect>`,
    `    <Stream url="${wsUrl}" track="inbound_track" />`,
    `  </Connect>`,
    // Keep call open; model will speak back over the stream
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
    yield buf.subarray(i + 0, Math.min(i + size, buf.length));
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

  // Buffer inbound Twilio audio frames and batch-send to OpenAI (no commits; server VAD handles turns)
  let inboundBuf = Buffer.alloc(0);
  let inboundFrames = 0;
  let lastMediaLog = 0;

  const flushInbound = () => {
    if (inboundFrames === 0) return;
    const b64 = inboundBuf.toString("base64");
    try {
      oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
    } catch {}
    const now = Date.now();
    if (now - lastMediaLog > 2000) {
      console.log(`🔊 appended +${inboundFrames} frame(s) (~${inboundFrames * 20}ms chunk)`);
      lastMediaLog = now;
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
    console.log("👤 persona snapshot:", persona);

    // Configure session: server VAD, formats, persona language, G.711 µ-law in/out
    // NOTE: input/output formats must be strings per latest preview schema.
    oaiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad", prefix_padding_ms: 300, silence_duration_ms: 200 },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "gpt-4o-mini-transcribe", language: persona.language || "en" },
        instructions: `[name:${persona.name}] [scope:${persona.scope}] ` + (persona.instructions || ""),
        voice: persona.voice || "shimmer",
      },
    }));

    // Short greeting (modalities must be ['audio','text']; conversation must be 'auto' or 'none')
    oaiWS.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        conversation: "auto",
        instructions: `Hi, this is ${persona.name}. I'm here to help test and improve DPA. How would you like to proceed?`,
      },
    }));

    console.log("✅ session.update sent (ASR=persona.language, VAD=server, format=g711_ulaw)");
  });

  oaiWS.on("message", (data) => {
    let evt; try { evt = JSON.parse(data.toString()); } catch { return; }

    // Helpful debug
    if (evt.type?.startsWith("error")) {
      console.log("🔻 OAI error:", JSON.stringify(evt, null, 2));
      return;
    }

    // Audio deltas back to Twilio (20ms PCMU frames)
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

    // --- LOGGING: Assistant audio transcript (existing variants) ---
    if (
      evt.type === "response.audio_transcript.delta" ||
      evt.type === "response.audio_transcript.done"
    ) {
      if (evt.type.endsWith(".delta") && evt.delta) process.stdout.write(`🗣️ ${persona.name}Δ ${evt.delta}`);
      else if (evt.transcript) console.log(`\n🗣️ ${persona.name}: ${evt.transcript}`);
      else console.log(`\n🗣️ ${persona.name} evt: ${evt.type}`);
      return;
    }

    // --- LOGGING: User/caller transcript (variants across preview builds) ---
    if (
      evt.type === "response.input_audio_transcript.delta" ||
      evt.type === "response.input_audio_transcript.done" ||
      evt.type === "conversation.item.input_audio_transcript.delta" ||
      evt.type === "conversation.item.input_audio_transcript.done"
    ) {
      if (evt.type.endsWith(".delta") && evt.delta) process.stdout.write(`👤 userΔ ${evt.delta}`);
      else if (evt.transcript) console.log(`\n👤 user: ${evt.transcript}`);
      else console.log(`\n👤 user evt: ${evt.type}`);
      return;
    }

    // --- LOGGING: Assistant text (some models emit text as well/as instead) ---
    if (
      evt.type === "response.text.delta" ||
      evt.type === "response.text.done" ||
      evt.type === "response.output_text.delta" ||
      evt.type === "response.output_text.done"
    ) {
      if (evt.type.endsWith(".delta") && evt.delta) process.stdout.write(`🗣️ ${persona.name}Δ ${evt.delta}`);
      else if (evt.text) console.log(`\n🗣️ ${persona.name}: ${evt.text}`);
      else if (evt.output_text) console.log(`\n🗣️ ${persona.name}: ${evt.output_text}`);
      else console.log(`\n🗣️ ${persona.name} evt: ${evt.type}`);
      return;
    }

    // Turn boundary + misc helpful
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

  // Heartbeats (keeps sockets healthy across proxies)
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
