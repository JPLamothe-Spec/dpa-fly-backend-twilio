// index.js
// Twilio <Stream>  ↔  OpenAI Realtime bridge (two-way audio)
// - Input:  g711_ulaw (Twilio 8kHz µ-law, 20ms frames)
// - Output: g711_ulaw back to Twilio
// Latency tuning:
//   • Commit after >=100ms of buffered audio (5 x 20ms frames)
//   • Also commit on silence >= 450ms
//   • Hard cap commit every 1200ms while speaking
//
// ENV: PORT, OPENAI_API_KEY, PUBLIC_URL (for TwiML Connect URL)

import express from "express";
import bodyParser from "body-parser";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;
const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  `http://localhost:${PORT}`; // used in TwiML <Stream url="...">

// --- Helpers -------------------------------------------------------------

// Twilio sends 20ms frames of µ-law @ 8kHz → 160 bytes each
const BYTES_PER_PACKET = 160;
const MS_PER_PACKET = 20;

// Tiny energy/VAD on µ-law payload (quick & dirty)
// Returns RMS-ish value (0..255)
function muLawEnergy(b64) {
  try {
    const buf = Buffer.from(b64, "base64");
    let acc = 0;
    const n = buf.length;
    for (let i = 0; i < n; i++) acc += buf[i] * buf[i];
    return Math.sqrt(acc / Math.max(1, n));
  } catch {
    return 0;
  }
}

function nowMs() {
  return Date.now();
}

// --- TwiML: entry-point Twilio hits to start the call --------------------

