/**
 * DPA Voice Backend — live transcript (debug), secure recording,
 * post-call transcription + summary pipeline.
 *
 * Requires Node 18+.
 */
import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import twilio from "twilio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import FormData from "form-data";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 8080,
  PUBLIC_URL,                            // e.g. https://dpa-fly-backend-twilio.fly.dev
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  OPENAI_API_KEY,
  SUMMARY_CHANNEL = "sms",               // "sms" | "webhook" | "log"
  SUMMARY_TO = "",                       // E.164 for SMS or webhook URL
  SUMMARY_SENDER = "",                   // Twilio SMS number for outbound summaries
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error("Missing Twilio creds");
}
if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY");
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/* ---------- util: verify Twilio signature (recommended for webhooks) ---------- */
function verifyTwilio(req) {
  const signature = req.headers["x-twilio-signature"];
  if (!signature || !PUBLIC_URL) return true; // skip if not configured
  const url = `${PUBLIC_URL}${req.originalUrl}`;
  return twilio.validateRequest(
    TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );
}

/* ---------- storage: local recordings directory (swap to S3 in prod) ---------- */
const RECORDINGS_DIR = path.join(__dirname, "recordings");
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

/* -----------------------------------------------------------------------------
   1) Voice webhook: keep LIVE transcript (dev/debug) + start secure recording
------------------------------------------------------------------------------*/
app.post("/twilio/voice", async (req, res) => {
  if (!verifyTwilio(req)) return res.status(403).send("Invalid signature");

  const response = new twilio.twiml.VoiceResponse();

  // Start Twilio call recording (server-side). Status callback will give us the SID.
  const start = response.start();
  start.recording({
    recordingStatusCallback: "/twilio/recording-status",
    recordingStatusCallbackEvent: "completed", // only need final file
    trim: "trim-silence",
    track: "inbound",                           // caller audio is enough for summary
    recordingChannels: "mono"
  });

  // Keep your existing realtime <Stream> for dev/debug live transcript
  const connect = response.connect();
  connect.stream({
    url: `${PUBLIC_URL.replace(/\/$/, "")}/call`,
    track: "inbound_track"
  });

  // Optional: backstop so Twilio doesn’t hang up if no media consumer responds
  response.pause({ length: 30 });

  res.type("text/xml").send(response.toString());
});

/* -----------------------------------------------------------------------------
   2) Twilio <Stream> WebSocket endpoint — KEEP your existing live transcript
      logic here. Below is a minimal placeholder that just accepts the socket.
------------------------------------------------------------------------------*/
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, req) => {
  console.log("✅ Twilio WebSocket connected (live transcript debug on)");
  ws.on("message", (buf) => {
    // Your existing realtime pipeline can continue to:
    // - forward audio frames to OpenAI Realtime
    // - log response.audio_transcript.delta events, etc.
    // We keep it as-is for dev/debug.
  });
  ws.on("close", () => console.log("🛑 Twilio WS closed"));
});

const server = app.listen(PORT, () =>
  console.log(`HTTP listening on :${PORT}`)
);

server.on("upgrade", (request, socket, head) => {
  const { url } = request;
  if (url.startsWith("/call")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

/* -----------------------------------------------------------------------------
   3) Recording status webhook — downloads audio securely & kicks off pipeline
------------------------------------------------------------------------------*/
app.post("/twilio/recording-status", async (req, res) => {
  if (!verifyTwilio(req)) return res.status(403).send("Invalid signature");
  res.status(200).end(); // Ack quickly

  try {
    const { RecordingSid, CallSid } = req.body;
    console.log("📥 Recording completed:", RecordingSid, "for call", CallSid);

    // Fetch recording metadata
    const rec = await client.recordings(RecordingSid).fetch(); // .uri like /2010-04-01/Accounts/.../Recordings/RExxx.json
    const wavUrl = `https://api.twilio.com${rec.uri.replace(".json", ".wav")}`;

    // Download WAV securely with basic auth
    const wavResp = await fetch(wavUrl, {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString(
            "base64"
          ),
      },
    });
    if (!wavResp.ok) throw new Error(`Failed to download recording ${rec.sid}`);
    const buf = Buffer.from(await wavResp.arrayBuffer());

    // Persist locally (swap to S3/GCS in prod)
    const fname = `${new Date().toISOString().replace(/[:.]/g, "-")}_${CallSid}_${RecordingSid}.wav`;
    const fpath = path.join(RECORDINGS_DIR, fname);
    fs.writeFileSync(fpath, buf);
    console.log("🔒 Recording saved:", fpath);

    // Kick off pipeline (fire-and-forget)
    processPostCallPipeline({ fpath, callSid: CallSid, recordingSid: RecordingSid }).catch(
      (e) => console.error("❌ Post-call pipeline failed:", e)
    );
  } catch (e) {
    console.error("❌ /twilio/recording-status error:", e);
  }
});

/* -----------------------------------------------------------------------------
   4) Post-call pipeline: Transcribe (Whisper) → Summarise (GPT-4o) → Deliver
------------------------------------------------------------------------------*/
async function transcribeWithOpenAI({ fpath }) {
  const form = new FormData();
  form.append("model", "whisper-1");   // accuracy-first offline model at good cost
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  form.append("file", fs.createReadStream(fpath), path.basename(fpath));

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error(`OpenAI ASR failed: ${await r.text()}`);
  const json = await r.json(); // { text, segments, language, ... }
  return json.text || "";
}

async function summariseWithOpenAI({ transcript }) {
  const sys = [
    {
      role: "system",
      content:
        "You are a precise meeting/call summariser. Produce:\n" +
        "1) Summary (5 bullets max)\n" +
        "2) Decisions (if any)\n" +
        "3) Action Items: owner → task → due (concise)\n" +
        "4) Follow-ups / Risks\n" +
        "Keep names as heard; avoid hallucinations; be crisp.",
    },
  ];
  const user = [{ role: "user", content: `Transcript:\n${transcript}` }];

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0.2,
      messages: [...sys, ...user],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI summary failed: ${await r.text()}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || "";
}

async function deliverSummary({ summary, channel = SUMMARY_CHANNEL }) {
  switch (channel) {
    case "sms": {
      if (!SUMMARY_TO || !SUMMARY_SENDER) {
        console.log("📬 Summary (SMS omitted — missing sender/to):\n", summary);
        return;
      }
      await client.messages.create({
        to: SUMMARY_TO,
        from: SUMMARY_SENDER,
        body: summary.slice(0, 1500), // SMS-friendly
      });
      console.log("📤 Summary sent via SMS to", SUMMARY_TO);
      break;
    }
    case "webhook": {
      if (!SUMMARY_TO) {
        console.log("📬 Summary (webhook omitted — missing SUMMARY_TO):\n", summary);
        return;
      }
      const r = await fetch(SUMMARY_TO, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "call.summary", summary }),
      });
      console.log("📤 Summary POST", SUMMARY_TO, r.status);
      break;
    }
    default:
      console.log("📬 Summary (log):\n", summary);
  }
}

async function processPostCallPipeline({ fpath, callSid, recordingSid }) {
  console.log("🚀 Post-call pipeline starting…", { callSid, recordingSid });

  // 1) Transcribe (accuracy-first)
  const transcript = await transcribeWithOpenAI({ fpath });
  console.log("📝 Transcript length:", transcript.length);

  // 2) Summarise
  const summary = await summariseWithOpenAI({ transcript });

  // 3) Deliver
  await deliverSummary({ summary });

  console.log("✅ Pipeline complete for", callSid);
}
