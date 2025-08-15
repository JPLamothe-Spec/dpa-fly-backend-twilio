// server.js — Twilio <Stream> ↔ OpenAI Realtime (μ-law end-to-end, debounced commits)
// - Debounce-based commit: only commit after ≥120ms buffered AND ~220ms idle (or Twilio stop)
// - Include streamSid on all outbound media to Twilio
// - Logs bytes for outbound audio so we can verify playback

if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch {}
}

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const { personaFromEnv } = require('./persona');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ---- Healthcheck for Fly ----
app.get('/health', (_req, res) => res.status(200).send('ok'));

// ---- Config ----
const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Twilio → 20 ms G.711 µ-law @ 8 kHz
const TWILIO_FRAME_MS = 20;
const MIN_COMMIT_MS   = 120;  // API needs ≥100ms; use 120ms for headroom
const IDLE_DEBOUNCE_MS = 220; // commit after this long without new frames

// ---- Twilio Voice Webhook ----
app.post('/twilio/voice', (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const wsUrl = `wss://${host}/call`;
  const twiml =
    `<Response><Connect><Stream url="${wsUrl}" track="inbound_track"/></Connect><Pause length="600"/></Response>`;
  console.log('➡️ /twilio/voice hit (POST)');
  console.log('🧾 TwiML returned:\n' + twiml);
  res.type('text/xml').send(twiml);
});

// ---- HTTP(S) server + WS upgrade ----
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (path === '/call') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ---- WS connection per call ----
wss.on('connection', (twilioWS, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`✅ Twilio WebSocket connected from ${ip}`);

  if (!OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY is not set');
    twilioWS.close();
    return;
  }

  const persona = personaFromEnv();
  console.log('🧠 Persona resolved:', {
    name: persona.name || 'Assistant',
    voice: persona.voice,
    asrModel: persona.asrModel,
    ttsModel: persona.ttsModel,
    language: persona.language || 'en-AU',
    instructions_len: persona.instructions?.length ?? 0,
  });
  console.log('🧠 Persona loaded:', {
    voice: persona.voice, asrModel: persona.asrModel, ttsModel: persona.ttsModel
  });

  // Connect to OpenAI Realtime
  const oaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(persona.ttsModel)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  // Per-call state
  let streamSid = null;
  let frames = [];       // base64 μ-law 20ms frames
  let msBuffered = 0;
  let idleTimer = null;  // debounce timer for commits

  function scheduleDebouncedCommit() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      commitIfReady('idle');
    }, IDLE_DEBOUNCE_MS);
  }

  function clearDebounce() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  // Append each 20ms frame individually; commit only when we truly have enough
  function commitIfReady(cause) {
    if (!oaiWS || oaiWS.readyState !== WebSocket.OPEN) return;
    if (msBuffered < MIN_COMMIT_MS || frames.length === 0) return;

    for (const b64 of frames) {
      oaiWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
    }
    oaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    console.log(`🔊 committed ≥${MIN_COMMIT_MS}ms cause=${cause} frames=${frames.length}`);

    frames = [];
    msBuffered = 0;
  }

  // Forward model audio → Twilio (must include streamSid)
  function sendAudioToTwilio(base64Mulaw) {
    if (twilioWS.readyState !== WebSocket.OPEN || !streamSid) return;
    // Log byte size to see outbound flow
    const bytes = Buffer.byteLength(base64Mulaw, 'base64');
    console.log(`➡️ to Twilio media: ${bytes} bytes`);
    twilioWS.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: base64Mulaw }
    }));
  }

  // ---- Twilio events ----
  twilioWS.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
      case 'start':
        streamSid = data.start?.streamSid;
        console.log('🎬 Twilio stream START:', {
          streamSid, voice: persona.voice, model: persona.ttsModel, dev: !!process.env.DEV_MODE
        });
        break;

      case 'media': {
        const payload = data.media?.payload; // base64 μ-law 20ms
        if (!payload) return;
        frames.push(payload);
        msBuffered += TWILIO_FRAME_MS;
        scheduleDebouncedCommit();
        break;
      }

      case 'stop':
      case 'mark':
        console.log('🧵 Twilio event:', data.event);
        commitIfReady(data.event);
        clearDebounce();
        break;

      default:
        break;
    }
  });

  twilioWS.on('close', () => {
    console.log('❌ Twilio WebSocket closed');
    clearDebounce();
    if (oaiWS && oaiWS.readyState === WebSocket.OPEN) oaiWS.close();
  });

  twilioWS.on('error', (err) => console.error('⚠️ Twilio WS error:', err));

  // ---- OpenAI Realtime handlers ----
  oaiWS.on('open', () => {
    console.log('🔗 OpenAI Realtime connected');

    const sessionUpdate = {
      type: 'session.update',
      session: {
        instructions: persona.instructions,
        voice: persona.voice,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        // We’ll still let server VAD run, but commits are driven by our debounce
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 100, silence_duration_ms: 200 },
        modalities: ['audio', 'text'],
        input_audio_transcription: { model: persona.asrModel },
      },
    };

    oaiWS.send(JSON.stringify(sessionUpdate));
    console.log('✅ session.updated (ASR=%s, format=g711_ulaw)', persona.asrModel);
  });

  oaiWS.on('message', (msg) => {
    let evt;
    try { evt = JSON.parse(msg.toString()); } catch { return; }

    switch (evt.type) {
      case 'response.audio_transcript.delta':
        if (evt.delta?.length) console.log('🗣️ ANNA SAID:', evt.delta);
        break;

      case 'response.audio_transcript.done':
        console.log('🔎 OAI event: response.audio_transcript.done');
        break;

      case 'input_audio_buffer.speech_started':
        console.log('🔎 OAI event: input_audio_buffer.speech_started');
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('🔎 OAI event: input_audio_buffer.speech_stopped');
        // Commit any residual audio at the end of a turn
        commitIfReady('speech_stopped');
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (evt.delta?.transcript) console.log('👂 YOU SAID (conv.delta):', evt.delta.transcript);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (evt.transcript) console.log('👂 YOU SAID (conv.completed):', evt.transcript);
        break;

      case 'response.audio.delta':
        if (evt.delta) sendAudioToTwilio(evt.delta);
        break;

      case 'error':
        console.log('🔻 OAI error:', JSON.stringify(evt, null, 2));
        break;

      default:
        // console.log('OAI evt:', evt.type);
        break;
    }
  });

  oaiWS.on('close', () => {
    console.log('❌ OpenAI Realtime closed');
    clearDebounce();
    if (twilioWS.readyState === WebSocket.OPEN) twilioWS.close();
  });

  oaiWS.on('error', (err) => console.error('⚠️ OpenAI WS error:', err));
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