app.post("/twilio/voice", (req, res) => {
  const streamUrl = `${PUBLIC_URL.replace(/\/+$/, "")}/call`;
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}" track="inbound_track"/>
      </Connect>
      <Pause length="30"/>
    </Response>`.trim();

  console.log("➡️ /twilio/voice hit (POST)");
  console.log("🧾 TwiML returned:", twiml.replace(/\n\s*/g, "\n"));
  res.set("Content-Type", "text/xml");
  res.send(twiml);
});

// --- WS server Twilio connects to ---------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/call" });

// Per-call session handler
wss.on("connection", async (twilioWs, req) => {
  console.log("✅ Twilio WebSocket connected");

  // OpenAI Realtime WS
  const oaiUrl =
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

  const oai = new WebSocket(oaiUrl, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1", // << required
    },
  });

  let oaiReady = false;
  let twilioClosed = false;
  let oaiClosed = false;

  // Buffering for input → OAI
  let packetBuffer = []; // array of base64 payloads (each 160B / 20ms)
  let bufferedMs = 0;

  // Basic VAD / commit cadence
  const ENERGY_SPEECH = 65; // tune up/down; higher = harder to trigger speech
  const SILENCE_COMMIT_MS = 450;
  const SPEAKING_COMMIT_MAX_MS = 1200;

  let speaking = false;
  let lastAudioAtMs = 0; // time of last non-trivial energy
  let lastCommitAtMs = 0;

  // To avoid "conversation_already_has_active_response"
  let responseInFlight = false;

  function safeSendOAI(obj) {
    if (oaiReady && oai.readyState === WebSocket.OPEN) {
      oai.send(JSON.stringify(obj));
    }
  }

  function commitIfNeeded(force = false) {
    const t = nowMs();
    const sinceCommit = t - lastCommitAtMs;
    const sinceAudio = t - lastAudioAtMs;

    // Ensure we never send empty commits
    if (!packetBuffer.length && !force) return;

    // Must have >= 100ms audio to commit (OpenAI requires >=100ms)
    const enoughAudio = bufferedMs >= 100;

    const dueToSilence = sinceAudio >= SILENCE_COMMIT_MS && speaking;
    const dueToMaxWhileSpeaking = speaking && sinceCommit >= SPEAKING_COMMIT_MAX_MS;
    const dueToForce = force;

    if ((enoughAudio && (dueToSilence || dueToMaxWhileSpeaking)) || dueToForce) {
      const concatenated = Buffer.concat(
        packetBuffer.map((b64) => Buffer.from(b64, "base64"))
      );
      const payloadB64 = concatenated.toString("base64");

      safeSendOAI({
        type: "input_audio_buffer.append",
        audio: payloadB64,
      });
      safeSendOAI({ type: "input_audio_buffer.commit" });
      lastCommitAtMs = t;

      // If we're not already waiting on a bot answer, request one.
      if (!responseInFlight) {
        responseInFlight = true;
        safeSendOAI({
          type: "response.create",
          response: {
            // let the server VAD and context decide what to say
          },
        });
      }

      // Reset buffer
      packetBuffer = [];
      bufferedMs = 0;
      speaking = false; // we just ended a turn by definition
    }
  }

  function flushSmallBufferOnStop() {
    // On STOP, we might have <100ms left; try to top-up by duplicating a frame
    if (!packetBuffer.length) return;
    while (bufferedMs < 100 && packetBuffer.length) {
      // duplicate last frame to satisfy min length
      packetBuffer.push(packetBuffer[packetBuffer.length - 1]);
      bufferedMs += MS_PER_PACKET;
    }
    commitIfNeeded(true);
  }

  // --- OpenAI WS: lifecycle & events -----------------------------

  oai.on("open", () => {
    oaiReady = true;
    console.log("🔗 OpenAI Realtime connected");

    // Initialize session: formats + voice + server VAD
    safeSendOAI({
      type: "session.update",
      session: {
        // IMPORTANT: formats must be *strings*, not objects
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        modalities: ["text", "audio"],
        voice: "coral",
        // Server-side turn detection; we'll also commit intelligently
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          silence_duration_ms: 450,
        },
        instructions:
          "You are Anna, a helpful assistant for JP. Wait until the user finishes speaking; do not interrupt. Keep replies concise and relevant to the last user utterance.",
      },
    });
  });

  oai.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Stream TTS audio back to Twilio as it arrives
      if (msg.type === "response.output_audio.delta" && msg.delta) {
        // msg.delta is base64 audio in g711_ulaw (since we set output_audio_format)
        const twilioFrame = {
          event: "media",
          streamSid: "SIMULATED", // Twilio ignores on return; but set anyway
          media: { payload: msg.delta },
        };
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify(twilioFrame));
        }
      }

      if (msg.type === "response.completed" || msg.type === "response.cancelled") {
        responseInFlight = false;
      }

      if (msg.type === "error") {
        console.log("❌ OAI error:", JSON.stringify(msg, null, 2));
        // If the error was empty-commit related, we'll just wait for more audio.
        if (msg.error?.code !== "input_audio_buffer_commit_empty") {
          responseInFlight = false;
        }
      }
    } catch (err) {
      console.log("❌ OAI parse error:", err);
    }
  });

  oai.on("close", (code) => {
    oaiClosed = true;
    console.log("🔚 OAI socket closed", code);
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  oai.on("error", (err) => {
    console.log("❌ OAI socket error:", err?.message || err);
  });

  // --- Twilio WS: receive & forward media ------------------------

  twilioWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.event) {
        case "start":
          console.log("📞 Twilio media stream connected");
          break;

        case "media": {
          const payload = msg.media?.payload;
          if (!payload) break;

          // Track energy to decide speaking/silence
          const energy = muLawEnergy(payload);
          const t = nowMs();

          // Heuristic: if energy passes threshold, consider "speaking"
          if (energy >= ENERGY_SPEECH) {
            speaking = true;
            lastAudioAtMs = t;
          }

          // Buffer the frame
          packetBuffer.push(payload);
          bufferedMs += MS_PER_PACKET;

          // Commit when we have >=100ms AND either:
          //  - we've seen silence long enough (handled in commitIfNeeded via timers)
          //  - or buffer grew large while speaking (cap)
          // Here, proactively commit if large buffer while speaking
          const sinceCommit = t - lastCommitAtMs;
          if (speaking && bufferedMs >= 200 /* >= 200ms */ && sinceCommit >= 300) {
            // keep steady trickle while speaking to reduce lag
            commitIfNeeded(true);
          }

          // Also check silence-triggered commits on every packet
          commitIfNeeded(false);
          break;
        }

        case "stop":
          console.log("🛑 Twilio STOP event");
          // Flush any residual audio
          flushSmallBufferOnStop();
          if (!oaiClosed) oai.close();
          break;
      }
    } catch (err) {
      console.log("❌ Twilio parse error:", err);
    }
  });

  twilioWs.on("close", () => {
    twilioClosed = true;
    console.log("❌ Twilio WS closed");
    if (!oaiClosed) oai.close();
  });

  twilioWs.on("error", (err) => {
    console.log("❌ Twilio WS error:", err?.message || err);
  });
});

// -------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`🚀 Server listening on :${PORT}`);
});
