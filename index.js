// index.js
// Minimal Twilio -> OpenAI Realtime bridge with AU1 awareness + safer audio commits.

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import http from 'http';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';

const {
  PORT = 8080,

  // Voice & model
  OPENAI_REALTIME_MODEL = 'gpt-4o-realtime-preview-2024-12-17',
  VOICE = 'aria',

  // App
  PUBLIC_URL,
  ANNA_DEV_MODE = 'false',
  DEV_CALLER_NAME = 'Caller',

  // VAD tuning
  VAD_SPEECH_THRESH = '12',
  VAD_SILENCE_MS = '700',
  VAD_MAX_TURN_MS = '15000',

  // Region hint/logging
  TWILIO_REGION = 'au1',

  // Secrets come from Fly secrets at runtime; not needed in .env locally on Fly
  OPENAI_API_KEY,
} = process.env;

if (!PUBLIC_URL) {
  console.warn('⚠️  PUBLIC_URL is not set. Twilio will fail to connect your <Stream>.');
}
if (!OPENAI_API_KEY) {
  console.warn('⚠️  OPENAI_API_KEY is not set in this process. On Fly, confirm `fly secrets list` includes it.');
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Simple health
app.get('/', (_req, res) => res.send('OK'));

// === Twilio webhook -> TwiML that opens a Media Stream to our /call WS ===
app.post('/twilio/voice', (req, res) => {
  // Log the region Twilio *plans* to use (if header is present) and what we configured.
  const incomingRegion = req.get('X-Twilio-Region') || req.get('X-Twilio-Edge');
  console.log('➡️ /twilio/voice hit (POST)');
  console.log(`🌏 Desired region (env): ${TWILIO_REGION} | Incoming header: ${incomingRegion || 'n/a'}`);
  console.log(`🎛 voice=${VOICE}, model=${OPENAI_REALTIME_MODEL}, dev=${ANNA_DEV_MODE}`);

  const response = new twilio.twiml.VoiceResponse();

  // NOTE: Twilio chooses the edge/region; we *log* it above. You can also
  // choose an AU number or account routing set to AU1 in Console.
  const connect = response.connect();
  // Track only inbound audio from caller to avoid loopback/echo.
  connect.stream({
    url: `wss://${new URL(PUBLIC_URL).host}/call`,
    track: 'inbound_track',
    // You can optionally pass params that we’ll read on the backend:
    // name: `dpa-${TWILIO_REGION}`,
  });

  // Keep the call open while the WS is active
  response.pause({ length: 30 });

  const twiml = response.toString();
  console.log('🧾 TwiML returned:', twiml);
  res.type('text/xml').send(twiml);
});

// === HTTP(S) server + WebSocket upgrade for /call ===
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/call') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ---- Twilio <Stream> WS handler ----
wss.on('connection', async (twilioWS, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const regionHdr = req.headers['x-twilio-region'] || req.headers['x-twilio-edge'];
  console.log('🛰 HTTP upgrade requested: GET /call');
  console.log('headers:', {
    host: req.headers.host,
    origin: req.headers.origin,
    upgrade: req.headers.upgrade,
    'sec-websocket-key': req.headers['sec-websocket-key'],
    'sec-websocket-version': req.headers['sec-websocket-version'],
  });
  console.log(`✅ Twilio WebSocket connected from ${ip}`);
  if (regionHdr) console.log(`📍 Twilio reported region/edge: ${regionHdr}`);

  // Connect to OpenAI Realtime via WS
  const oaiURL = 'wss://api.openai.com/v1/realtime?model=' + encodeURIComponent(OPENAI_REALTIME_MODEL);
  const oaiWS = new (await import('ws')).default(oaiURL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  let oaiOpen = false;
  let bufferedBytes = 0;
  let lastCommitAt = 0;

  // Min audio to commit in ms to avoid "commit_empty" (Twilio sends 20ms frames)
  const MIN_COMMIT_MS = 120; // 6 packets ≈ 120ms
  const FRAME_MS = 20;
  const FRAME_BYTES = 160; // Twilio mulaw frame size per 20ms
  const MIN_COMMIT_BYTES = Math.ceil(MIN_COMMIT_MS / FRAME_MS) * FRAME_BYTES;

  // Envelope helpers
  const sendOAI = (event) => {
    if (oaiOpen && oaiWS.readyState === oaiWS.OPEN) {
      oaiWS.send(JSON.stringify(event));
    }
  };

  oaiWS.on('open', () => {
    oaiOpen = true;
    console.log('🔗 OpenAI Realtime connected');

    // Configure session: voice, VAD, and a short dev intro
    sendOAI({
      type: 'session.update',
      session: {
        // Choose the TTS voice and some polite turn-taking
        voice: VOICE,
        modalities: ['audio'],
        input_audio_format: { type: 'g711_ulaw', sample_rate: 8000 }, // we feed Twilio μ-law frames
        turn_detection: {
          type: 'server_vad',
          threshold: Number(VAD_SPEECH_THRESH), // 12 is fairly sensitive
          silence_duration_ms: Number(VAD_SILENCE_MS),
          max_duration_ms: Number(VAD_MAX_TURN_MS),
        },
        instructions:
          ANNA_DEV_MODE === 'true'
            ? `You are a patient Australian voice assistant. Wait for the caller to finish speaking before replying. Keep greetings short. The dev caller is ${DEV_CALLER_NAME}.`
            : `You are a patient Australian voice assistant. Wait for the caller to finish speaking before replying.`,
      },
    });

    // Kick off an initial tiny greeting only once (short, so user has a turn)
    sendOAI({
      type: 'response.create',
      response: {
        modalities: ['audio'],
        instructions:
          ANNA_DEV_MODE === 'true'
            ? `Hi ${DEV_CALLER_NAME}, I’m ready. What do you need help with?`
            : `Hi there, how can I help?`,
      },
    });
  });

  oaiWS.on('message', (data) => {
    // Relay any audio deltas from OpenAI back to Twilio as WS messages they expect.
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'response.audio.delta': {
          // Twilio expects base64 μ-law frames in "media" payloads
          twilioWS.send(
            JSON.stringify({
              event: 'media',
              media: { payload: msg.delta }, // already base64 ulaw from OAI
            })
          );
          break;
        }
        case 'response.audio.done': {
          // no-op
          break;
        }
        case 'response.audio_transcript.delta': {
          // Helpful for logs while tuning barge-in
          // console.log('🧠 transcript:', msg.delta);
          break;
        }
        case 'error': {
          console.log('🔻 OAI error:', msg);
          break;
        }
        default:
          // Uncomment to inspect full event flow
          // console.log('🧠 OAI:', msg.type);
          break;
      }
    } catch {
      // Non-JSON frames
    }
  });

  oaiWS.on('close', () => {
    oaiOpen = false;
    console.log('🔚 OpenAI socket closed');
    try { twilioWS.close(); } catch {}
  });
  oaiWS.on('error', (err) => console.log('❌ OAI socket error:', err?.message || err));

  // Receive media from Twilio (20ms μ-law base64 frames)
  twilioWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'start') {
        console.log('📞 Twilio media stream connected');
        console.log(
          `🎬 Twilio stream START: streamSid=${msg.start?.streamSid}, voice=${VOICE}, model=${OPENAI_REALTIME_MODEL}, dev=${ANNA_DEV_MODE}`
        );
        return;
      }
      if (msg.event === 'media') {
        const payloadB64 = msg.media?.payload;
        if (!payloadB64) return;

        // Append packet to OpenAI input buffer
        sendOAI({
          type: 'input_audio_buffer.append',
          audio: payloadB64, // μ-law 8kHz base64
        });

        bufferedBytes += FRAME_BYTES;

        // Commit when enough audio is queued (avoid "commit empty" from your logs)
        const now = Date.now();
        const enough = bufferedBytes >= MIN_COMMIT_BYTES;
        const timeSinceLast = now - lastCommitAt;
        const forceEveryMs = 900; // keep streaming forward responsiveness

        if (enough || timeSinceLast > forceEveryMs) {
          sendOAI({ type: 'input_audio_buffer.commit' });
          // Simple pacing: issue a response after each commit to encourage turn-taking
          sendOAI({ type: 'response.create', response: { modalities: ['audio'] } });
          // Log how much we committed this cycle
          console.log(`🔊 committed ~${Math.round((bufferedBytes / FRAME_BYTES) * FRAME_MS)}ms (${bufferedBytes} bytes)`);
          bufferedBytes = 0;
          lastCommitAt = now;
        }
        return;
      }
      if (msg.event === 'stop') {
        console.log('🛑 Twilio stream STOP');
        try { oaiWS.close(); } catch {}
        try { twilioWS.close(); } catch {}
        return;
      }
    } catch (e) {
      console.log('⚠️ Twilio WS parse error:', e?.message || e);
    }
  });

  twilioWS.on('close', () => {
    console.log('📴 Twilio WS closed');
    try { oaiWS.close(); } catch {}
  });

  twilioWS.on('error', (err) => {
    console.log('❌ Twilio WS error:', err?.message || err);
    try { oaiWS.close(); } catch {}
  });
});

// ---- Start
server.listen(PORT, () => {
  console.log(`🚀 Server listening on :${PORT}`);
  console.log(`🌏 TWILIO_REGION (hint/log): ${TWILIO_REGION}`);
  console.log(`🎙 VOICE=${VOICE} | 🤖 MODEL=${OPENAI_REALTIME_MODEL}`);
  if (PUBLIC_URL) console.log(`🔗 PUBLIC_URL=${PUBLIC_URL}`);
});
