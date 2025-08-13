// index.js — DPA backend (CommonJS). Incremental latency fixes, no ESM.
// Ports/paths unchanged. Works with your existing package.json.
//
// ENV required:
//   OPENAI_API_KEY
// Optional:
//   PORT (defaults 3000)
//   OAI_MODEL (defaults gpt-4o-realtime-preview-2024-12-17)
//   OAI_VOICE (defaults shimmer)

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
require("dotenv").config();

const PORT = process.env.PORT || 3000;
const OAI_MODEL = process.env.OAI_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const OAI_VOICE = process.env.OAI_VOICE || "shimmer";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Health for Fly smoke checks
app.get("/", (_req, res) => res.status(200).send("DPA backend is live"));

// ----- Twilio webhook: keep identical contract to your baseline
app.post("/twilio/voice", (req, res) => {
  console.log("➡️ /twilio/voice hit (POST)");

  // NOTE: we keep the same <Stream> + 30s <Pause> pattern you’ve used
  // and move the greeting to after media is flowing.
  const wsUrl = `wss://${req.headers.host}/call`;
  const twiml = `
<Response>
  <Connect>
    <Stream url="${wsUrl}" track="inbound_track"/>
  </Connect>
  <Pause length="30"/>
</Response>`.trim();

  console.log("🧾 TwiML returned:", twiml);
  res.type("text/xml").send(twiml);
});

const server = http.createServer(app);

// One WS endpoint for Twilio <Stream>
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/call") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// Utility: pack a Realtime client event
function rtEvent(type, payload = {}) {
  return JSON.stringify({ type, ...payload });
}

