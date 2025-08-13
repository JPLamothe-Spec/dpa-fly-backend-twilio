// index.js
// Fly.io + Twilio Media Streams <-> OpenAI Realtime bridge
// Focus: lower latency via small safe commits + silence-edge commits

import express from "express";
import http from "http";
import crypto from "crypto";
import WebSocket, { WebSocketServer } from "ws";

// --- Config ---
const PORT = process.env.PORT || 3000;
const PUBLIC_HOST = process.env.PUBLIC_HOST || ""; // e.g. "https://dpa-fly-backend-twilio.fly.dev"
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const OPENAI_VOICE = process.env.OPENAI_VOICE || "shimmer";

// Commit controls
const MIN_COMMIT_MS = 140;           // >=100ms required by API
const SOFT_FLUSH_MS = 400;           // flush window to avoid 15s "max" commits
const SILENCE_COMMIT_MS = 160;       // commit quickly at silence boundary
const SILENCE_RMS = 180;             // energy threshold for silence (tune)
const SILENCE_FRAMES = 6;            // consecutive 20ms frames considered silence

// Twilio Media Streams specifics
// Twilio sends PCMU (μ-law) @ 8kHz, 20ms per frame, 160 bytes each.
const TWILIO_FRAME_BYTES = 160;
const TWILIO_FRAME_MS = 20;

// --- Helpers: μ-law decode/encode, resample 8k -> 16k, RMS ---
function mulawDecodeSample(u) {
  // G.711 μ-law to PCM16
  u = ~u & 0xff;
  const sign = (u & 0x80);
  let exponent = (u >> 4) & 0x07;
  let mantissa = u & 0x0f;
  let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
  sample -= 0x84; // bias
  return sign ? -sample : sample;
}
function mulawDecode(buffer) {
  const out = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) out[i] = mulawDecodeSample(buffer[i]);
  return out;
}
function linearToMulaw(sample) {
  // clamp
  let s = Math.max(-32768, Math.min(32767, sample));
  const BIAS = 0x84;
  let sign = (s < 0) ? 0x80 : 0x00;
  if (s < 0) s = -s;
  s += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; expMask >>= 1) exponent--;
  let mantissa = (s >> (exponent + 3)) & 0x0F;
  const mu = ~(sign | (exponent << 4) | mantissa);
  return mu & 0xFF;
}
function pcm16ToMulaw(int16) {
  const out = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = linearToMulaw(int16[i]);
  return out;
}
// Simple 8k -> 16k linear upsample (dup/interpolate)
function upsample8kTo16k(pcm8k) {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0, j = 0; i < pcm8k.length; i++, j += 2) {
    const s = pcm8k[i];
    out[j] = s;
    // linear interpolate with next sample (or repeat last)
    const next = (i + 1 < pcm8k.length) ? pcm8k[i + 1] : s;
    out[j + 1] = (s + next) >> 1;
  }
  return out;
}
function rms(int16) {
  if (!int16.length) return 0;
  let sumSq = 0;
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] / 32768;
    sumSq += v * v;
  }
  const mean = sumSq / int16.length;
  return Math.sqrt(mean) * 32768;
}
function concatInt16(a, b) {
  if (!a || a.length === 0) return b;
  if (!b || b.length === 0) return a;
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function int16ToBase64(int16) {
  return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).toString("base64");
}

// --- Express + server ---
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// TwiML entrypoint
app.post("/twilio/voice", (req, res) => {
  const wsUrl = `${PUBLIC_HOST || ""}/call`;
  console.log("➡️ /twilio/voice hit (POST)");
  const twiml =
    `<Response>
      <Connect>
        <Stream url="${wsUrl}" track="inbound_track"/>
      </Connect>
      <Pause length="30"/>
    </Response>`;
  console.log("🧾 TwiML returned:", twiml.replace(/\n\s+/g, "\n").trim());
  res.type("text/xml").send(twiml);
});

const server = http.createServer(app);

