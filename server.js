// server.js — Twilio <Stream> ↔ OpenAI Realtime (μ-law end-to-end)
// - Immediate greeting so Twilio hears audio early
// - Chunked + debounced commits (every ~500ms and on idle/stop)
// - Keepalive "mark" to Twilio every 5s
// - Outbound media always includes streamSid

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

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Twilio frames are 20 ms μ-law @ 8 kHz
const TWILIO_FRAME_MS   = 20;
const MIN_COMMIT_MS     = 120;  // API min 100ms; use 120ms for headroom
const IDLE_DEBOUNCE_MS  = 220;  // commit after this gap
const CHUNK_COMMIT_MS   = 500;  // commit during speech every ~0.5s

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.post('/twilio/voice', (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const wsUrl = `wss://${host}/call`;
  const twiml =
    `<Response><Connect><Stream url="${wsUrl}" track="inbound_track"/></Connect><Pause length="600"/></Response>`;
  console.log('➡️ /twilio/voice hit (POST)');
  console.log('🧾 TwiML returned:\n' + twiml);
  res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (path === '/call') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

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

  const oaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(persona.ttsModel)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  // Per-call state
  let streamSid = null;
  let frames = [];            // base64 20ms μ-law frames
  let msBuffered = 0;
  let idleTimer = null;
  let keepaliveTimer = null;

  function scheduleDebouncedCommit() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => commitIfReady('idle'), IDLE_DEBOUNCE_MS);
  }

  function clearDebounce() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

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

  function maybeChunkCommit() {
    if (msBuffered >= CHUNK_COMMIT_MS) {
      commitIfReady('chunk');
    }
  }

  function sendAudioToTwilio(base64Mulaw) {
    if (twilioWS.readyState !== WebSocket.OPEN || !streamSid) return;
    const bytes = Buffer.byteLength(base64Mulaw, 'base64');
    console.log(`➡️ to Twilio media: ${bytes} bytes`);
    twilioWS.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: base64Mulaw }
    }));
  }

  function startKeepalive() {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
      if (twilioWS.readyState !== WebSocket.OPEN || !streamSid) return;
      twilioWS.send(JSON.stringify({ event: 'mark', streamSid, name: 'ping' }));
      // Also nudge OAI turn detector so it doesn’t stall
      try { oaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); } catch {}
    }, 5000);
  }

  function stopKeepalive() {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = null;
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
        startKeepalive();
        break;

      case 'media': {
        const payload = data.media?.payload; // base64 μ-law 20ms
        if (!payload) return;
        frames.push(payload);
        msBuffered += TWILIO_FRAME_MS;
        scheduleDebouncedCommit();
        maybeChunkCommit();
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
    stopKeepalive();
    if (oaiWS && oaiWS.readyState === WebSocket.OPEN) oaiWS.close();
  });

  twilioWS.on('error', (err) => console.error('⚠️ Twilio WS error:', err));

  // ---- OpenAI Realtime ----
  oaiWS.on('open', () => {
    console.log('🔗 OpenAI Realtime connected');

    // Configure session (μ-law both ways, with ASR)
    oaiWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions: persona.instructions,
        voice: persona.voice,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        modalities: ['audio', 'text'],
        // Server VAD is on, but we also chunk commit
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 100, silence_duration_ms: 200 },
        input_audio_transcription: { model: persona.asrModel },
      },
    }));
    console.log('✅ session.updated (ASR=%s, format=g711_ulaw)', persona.asrModel);

    // 🔊 Immediate greeting to keep stream open and prove outbound path
    const greeting = process.env.DPA_GREETING
      || "Hello! How can I help you today?";
    oaiWS.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio'],
        instructions: greeting
      }
    }));
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
        break;
    }
  });

  oaiWS.on('close', () => {
    console.log('❌ OpenAI Realtime closed');
    clearDebounce();
    stopKeepalive();
    if (twilioWS.readyState === WebSocket.OPEN) twilioWS.close();
  });

  oaiWS.on('error', (err) => console.error('⚠️ OpenAI WS error:', err));
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