wss.on("connection", (twilioWS, req) => {
  const ips = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString();
  console.log(`✅ Twilio WebSocket connected from ${ips}`);
  let streamSid = null;

  // ----------------- OpenAI Realtime WS (server→server)
  // We use g711_ulaw so we can forward Twilio payloads directly (8kHz μ-law).
  const oaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OAI_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let oaiReady = false;
  let greeted = false;

  // Audio buffer (Twilio → OAI)
  const AUDIO_FRAME_MS = 20;         // Twilio media chunk ≈ 20 ms (160 bytes μ-law)
  const MIN_COMMIT_MS = 120;         // NEVER commit with less than 100 ms; we choose 120 ms
  const TARGET_COMMIT_MS = 240;      // Aim to commit ~200–250 ms for good latency
  let bufferedChunks = [];           // base64 payloads from Twilio
  let bufferedMs = 0;
  let commitTimer = null;
  let closed = false;

  const startCommitLoop = () => {
    if (commitTimer) return;
    commitTimer = setInterval(() => {
      if (!oaiReady) return;
      if (bufferedMs < MIN_COMMIT_MS) return; // prevent empty/too-small commits
      flushToOAI();
    }, 60); // check frequently; actual commit only when enough audio is buffered
  };

  const stopCommitLoop = () => {
    if (commitTimer) {
      clearInterval(commitTimer);
      commitTimer = null;
    }
  };

  function appendToOAI(base64Ulaw) {
    // Send one append event with our μ-law chunk
    // Realtime expects "input_audio_buffer.append" with appropriate input_audio_format set on session.
    oaiWS.send(
      rtEvent("input_audio_buffer.append", {
        audio: base64Ulaw, // μ-law base64
      })
    );
  }

  function commitToOAI() {
    oaiWS.send(rtEvent("input_audio_buffer.commit"));
  }

  function flushToOAI() {
    if (!oaiReady || bufferedMs < MIN_COMMIT_MS || bufferedChunks.length === 0) return;

    // Append all currently buffered μ-law chunks
    for (const chunk of bufferedChunks) {
      appendToOAI(chunk);
    }

    // Commit (single)
    commitToOAI();

    // Reset buffers
    bufferedChunks = [];
    bufferedMs = 0;
  }

  function safeCloseAll() {
    if (closed) return;
    closed = true;
    stopCommitLoop();
    try { twilioWS.close(); } catch {}
    try { oaiWS.close(); } catch {}
  }

  // -------- OpenAI Realtime: wire up
  oaiWS.on("open", () => {
    console.log("🔗 OpenAI Realtime connected");

    // Configure session to accept G.711 μ-law 8kHz from Twilio
    oaiWS.send(rtEvent("session.update", {
      session: {
        voice: OAI_VOICE,
        // Disable server-side barge timeout to avoid long stalls
        turn_detection: null,
        // Tell Realtime our input audio format matches Twilio
        input_audio_format: {
          type: "g711_ulaw",
          sample_rate_hz: 8000
        },
        // Synthesize output back to μ-law so we can stream to Twilio directly
        output_audio_format: {
          type: "g711_ulaw",
          sample_rate_hz: 8000
        }
      }
    }));

    oaiReady = true;
    console.log("✅ session.updated (ASR=g711_ulaw, 8kHz)");

    // Start the commit loop once OAI is ready
    startCommitLoop();
  });

  oaiWS.on("message", (buf) => {
    let evt;
    try {
      evt = JSON.parse(buf.toString());
    } catch {
      return;
    }

    switch (evt.type) {
      case "response.created":
        // optional: log lightweight marker
        break;

      case "response.output_text.delta":
        // You can log tiny markers if needed; keep disabled to avoid noise
        break;

      case "response.output_audio.delta": {
        // Realtime is streaming μ-law audio back in base64 chunks (since we set output_audio_format)
        const b64 = evt.delta;
        if (b64 && twilioWS.readyState === WebSocket.OPEN) {
          // Send back to Twilio as a media message (μ-law base64)
          twilioWS.send(JSON.stringify({
            event: "media",
            media: { payload: b64 }
          }));
        }
        break;
      }

      case "response.completed":
        // keep responsive
        break;

      case "input_audio_buffer.speech_started":
      case "input_audio_buffer.speech_stopped":
        // optional hooks for VAD-like behaviors
        break;

      case "error":
        console.log("🔻 OAI error:", JSON.stringify(evt, null, 2));
        break;

      default:
        // uncomment for deep debugging
        // console.log("OAI evt:", evt.type);
        break;
    }
  });

  oaiWS.on("close", (code) => {
    console.log("🔚 OAI socket closed", code);
    safeCloseAll();
  });

  oaiWS.on("error", (err) => {
    console.error("⚠️ OAI WS error:", err);
    safeCloseAll();
  });

  // -------- Twilio Media Stream: incoming audio
  twilioWS.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || msg.streamSid;
      console.log(`📞 Twilio media stream connected (sid=${streamSid})`);
      // We greet only after we see some media so the path is definitely open.
      greeted = false;
      return;
    }

    if (msg.event === "media") {
      const b64 = msg.media?.payload;
      if (!b64) return;

      // Buffer μ-law frames and commit in small batches
      bufferedChunks.push(b64);
      bufferedMs += AUDIO_FRAME_MS;

      // First packets seen → fire the greeting once OAI is ready
      if (!greeted && oaiReady && bufferedMs >= MIN_COMMIT_MS) {
        greeted = true;
        // Flush what we have, then ask model to speak the greeting
        flushToOAI();

        // Create a short greeting; you can customize the prompt here.
        oaiWS.send(rtEvent("response.create", {
          response: {
            modalities: ["text", "audio"],
            instructions: "Hello! I’m here. How can I help you today?",
          }
        }));
      }

      // If we’ve accumulated enough audio for a fast turn, push now
      if (bufferedMs >= TARGET_COMMIT_MS) {
        flushToOAI();
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("🛑 Twilio STOP event");
      // Flush any tail audio before close
      flushToOAI();
      safeCloseAll();
      return;
    }
  });

  twilioWS.on("close", () => {
    console.log("❌ Twilio WS closed");
    safeCloseAll();
  });

  twilioWS.on("error", (err) => {
    console.error("⚠️ Twilio WS error:", err);
    safeCloseAll();
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
