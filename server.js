// server.js — Twilio <-> OpenAI Realtime with server VAD, μ-law, correct transcript labels, and safe commit gating
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const WebSocket = require("ws");
const persona = require("./persona");

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const app = express();
app.set("trust proxy", true);

// Health
app.get("/healthz", (_, res) => res.status(200).send("ok"));

// Twilio webhook -> Media Stream
app.post("/twilio/voice", express.urlencoded({ extended: false }), (req, res) => {
  const xfProto = (req.get("x-forwarded-proto") || "").split(",")[0].trim();
  const scheme = xfProto === "http" ? "ws" : "wss";
  const wsUrl = `${scheme}://${req.get("host")}/call`;

  const twiml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "  <Connect>",
    `    <Stream url="${wsUrl}" track="inbound_track" />`,
    "  </Connect>",
    '  <Pause length="600"/>',
    "</Response>",
  ].join("");

  console.log("➡️ /twilio/voice hit (POST)");
  console.log("🧾 TwiML returned:\n" + twiml);
  res.type("text/xml").send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/call" });

// Twilio PCMU: 20ms @ 8kHz = 160 bytes
const TWILIO_FRAME_BYTES = 160;
function* chunksOf(buf, size) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, Math.min(i + size, buf.length));
}

wss.on("connection", (twilioWS, req) => {
  console.log(`✅ Twilio WebSocket connected from ${req.socket.remoteAddress}`);

  // OpenAI Realtime WS
  const oaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OAI_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  let streamSid = null;
  let oaiReady = false;
  let greeted = false;
  let responseActive = false;

  // audio batching + commit gating
  let inboundBuf = Buffer.alloc(0);
  let inboundFrames = 0;
  let appendedSinceLastCommit = false;

  const flushInbound = () => {
    if (!inboundFrames) return;
    if (!oaiReady || oaiWS.readyState !== WebSocket.OPEN) return;
    const b64 = inboundBuf.toString("base64");
    try {
      oaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      console.log(`🔊 appended ${inboundFrames} frame(s) ≈${inboundFrames * 20}ms (${inboundBuf.length} bytes)`);
      appendedSinceLastCommit = true;
    } catch {}
    inboundBuf = Buffer.alloc(0);
    inboundFrames = 0;
  };

  const queueInbound = (chunk) => {
    inboundBuf = Buffer.concat([inboundBuf, chunk]);
    inboundFrames += Math.floor(chunk.length / TWILIO_FRAME_BYTES);
    if (inboundFrames >= 10) flushInbound(); // ~200ms
  };

  const safeGreetingOnce = () => {
    if (!oaiReady || greeted || responseActive) return;
    greeted = true;
    responseActive = true;
    console.log("📣 greeting response.create sent");

    const greetingText =
      `Dev line here. I'm ${persona.name}. Are we testing or doing a real task? ` +
      `If you'd like me to use your name later, tell me what to call you. ` +
      `RULE: never address the caller by any name unless they explicitly ask for it.`;

    oaiWS.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        conversation: "auto",
        instructions: greetingText,
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
        console.log("🎬 Twilio stream START:", { streamSid, model: OAI_MODEL, voice: persona.voice, dev: false });
        safeGreetingOnce();
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

    // Valid session fields only
    oaiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad", prefix_padding_ms: 300, silence_duration_ms: 200 },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "gpt-4o-mini-transcribe", language: persona.language },
        voice: persona.voice,
        instructions:
          persona.instructions +
          "\n\nHARD RULE: Never address the caller by any name unless they explicitly ask for it. “Anna” is the assistant’s own name.",
      },
    }));
    console.log("✅ session.update sent (ASR=en, VAD=server, format=g711_ulaw)");

    flushInbound();
    safeGreetingOnce();
  });

  oaiWS.on("message", (data) => {
    let evt; try { evt = JSON.parse(data.toString()); } catch { return; }

    if (evt.type === "error" || evt.type?.startsWith("error")) {
      console.log("🔻 OAI error:", JSON.stringify(evt, null, 2));
      return;
    }

    // —— VAD events
    if (evt.type === "input_audio_buffer.speech_started") {
      console.log("🔎 OAI event: input_audio_buffer.speech_started");
      return;
    }

    if (evt.type === "input_audio_buffer.speech_stopped") {
      console.log("🔎 OAI event: input_audio_buffer.speech_stopped");
      flushInbound(); // final flush before commit
      if (appendedSinceLastCommit && oaiWS.readyState === WebSocket.OPEN) {
        try {
          oaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        } catch {}
      } else {
        console.log("ℹ️ Skip commit: no new audio since last commit");
      }
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
      // reset for next turn
      appendedSinceLastCommit = false;
      return;
    }

    // —— USER transcript (use ONLY input_audio_transcription.*)
    if (evt.type === "response.input_audio_transcription.delta" && evt.delta) {
      process.stdout.write(`👤 userΔ ${evt.delta}`);
      return;
    }
    if (
      evt.type === "response.input_audio_transcription.completed" ||
      evt.type === "input_audio_transcription.completed"
    ) {
      if (evt.transcript) console.log(`\n📝 user: ${evt.transcript.trim()}`);
      return;
    }

    // —— ASSISTANT text
    if (evt.type === "response.output_text.delta" && evt.delta) {
      process.stdout.write(`🤖 ${persona.name}Δ ${evt.delta}`);
      return;
    }
    if (evt.type === "response.output_text.completed" && evt.text) {
      console.log(`\n🗣️ ${persona.name}: ${evt.text.trim()}`);
      return;
    }

    // —— ASSISTANT speech transcript (correctly labeled)
    if (evt.type === "response.audio_transcript.delta" && evt.delta) {
      process.stdout.write(`🎧 asstΔ ${evt.delta}`);
      return;
    }
    if (evt.type === "response.audio_transcript.done" && evt.transcript) {
      console.log(`\n🎧 asst: ${evt.transcript.trim()}`);
      return;
    }

    // —— ASSISTANT audio → Twilio (μ-law frames)
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

    // —— Response lifecycle
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