// WebSocket endpoint for Twilio Media Stream
const wss = new WebSocketServer({ noServer: true, path: "/call" });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/call") {
    console.log("🛰 HTTP upgrade requested: GET /call");
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", async (twilioWS, req) => {
  console.log(`✅ Twilio WebSocket connected from ${req.headers["fly-client-ip"] || ""}, ${req.headers["x-forwarded-for"] || ""}`);

  // State for this call
  let openaiWS = null;
  let inboundPCM16_16k = new Int16Array(0);
  let framesSinceVoice = 0;
  let framesSilent = 0;
  let lastFlushTs = Date.now();
  let closed = false;

  // Safe flush/commit (never empty)
  const flushIfReady = (reason = "timer") => {
    if (closed || !openaiWS || openaiWS.readyState !== WebSocket.OPEN) return;
    // each sample is 1/16000 sec -> 1600 samples = 100ms
    const minSamples = Math.ceil(16000 * (MIN_COMMIT_MS / 1000));
    if (inboundPCM16_16k.length >= minSamples) {
      const chunk = inboundPCM16_16k;
      inboundPCM16_16k = new Int16Array(0);

      // Append then commit
      openaiWS.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: int16ToBase64(chunk)
      }));
      openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      console.log(`🔊 committed ~${Math.round((chunk.length / 16000) * 1000)}ms cause=${reason}`);
      lastFlushTs = Date.now();
    }
  };

  // Bridge to OpenAI Realtime (as WS)
  const oaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  openaiWS = new WebSocket(oaiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  let oaiOpened = false;

  openaiWS.on("open", () => {
    oaiOpened = true;
    console.log("🔗 OpenAI Realtime connected");

    // Configure the session for audio in/out and server-side VAD
    openaiWS.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: OPENAI_VOICE,
        input_audio_format: { type: "pcm16", sample_rate: 16000 },
        turn_detection: {
          type: "server_vad",
          // modest VAD so we hand off quickly; we also push on our own silence detection
          threshold: 0.5,
          prefix_padding_ms: 120,
          silence_duration_ms: 380
        },
        // keep responses concise while testing
        instructions: "Keep responses brief while we test latency."
      }
    }));
    console.log("✅ session.updated (ASR=gpt-4o-mini-transcribe)");

    // Ask the model to start with a short greeting (same as your baseline)
    openaiWS.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions: "Say a quick hello and ask how you can help today."
      }
    }));
  });

  openaiWS.on("message", (data) => {
    try {
      const evt = JSON.parse(data.toString());
      // Forward TTS audio deltas (PCM16@16k) to Twilio as μ-law frames
      if (evt.type === "response.audio.delta" && evt.delta) {
        const buf = Buffer.from(evt.delta, "base64"); // PCM16LE 16kHz
        const int16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));

        // Downsample 16k->8k (simple: drop every other sample)
        const down = new Int16Array(Math.ceil(int16.length / 2));
        for (let i = 0, j = 0; i < int16.length; i += 2, j++) down[j] = int16[i];

        // μ-law encode and push to Twilio
        const mu = pcm16ToMulaw(down);
        twilioWS.send(JSON.stringify({
          event: "media",
          streamSid: twilioStreamSid,
          media: { payload: mu.toString("base64") }
        }));
      }

      // Optional: log recognized text events (kept minimal)
      if (evt.type === "response.transcript.delta" && evt.delta) {
        // console.log("📝 ASR:", evt.delta);
      }

      // Handle end of response (no-op)
      // if (evt.type === "response.completed") { }
    } catch (e) {
      console.log("⚠️ OAI evt parse error:", e);
    }
  });

  openaiWS.on("close", (code) => {
    console.log("🔚 OAI socket closed", code);
  });

  openaiWS.on("error", (err) => {
    console.log("🔻 OAI error:", err);
  });

  // Track Twilio stream SID (from "start" event)
  let twilioStreamSid = null;

  twilioWS.on("message", (msg) => {
    if (closed) return;
    try {
      const data = JSON.parse(msg.toString());

      switch (data.event) {
        case "start": {
          twilioStreamSid = data.start?.streamSid;
          console.log(`📞 Twilio media stream connected`);
          console.log(`🎬 Twilio stream START: streamSid=${twilioStreamSid}, voice=${OPENAI_VOICE}, model=${OPENAI_MODEL}, dev=${process.env.NODE_ENV !== "production"}`);
          break;
        }
        case "media": {
          // Twilio inbound: μ-law base64 @ 8kHz, 20ms, 160 bytes
          const b64 = data.media?.payload;
          if (!b64) break;

          const mu = Buffer.from(b64, "base64");
          if (mu.length !== TWILIO_FRAME_BYTES) {
            // ignore malformed frame
            break;
          }

          const pcm8k = mulawDecode(mu);          // Int16Array at 8k
          const energy = rms(pcm8k);
          const silent = energy < SILENCE_RMS;

          if (!silent) {
            framesSinceVoice++;
            framesSilent = 0;
          } else {
            framesSilent++;
          }

          // Up-sample to 16k and buffer
          const up = upsample8kTo16k(pcm8k);      // Int16Array at 16k
          inboundPCM16_16k = concatInt16(inboundPCM16_16k, up);

          // Timed trickle commit to keep latency low
          const now = Date.now();
          if (now - lastFlushTs >= SOFT_FLUSH_MS) {
            flushIfReady("trickle");
          }

          // Commit right after short silence following speech (end-of-utterance)
          if (framesSinceVoice > 0 && framesSilent >= SILENCE_FRAMES) {
            flushIfReady("silence");
            framesSinceVoice = 0; // reset
          }

          break;
        }
        case "mark": {
          // ignore
          break;
        }
        case "stop": {
          console.log("🛑 Twilio STOP event");
          flushIfReady("stop");
          safeClose();
          break;
        }
      }
    } catch (e) {
      console.log("⚠️ Twilio WS parse error", e);
    }
  });

  twilioWS.on("close", () => {
    console.log("❌ Twilio WS closed");
    safeClose();
  });

  twilioWS.on("error", (err) => {
    console.log("❌ Twilio WS error", err);
    safeClose();
  });

  function safeClose() {
    if (closed) return;
    closed = true;
    try { flushIfReady("teardown"); } catch {}
    try { if (openaiWS && openaiWS.readyState === WebSocket.OPEN) openaiWS.close(); } catch {}
    try { if (twilioWS && twilioWS.readyState === WebSocket.OPEN) twilioWS.close(); } catch {}
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on :${PORT}`);
});
