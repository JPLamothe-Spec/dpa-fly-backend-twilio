// server.js — Twilio <Stream> ↔ OpenAI Realtime bridge (μ-law end-to-end, fixed)
// - FIX: include streamSid when sending audio back to Twilio
// - FIX: do NOT concatenate base64; append each 20ms frame to OpenAI, then commit

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

// Twilio sends 20 ms G.711 µ-law frames at 8 kHz
const TWILIO_FRAME_MS = 20;
const MIN_COMMIT_MS = 120;       // ≥100ms required by API; we use 120ms for safety
const TRICKLE_INTERVAL_MS = 600; // periodic commit while caller is speaking

// ---- Twilio Voice Webhook (returns TwiML that connects the WS) ----
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
  if (new URL(req.url, `http://${req.headers.host}`).pathname === '/call') {
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

  // Connect to OpenAI Realtime (websocket)
  const oaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(persona.ttsModel)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  // Per-call state
  let streamSid = null;            // Twilio streamSid — MUST be included on outbound media
  let bufferedFrames = [];         // store base64 μ-law 20ms frames here
  let bufferedMs = 0;              // ms represented by bufferedFrames (frames * 20ms)
  let trickleTimer = null;

  function startTrickle() {
    if (trickleTimer) return;
    trickleTimer = setInterval(() => {
      commitIfReady('trickle');
    }, TRICKLE_INTERVAL_MS);
  }

  function stopTrickle() {
    if (trickleTimer) clearInterval(trickleTimer);
    trickleTimer = null;
  }

  // Append each frame → then commit (no base64 concatenation!)
  function commitIfReady(cause) {
    if (!oaiWS || oaiWS.readyState !== WebSocket.OPEN) return;
    if (bufferedMs < MIN_COMMIT_MS || bufferedFrames.length === 0) return;

    // 1) append each 20ms μ-law frame as its own append
    for (const b64 of bufferedFrames) {
      oaiWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
    }
    // 2) commit once
    oaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

    console.log(`🔊 committed ≥${MIN_COMMIT_MS}ms ${cause ? `cause=${cause}` : ''}`);
    bufferedFrames = [];
    bufferedMs = 0;
  }

  // Forward OpenAI audio back to Twilio (must include streamSid)
  function sendAudioToTwilio(base64Mulaw) {
    if (twilioWS.readyState !== WebSocket.OPEN || !streamSid) return;
    const msg = {
      event: 'media',
      streamSid, // REQUIRED by Twilio for outbound media
      media: { payload: base64Mulaw },
    };
    twilioWS.send(JSON.stringify(msg));
  }

  // ---- Twilio events → buffer audio ----
  twilioWS.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
      case 'start': {
        streamSid = data.start?.streamSid;
        console.log('🎬 Twilio stream START:', {
          streamSid, voice: persona.voice, model: persona.ttsModel, dev: !!process.env.DEV_MODE
        });
        break;
      }

      case 'media': {
        const payload = data.media?.payload; // base64 μ-law 20ms
        if (!payload) return;
        bufferedFrames.push(payload);
        bufferedMs += TWILIO_FRAME_MS;
        break;
      }

      case 'mark':
      case 'stop': {
        console.log('🧵 Twilio event:', data.event);
        commitIfReady(data.event);
        break;
      }

      default:
        // ignore others
        break;
    }
  });

  twilioWS.on('close', () => {
    console.log('❌ Twilio WebSocket closed');
    stopTrickle();
    if (oaiWS && oaiWS.readyState === WebSocket.OPEN) oaiWS.close();
  });

  twilioWS.on('error', (err) => console.error('⚠️ Twilio WS error:', err));

  // ---- OpenAI Realtime handlers ----
  oaiWS.on('open', () => {
    console.log('🔗 OpenAI Realtime connected');

    // NOTE: API expects simple string for input/output audio format (no objects)
    const sessionUpdate = {
      type: 'session.update',
      session: {
        instructions: persona.instructions,
        voice: persona.voice,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        // server VAD helps auto-commit on pauses; we still do explicit commit for reliability
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 100, silence_duration_ms: 200 },
        modalities: ['audio', 'text'],
        input_audio_transcription: { model: persona.asrModel },
      },
    };

    oaiWS.send(JSON.stringify(sessionUpdate));
    console.log('✅ session.updated (ASR=%s, format=g711_ulaw)', persona.asrModel);

    startTrickle();
  });

  oaiWS.on('message', (msg) => {
    let evt;
    try { evt = JSON.parse(msg.toString()); } catch { return; }

    switch (evt.type) {
      // Model speaking (text transcript of its audio)
      case 'response.audio_transcript.delta':
        if (evt.delta?.length) console.log('🗣️ ANNA SAID:', evt.delta);
        break;

      case 'response.audio_transcript.done':
        console.log('🔎 OAI event: response.audio_transcript.done');
        break;

      // Helpful signals from server VAD
      case 'input_audio_buffer.speech_started':
        console.log('🔎 OAI event: input_audio_buffer.speech_started');
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('🔎 OAI event: input_audio_buffer.speech_stopped');
        commitIfReady('speech_stopped');
        break;

      // Caller transcript (if the model returns it)
      case 'conversation.item.input_audio_transcription.delta':
        if (evt.delta?.transcript) console.log('👂 YOU SAID (conv.delta):', evt.delta.transcript);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (evt.transcript) console.log('👂 YOU SAID (conv.completed):', evt.transcript);
        break;

      // Model audio to play to caller (μ-law base64)
      case 'response.audio.delta':
        if (evt.delta) sendAudioToTwilio(evt.delta);
        break;

      case 'error':
        console.log('🔻 OAI error:', JSON.stringify(evt, null, 2));
        break;

      default:
        // uncomment to see everything:
        // console.log('OAI evt:', evt.type);
        break;
    }
  });

  oaiWS.on('close', () => {
    console.log('❌ OpenAI Realtime closed');
    stopTrickle();
    if (twilioWS.readyState === WebSocket.OPEN) twilioWS.close();
  });

  oaiWS.on('error', (err) => console.error('⚠️ OpenAI WS error:', err));
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
