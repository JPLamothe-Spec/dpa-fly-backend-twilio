// server.js — Twilio Media Streams ↔ OpenAI Realtime (μ-law end-to-end, no greeting)
// CommonJS because package.json has "type": "commonjs"

require('dotenv/config');
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { create } = require('xmlbuilder2');

const {
  // Align default with Dockerfile/EXPOSE; your env can still override.
  PORT = process.env.PORT || 3000,

  // OpenAI
  OPENAI_API_KEY,
  OAI_MODEL,                      // preferred
  OPENAI_MODEL,                   // alias (from your .env)
  OAI_VOICE,                      // preferred
  VOICE_NAME,                     // alias (from your .env)

  // ASR + locale
  ASR_MODEL = process.env.ASR_MODEL || 'gpt-4o-mini-transcribe',
  LANGUAGE = process.env.LANGUAGE || 'en-AU',

  // VAD
  VAD_THRESHOLD = process.env.VAD_THRESHOLD || '0.55',
  VAD_PREFIX_MS = process.env.VAD_PREFIX_MS || '120',
  VAD_SILENCE_MS = process.env.VAD_SILENCE_MS || '220',

  // Public WS override (optional)
  PUBLIC_WS_URL
} = process.env;

const MODEL = OAI_MODEL || OPENAI_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const VOICE = OAI_VOICE || VOICE_NAME || 'shimmer';

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post('/twilio/voice', (req, res) => {
  const wsUrl = (PUBLIC_WS_URL || '').trim() || `wss://${req.get('host')}/call`;
  const xml = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('Response')
      .ele('Connect')
        .ele('Stream', { url: wsUrl, track: 'inbound_track' }).up()
      .up()
      .ele('Pause', { length: '600' }).up()
    .up()
    .end({ prettyPrint: false });

  console.log('➡️ /twilio/voice hit (POST)');
  console.log('🧾 TwiML returned:\n' + xml);
  res.type('text/xml').send(xml);
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/call' });

// --- helpers ---
const FRAME_MS = 20;           // Twilio sends 20ms frames
const MIN_COMMIT_MS = 120;     // coalesce to avoid chattiness
const SAFE_JSON = (x) => { try { return JSON.parse(x); } catch { return null; } };
const now = () => new Date().toISOString();

// --- bridge ---
wss.on('connection', async (twilioWS, req) => {
  const clientIps = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`✅ Twilio WebSocket connected from ${clientIps}`);

  const { WebSocket } = require('ws');
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;

  let oaiWS;
  let streamSid = null;
  let keepaliveTimer = null;

  // commit bookkeeping
  let msBuffered = 0;
  let sinceAppend = false; // 🔒 ensures we never commit an empty buffer

  const sendToTwilioMedia = (b64) => {
    if (twilioWS.readyState !== twilioWS.OPEN || !streamSid) return;
    twilioWS.send(JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } }));
  };

  const commitIfReady = (cause = 'chunk') => {
    if (!oaiWS || oaiWS.readyState !== WebSocket.OPEN) return;
    if (!sinceAppend) return;            // 🔒 no empty commits
    if (msBuffered < MIN_COMMIT_MS) return;

    try {
      oaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      console.log(`🔊 committed ≥${MIN_COMMIT_MS}ms cause=${cause}`);
      // reset commit window
      msBuffered = 0;
      sinceAppend = false;
    } catch (err) {
      console.log('⚠️ commit error:', err?.message || err);
    }
  };

  const cleanup = (reason) => {
    try { keepaliveTimer && clearInterval(keepaliveTimer); } catch {}
    try { oaiWS && oaiWS.readyState === WebSocket.OPEN && oaiWS.close(); } catch {}
    try { twilioWS && twilioWS.readyState === twilioWS.OPEN && twilioWS.close(); } catch {}
    console.log(`❌ Bridge closed (${reason || 'unknown'})`);
  };

  // OpenAI WS
  try {
    oaiWS = new WebSocket(url, {
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

    const sessionUpdate = {
      type: 'session.update',
      session: {
        voice: VOICE,
        input_audio_transcription: { model: ASR_MODEL, language: LANGUAGE },
        input_audio_format: { type: 'g711_ulaw', channels: 1, sample_rate: 8000 },
        output_audio_format: { type: 'g711_ulaw', channels: 1, sample_rate: 8000 },
        turn_detection: {
          type: 'server_vad',
          threshold: Number(VAD_THRESHOLD),
          prefix_padding_ms: Number(VAD_PREFIX_MS),
          silence_duration_ms: Number(VAD_SILENCE_MS)
        }
        // instructions intentionally omitted for now
      }
    };
    oaiWS.send(JSON.stringify(sessionUpdate));
    console.log(`✅ session.updated (ASR=${ASR_MODEL}, format=g711_ulaw)`);

    // Twilio keepalive tick (harmless mark)
    keepaliveTimer = setInterval(() => {
      if (twilioWS.readyState !== twilioWS.OPEN || !streamSid) return;
      twilioWS.send(JSON.stringify({ event: 'mark', streamSid, name: 'ping' }));
    }, 5000);
  });

  oaiWS.on('message', (data) => {
    const msg = SAFE_JSON(data.toString());
    if (!msg) return;

    if (msg.type === 'error') {
      console.log('🔻 OAI error:', JSON.stringify(msg, null, 2));
      return;
    }

    if (msg.type === 'response.audio.delta' && msg.delta) {
      sendToTwilioMedia(msg.delta);
      return;
    }

    if (msg.type?.startsWith('input_audio_buffer.')) {
      // These are server-VAD boundary events (informational for us).
      console.log('🔎 OAI event:', msg.type);
      if (msg.type === 'input_audio_buffer.speech_stopped') {
        // End of speech window — try to commit if we actually buffered audio.
        commitIfReady('speech_stopped');
      }
      return;
    }

    if (msg.type === 'response.audio_transcript.done') {
      console.log('🔎 OAI event: response.audio_transcript.done');
      return;
    }

    if (msg.type === 'response.output_text.done' && typeof msg.text === 'string') {
      for (const w of msg.text.trim().split(/\s+/)) console.log('🗣️ ANNA SAID:', w);
      return;
    }
  });

  oaiWS.on('close', () => { console.log('❌ OpenAI Realtime closed'); cleanup('oai_closed'); });
  oaiWS.on('error', (err) => { console.error('OAI WS error:', err?.message || err); });

  // Twilio -> OpenAI
  twilioWS.on('message', (data) => {
    const msg = SAFE_JSON(data.toString());
    if (!msg) return;

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid;
      console.log('🎬 Twilio stream START:', { streamSid, voice: VOICE, model: MODEL, dev: false });
      return;
    }

    if (msg.event === 'media') {
      const payload = msg.media?.payload;
      if (!payload) return;

      try {
        oaiWS?.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
        sinceAppend = true;            // 🔒 we have new audio since the last commit
        msBuffered += FRAME_MS;
      } catch { /* swallow */ }

      if (msBuffered >= MIN_COMMIT_MS) commitIfReady('chunk');
      return;
    }

    if (msg.event === 'mark') return;

    if (msg.event === 'stop') {
      console.log('🧵 Twilio event: stop');
      // Try a final commit only if we actually appended something
      if (sinceAppend) commitIfReady('stop');
      return;
    }
  });

  twilioWS.on('close', () => { console.log('❌ Twilio WebSocket closed'); cleanup('twilio_closed'); });
  twilioWS.on('error', (err) => { console.error('Twilio WS error:', err?.message || err); cleanup('twilio_error'); });
});

server.listen(PORT, () => {
  console.log(`[${now()}] Server listening on :${PORT}`);
  console.log(`POST /twilio/voice -> returns TwiML <Connect><Stream/>`);
  console.log(`WS  /call          -> Twilio <Stream> endpoint`);
});

/*
ENV to set (example):
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-realtime-preview-2024-12-17   # or OAI_MODEL
VOICE_NAME=shimmer                                # or OAI_VOICE
ASR_MODEL=gpt-4o-mini-transcribe
LANGUAGE=en-AU
PUBLIC_WS_URL=wss://<your-app>.fly.dev/call
VAD_THRESHOLD=0.55
VAD_PREFIX_MS=120
VAD_SILENCE_MS=220
*/
