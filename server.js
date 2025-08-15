// server.js (CommonJS, no extra deps)
require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const WebSocketClient = require('ws');

/* ---------- minimal TwiML helper ---------- */
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function twimlConnectStream(wsUrl) {
  const url = escapeAttr(wsUrl);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      `<Connect><Stream url="${url}" track="inbound_track"/></Connect>` +
      // Keep call open; no canned greeting. Model replies after caller speaks.
      '<Pause length="600"/>' +
    '</Response>'
  );
}

/* ---------- ENV ---------- */
const {
  OPENAI_API_KEY,
  OAI_MODEL = 'gpt-4o-realtime-preview-2024-12-17',
  OAI_VOICE = 'shimmer',
  ASR_MODEL = 'gpt-4o-mini-transcribe',
  LANGUAGE = 'en-AU', // we normalize this below
  VAD_THRESHOLD = '0.55',
  VAD_PREFIX_MS = '120',
  VAD_SILENCE_MS = '220',
  AUTO_RESPONSE = 'false', // "true" to nudge response.create after speech stop
  PUBLIC_WS_URL,
  PORT: ENV_PORT
} = process.env;

const PORT = Number(ENV_PORT || 3000);
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

/* Normalize ASR language: "en-AU" -> "en"; fallback "en" */
function normalizeLang(code) {
  if (!code) return 'en';
  const two = String(code).toLowerCase().split(/[_-]/)[0];
  return two || 'en';
}
const ASR_LANGUAGE = normalizeLang(LANGUAGE);

/* ---------- App ---------- */
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health endpoint so Fly can keep machines happy
app.get('/', (_req, res) => res.status(200).send('ok'));

// Twilio Voice webhook -> TwiML that starts the bidirectional stream
app.post('/twilio/voice', (req, res) => {
  const wsUrl = (PUBLIC_WS_URL || '').trim() || `wss://${req.get('host')}/call`;
  const xml = twimlConnectStream(wsUrl);

  console.log('➡️ /twilio/voice hit (POST)');
  console.log('🧾 TwiML returned:\n' + xml);
  res.type('text/xml').send(xml);
});

/* ---------- HTTP + WS servers ---------- */
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/call' });

/* ---------- Utils ---------- */
const FRAME_MS = 20;                 // Twilio sends 20ms frames @ 8k
const MIN_COMMIT_MS = 120;           // commit when >=120ms buffered
const MAX_CHUNK_FRAMES = 25;         // safety upper bound for chunk size
const SAFE_JSON = (x) => { try { return JSON.parse(x); } catch { return null; } };
const now = () => new Date().toISOString();

