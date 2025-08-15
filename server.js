// server.js (CommonJS, no extra deps)
require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const WebSocketClient = require('ws');

// ---- minimal TwiML helper (no extra deps)
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function twimlConnectStream(wsUrl) {
  const url = escapeAttr(wsUrl);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      `<Connect><Stream url="${url}" track="inbound_track"/></Connect>` +
      '<Pause length="600"/>' +
    '</Response>'
  );
}

const {
  OPENAI_API_KEY,
  OAI_MODEL = 'gpt-4o-realtime-preview-2024-12-17',
  OAI_VOICE = 'shimmer',
  ASR_MODEL = 'gpt-4o-mini-transcribe',
  LANGUAGE = 'en-AU',
  VAD_THRESHOLD = '0.55',
  VAD_PREFIX_MS = '120',
  VAD_SILENCE_MS = '220'
} = process.env;

const PORT = Number(process.env.PORT || 3000);

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---- Twilio Voice webhook -> TwiML that starts the bidirectional stream
app.post('/twilio/voice', (req, res) => {
  const wsUrl =
    (process.env.PUBLIC_WS_URL || '').trim() ||
    `wss://${req.get('host')}/call`;

  const xml = twimlConnectStream(wsUrl);

  console.log('➡️ /twilio/voice hit (POST)');
  console.log('🧾 TwiML returned:\n' + xml);
  res.type('text/xml').send(xml);
});

// ---- HTTP server + WS server for Twilio
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/call' });

/**
 * Utilities
 */
const FRAME_MS = 20;            // Twilio sends 20ms @ 8k
const MIN_COMMIT_MS = 120;      // commit after >=120ms buffered
const MAX_CHUNK_FRAMES = 25;
const SAFE_JSON = (x) => { try { return JSON.parse(x); } catch { return null; } };
const now = () => new Date().toISOString();

// ---- Main Twilio <-> OpenAI Realtime bridge
wss.on('connection', async (twilioWS, req) => {
  const clientIps = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`✅ Twilio WebSocket connected from ${clientIps}`);

  let streamSid = null;
  let oaiWS = null;
  let keepaliveTimer = null;

  // Audio buffer bookkeeping (we only commit when we have enough)
  let frames = [];
  let msBuffered = 0;

  // Ship audio to Twilio (downlink from OpenAI)
  function sendToTwilioMedia(b64) {
    if (twilioWS.readyState !== twilioWS.OPEN || !streamSid) return;
    const msg = JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: b64 }
    });
    twilioWS.send(msg);
  }

  function cleanup(reason = 'unknown') {
    try { keepaliveTimer && clearInterval(keepaliveTimer); } catch {}
    try { oaiWS && oaiWS.readyState === oaiWS.OPEN && oaiWS.close(); } catch {}
    try { twilioWS && twilioWS.readyState === twilioWS.OPEN && twilioWS.close(); } catch {}
    console.log(`❌ Bridge closed (${reason})`);
  }

  function commitIfReady(cause = 'chunk') {
    if (!oaiWS || oaiWS.readyState !== oaiWS.OPEN) return;
    if (frames.length === 0 || msBuffered < MIN_COMMIT_MS) return;
    try {
      oaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      frames = [];
      msBuffered = 0;
      console.log(`🔊 committed ≥${MIN_COMMIT_MS}ms cause=${cause}`);
    } catch (err) {
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

    // Configure session. No greeting/response.create — we wait for caller speech.
    const sessionUpdate = {
      type: 'session.update',
      session: {
        voice: OAI_VOICE,
        input_audio_transcription: { model: ASR_MODEL, language: LANGUAGE },
        input_audio_format: { type: 'g711_ulaw', channels: 1, sample_rate: 8000 },
        output_audio_format: { type: 'g711_ulaw', channels: 1, sample_rate: 8000 },
        turn_detection: {
          type: 'server_vad',
          threshold: Number(VAD_THRESHOLD),
          prefix_padding_ms: Number(VAD_PREFIX_MS),
          silence_duration_ms: Number(VAD_SILENCE_MS)
        }
        // instructions intentionally omitted
      }
    };
    oaiWS.send(JSON.stringify(sessionUpdate));
    console.log(`✅ session.updated (ASR=${ASR_MODEL}, format=g711_ulaw)`);

    // Keepalive (no commits here!)
    keepaliveTimer = setInterval(() => {
      if (twilioWS.readyState !== twilioWS.OPEN || !streamSid) return;
      twilioWS.send(JSON.stringify({ event: 'mark', streamSid, name: 'ping' }));
    }, 5000);
  });

  // 2) Handle OpenAI -> Twilio events
  oaiWS.on('message', (data) => {
    const msg = SAFE_JSON(data.toString());
    if (!msg) return;

    if (msg.type === 'error') {
      console.log('🔻 OAI error:', JSON.stringify(msg, null, 2));
      return;
    }

    if (msg.type?.startsWith('input_audio_buffer.')) {
      console.log('🔎 OAI event:', msg.type);
      if (msg.type === 'input_audio_buffer.speech_stopped') {
        commitIfReady('speech_stopped');
      }
      return;
    }

    // The model is speaking; stream audio chunks down to Twilio
    if (msg.type === 'response.audio.delta' && msg.delta) {
      sendToTwilioMedia(msg.delta); // base64 g711_ulaw
      return;
    }

    if (msg.type === 'response.audio_transcript.delta' || msg.type === 'response.audio_transcript.done') {
      if (msg.type === 'response.audio_transcript.done' && msg.transcript) {
        console.log('🔎 OAI event: response.audio_transcript.done');
      }
      return;
    }

    if (msg.type === 'response.output_text.delta' && typeof msg.delta === 'string') {
      // optional: process.stdout.write(msg.delta);
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
      // Twilio sends 20ms ulaw frames as base64 in msg.media.payload
      const payload = msg.media?.payload;
      if (!payload) return;

      // Append to OpenAI input buffer
      try {
        oaiWS?.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: payload // base64 g711_ulaw, as per session.input_audio_format
        }));
      } catch {}

      // Track for commit policy
      frames.push(1);
      msBuffered += FRAME_MS;

      // Commit in small-ish chunks when enough buffered
      if (frames.length >= MAX_CHUNK_FRAMES || msBuffered >= MIN_COMMIT_MS) {
        commitIfReady('chunk');
      }
      return;
    }

    if (msg.event === 'mark') {
      // ignore; used for our keepalive ping
      return;
    }

    if (msg.event === 'stop') {
      console.log('🧵 Twilio event: stop');
      // Final commit if any audio remains
      commitIfReady('stop');
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
 * LANGUAGE=en-AU
 * PUBLIC_WS_URL=wss://dpa-fly-backend-twilio.fly.dev/call
 *
 * (Optionally tweak VAD:)
 * VAD_THRESHOLD=0.55
 * VAD_PREFIX_MS=120
 * VAD_SILENCE_MS=220
 */