/* ---------- Main Twilio <-> OpenAI Realtime bridge ---------- */
wss.on('connection', async (twilioWS, req) => {
  const clientIps = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`✅ Twilio WebSocket connected from ${clientIps}`);

  let streamSid = null;
  let oaiWS = null;
  let keepaliveTimer = null;

  // Buffer bookkeeping for commit policy
  let frames = [];
  let msBuffered = 0;
  let commitInFlight = false;
  let sessionReady = false;

  function sendToTwilioMedia(b64) {
    if (twilioWS.readyState !== twilioWS.OPEN || !streamSid) return;
    const msg = JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: b64 }
    });
    try { twilioWS.send(msg); } catch {}
  }

  function cleanup(reason = 'unknown') {
    try { keepaliveTimer && clearInterval(keepaliveTimer); } catch {}
    try { oaiWS && oaiWS.readyState === oaiWS.OPEN && oaiWS.close(); } catch {}
    try { twilioWS && twilioWS.readyState === twilioWS.OPEN && twilioWS.close(); } catch {}
    console.log(`❌ Bridge closed (${reason})`);
  }

  function commitIfReady(cause = 'chunk') {
    if (!oaiWS || oaiWS.readyState !== oaiWS.OPEN) return;
    if (!sessionReady) return; // don't commit until session.update succeeded
    if (commitInFlight) return;
    if (frames.length === 0 || msBuffered < MIN_COMMIT_MS) return;
    try {
      commitInFlight = true;
      oaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      frames = [];
      msBuffered = 0;
      console.log(`🔊 committed ≥${MIN_COMMIT_MS}ms cause=${cause}`);
    } catch (err) {
      commitInFlight = false;
      console.log('⚠️ commit error:', err?.message || err);
    }
  }

  // 1) Connect to OpenAI Realtime WS
  try {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OAI_MODEL)}`;
    oaiWS = new WebSocketClient(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });
  } catch (err) {
    console.error('Failed to open OpenAI Realtime WS:', err?.message || err);
    cleanup('oai_ws_fail_open');
    return;
  }

  oaiWS.on('open', () => {
    console.log('🔗 OpenAI Realtime connected');

    // Configure session. IMPORTANT: audio formats are STRINGS (not objects).
    const sessionUpdate = {
      type: 'session.update',
      session: {
        voice: OAI_VOICE,
        input_audio_transcription: { model: ASR_MODEL, language: ASR_LANGUAGE },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: {
          type: 'server_vad',
          threshold: Number(VAD_THRESHOLD),
          prefix_padding_ms: Number(VAD_PREFIX_MS),
          silence_duration_ms: Number(VAD_SILENCE_MS)
        }
        // No "instructions" to keep natural start
      }
    };
    oaiWS.send(JSON.stringify(sessionUpdate));
    console.log(`➡️ session.update sent (ASR=${ASR_MODEL}, lang=${ASR_LANGUAGE}, format=g711_ulaw)`);

    // Keep Twilio stream alive with non-audio marks (safe)
    keepaliveTimer = setInterval(() => {
      if (twilioWS.readyState !== twilioWS.OPEN || !streamSid) return;
      try {
        twilioWS.send(JSON.stringify({ event: 'mark', streamSid, name: 'ping' }));
      } catch {}
    }, 5000);
  });

  // 2) Handle OpenAI -> Twilio events
  oaiWS.on('message', (data) => {
    const msg = SAFE_JSON(data.toString());
    if (!msg) return;

    if (msg.type === 'session.updated') {
      sessionReady = true;
      console.log('✅ session.updated ACK from OpenAI');
      return;
    }

    // Clear commit lock when server acknowledges
    if (msg.type === 'input_audio_buffer.committed' || msg.type === 'input_audio_buffer.cleared') {
      commitInFlight = false;
      return;
    }

    if (msg.type === 'error') {
      console.log('🔻 OAI error:', JSON.stringify(msg, null, 2));
      // If session.update failed (e.g., invalid language), we won't be "ready"
      // and appends/commits will be ignored. Keep lock open to allow retry.
      if (msg.error?.code === 'input_audio_buffer_commit_empty') {
        commitInFlight = false; // allow next attempt
      }
      return;
    }

    if (msg.type?.startsWith('input_audio_buffer.')) {
      console.log('🔎 OAI event:', msg.type);
      if (msg.type === 'input_audio_buffer.speech_stopped') {
        commitIfReady('speech_stopped');

        // Optional nudge: create a response right after caller finishes speaking.
        if (AUTO_RESPONSE === 'true') {
          try {
            oaiWS.send(JSON.stringify({
              type: 'response.create',
              response: {
                modalities: ['audio', 'text'],
                instructions: '' // keep it natural; no canned prompt
              }
            }));
            console.log('🎯 response.create sent after speech stop');
          } catch (e) {
            console.log('⚠️ response.create error:', e?.message || e);
          }
        }
      }
      return;
    }

    // Stream model audio back down to Twilio (already base64 g711_ulaw)
    if (msg.type === 'response.audio.delta' && msg.delta) {
      sendToTwilioMedia(msg.delta);
      return;
    }

    // Optional transcript logs
    if (msg.type === 'response.audio_transcript.delta' || msg.type === 'response.audio_transcript.done') {
      if (msg.type === 'response.audio_transcript.done' && msg.transcript) {
        console.log('🔎 OAI event: response.audio_transcript.done');
      }
      return;
    }

    if (msg.type === 'response.output_text.delta' && typeof msg.delta === 'string') {
      // process.stdout.write(msg.delta); // optional
      return;
    }
    if (msg.type === 'response.output_text.done' && typeof msg.text === 'string') {
      const words = msg.text.trim().split(/\s+/);
      for (const w of words) console.log('🗣️ ANNA SAID:', w);
      return;
    }
  });

  oaiWS.on('close', () => {
    console.log('❌ OpenAI Realtime closed');
    cleanup('oai_closed');
  });

  oaiWS.on('error', (err) => {
    console.error('OAI WS error:', err?.message || err);
  });

  // 3) Handle Twilio -> OpenAI events
  twilioWS.on('message', (data) => {
    const msg = SAFE_JSON(data.toString());
    if (!msg) return;

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid;
      console.log('🎬 Twilio stream START:', {
        streamSid,
        voice: OAI_VOICE,
        model: OAI_MODEL,
        dev: false
      });
      return;
    }

    if (msg.event === 'media') {
      // Twilio sends 20ms μ-law frames as base64 in msg.media.payload
      const payload = msg.media?.payload;
      if (!payload) return;

      try {
        // Only append after session is confirmed ready to avoid wasting frames
        if (sessionReady) {
          oaiWS?.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: payload // base64 g711_ulaw, matches session.input_audio_format
          }));
        }
      } catch {}

      // Local buffering for commit policy (best effort)
      frames.push(1);
      msBuffered += FRAME_MS;

      if (frames.length >= MAX_CHUNK_FRAMES || msBuffered >= MIN_COMMIT_MS) {
        commitIfReady('chunk');
      }
      return;
    }

    if (msg.event === 'mark') {
      // ignore; used for keepalive ping
      return;
    }

    if (msg.event === 'stop') {
      console.log('🧵 Twilio event: stop');
      commitIfReady('stop'); // final commit if any buffered
      return;
    }
  });

  twilioWS.on('close', () => {
    console.log('❌ Twilio WebSocket closed');
    cleanup('twilio_closed');
  });

  twilioWS.on('error', (err) => {
    console.error('Twilio WS error:', err?.message || err);
    cleanup('twilio_error');
  });
});

server.listen(PORT, () => {
  console.log(`[${now()}] Server listening on :${PORT}`);
  console.log(`POST /twilio/voice -> returns TwiML <Connect><Stream/>`);
  console.log(`WS  /call          -> Twilio <Stream> endpoint`);
});

/**
 * Fly ENV to set:
 *
 * OPENAI_API_KEY=sk-...
 * OAI_MODEL=gpt-4o-realtime-preview-2024-12-17
 * OAI_VOICE=shimmer
 * ASR_MODEL=gpt-4o-mini-transcribe
 * LANGUAGE=en-AU                  # we'll normalize this to 'en'
 * PUBLIC_WS_URL=wss://dpa-fly-backend-twilio.fly.dev/call
 * AUTO_RESPONSE=false             # set to "true" only if model stays silent after you speak
 *
 * (Optionally tweak VAD:)
 * VAD_THRESHOLD=0.55
 * VAD_PREFIX_MS=120
 * VAD_SILENCE_MS=220
 */
