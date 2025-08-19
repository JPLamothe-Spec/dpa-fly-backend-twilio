// server.js
// Fly.io / Twilio <Stream> -> OpenAI Realtime bridge with rich logging

import fs from 'fs';
import path from 'path';
import http from 'http';
import express from 'express';
import bodyParser from 'body-parser';
import WebSocket, { WebSocketServer } from 'ws';
import { TwimlResponse as _Deprecated } from 'twilio'; // just in case old projects import
import twilio from 'twilio';

const { VoiceResponse } = twilio.twiml;

// ---------- Config ----------
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const VOICE = process.env.VOICE || 'shimmer';
const DEV = String(process.env.DEV || 'false') === 'true';

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

// ---------- Persona ----------
function loadPersona() {
  const personaPath =
    process.env.PERSONA_PATH ||
    path.join(process.cwd(), 'persona.json');

  let persona = {
    name: 'Anna',
    language: 'en',
    voice: VOICE,
    scope: 'dev_test_personal_assistant',
    greeting: "Hi, Anna here. Are we running a test, or do you need help with something today? Let me know if you'd like me to use your name."
  };

  try {
    const raw = fs.readFileSync(personaPath, 'utf8');
    const data = JSON.parse(raw);
    persona = { ...persona, ...data };
  } catch (e) {
    console.log('ℹ️ Using default persona (no persona.json found).');
  }
  return persona;
}

// ---------- App / TwiML ----------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post('/twilio/voice', (req, res) => {
  console.log('➡️ /twilio/voice hit (POST)');
  const vr = new VoiceResponse();
  const connect = vr.connect();
  connect.stream({
    url: `wss://${req.headers.host}/call`,
    track: 'inbound_track'
  });
  // keep call alive (Twilio ends call if we do nothing)
  vr.pause({ length: 600 });

  const twiml = vr.toString();
  console.log('🧾 TwiML returned:\n' + twiml);
  res.type('text/xml').send(twiml);
});

// ---------- HTTP + WS ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/call' });

// Small helper to log buffers safely
function safeJSON(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

wss.on('connection', (twilioWs, req) => {
  console.log(`✅ Twilio WebSocket connected from ${req.socket.remoteAddress}`);

  // Per-call state
  let streamSid = null;
  let oaiWs = null;
  let responseInFlight = false;
  let asstCurrent = '';
  let turnCounter = 0;

  const persona = loadPersona();
  console.log('🎬 Twilio stream START:', safeJSON({
    streamSid,
    model: MODEL,
    voice: VOICE,
    dev: DEV
  }));

  // ---------- Connect to OpenAI Realtime ----------
  const OAI_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}&voice=${encodeURIComponent(VOICE)}`;

  oaiWs = new WebSocket(OAI_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  oaiWs.on('open', () => {
    console.log('🔗 OpenAI Realtime connected');
    console.log('👤 persona snapshot:', safeJSON({
      name: persona.name,
      language: persona.language,
      voice: persona.voice || VOICE,
      scope: persona.scope
    }));

    // Configure session: g711 μ-law from Twilio, server VAD, English ASR
    sendOAI({
      type: 'session.update',
      session: {
        input_audio_format: {
          type: 'g711_ulaw',
          sample_rate: 8000
        },
        // let OpenAI do VAD so we can commit buffers cleanly
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
        input_audio_transcription: { enabled: true, language: persona.language || 'en' },
        // persona priming
        instructions: [
          `You are ${persona.name}.`,
          persona.description || '',
          `Speak ${persona.language || 'en'}.`,
          persona.style || '',
          DEV ? 'You are in a testing context; be concise and confirm assumptions.' : ''
        ].filter(Boolean).join('\n')
      }
    });
    console.log('✅ session.update sent (ASR=en, VAD=server, format=g711_ulaw)');

    // Proactive greeting (ensure audio is produced)
    speak(persona.greeting || 'Hello! How can I help today?');
    console.log('📣 greeting response.create sent');
  });

  oaiWs.on('close', () => {
    console.log('❌ OpenAI Realtime closed');
  });

  oaiWs.on('error', (err) => {
    console.log('❌ OpenAI Realtime error:', err?.message || err);
  });

  // ---------- OAI -> Twilio (events) ----------
  oaiWs.on('message', (buf) => {
    let evt;
    try { evt = JSON.parse(buf.toString()); } catch { return; }

    // VAD / debug
    if (evt.type === 'input_audio_buffer.speech_started') {
      console.log('🔎 OAI event: input_audio_buffer.speech_started');
      return;
    }
    if (evt.type === 'input_audio_buffer.speech_stopped') {
      console.log('🔎 OAI event: input_audio_buffer.speech_stopped');
      return;
    }

    // Final user transcript (ASR)
    if (evt.type === 'conversation.item.input_audio_transcription.completed') {
      turnCounter += 1;
      const text = evt?.transcription?.text || evt?.text || '';
      if (text) console.log(`📝 user: ${text}`);
      return;
    }

    // Assistant TEXT delta (support legacy + new names)
    if (
      evt.type === 'response.output_text.delta' ||
      evt.type === 'response.text.delta'
    ) {
      const delta = evt.delta || '';
      if (delta) {
        asstCurrent += delta;
        process.stdout.write(`🎧 asstΔ ${delta}`);
      }
      return;
    }

    // Assistant AUDIO delta (support legacy + new names)
    if (
      evt.type === 'response.output_audio.delta' ||
      evt.type === 'output_audio.delta'
    ) {
      if (evt.delta && streamSid && twilioWs.readyState === WebSocket.OPEN) {
        // forward base64 μ-law audio to Twilio
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: evt.delta }
        }));
      }
      return;
    }

    // Assistant finished turn
    if (evt.type === 'response.completed') {
      if (asstCurrent.trim()) {
        console.log(`\n🎧 asst: ${asstCurrent.trim()}`);
      }
      asstCurrent = '';
      responseInFlight = false;
      return;
    }

    // Errors (incl. harmless commit_empty)
    if (evt.type === 'error') {
      console.log('🔻 OAI error:', safeJSON(evt));
      responseInFlight = false;
      return;
    }
  });

  // ---------- Twilio -> OAI ----------
  twilioWs.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === 'start') {
      streamSid = data.start?.streamSid || data.streamSid || null;
      console.log(`🧵 Twilio start: streamSid=${streamSid || 'unknown'}`);
      return;
    }

    if (data.event === 'media') {
      // incoming μ-law 8k frames (base64) -> append to OAI buffer
      if (data.media?.payload) {
        sendOAI({
          type: 'input_audio_buffer.append',
          audio: data.media.payload
        });
      }
      return;
    }

    if (data.event === 'stop') {
      console.log('🧵 Twilio event: stop');
      try { oaiWs?.close(); } catch {}
      try { twilioWs?.close(); } catch {}
      return;
    }
  });

  twilioWs.on('close', () => {
    console.log('❌ Twilio WebSocket closed');
    try { oaiWs?.close(); } catch {}
  });

  twilioWs.on('error', (err) => {
    console.log('❌ Twilio WebSocket error:', err?.message || err);
  });

  // ---------- Helpers ----------
  function sendOAI(obj) {
    if (oaiWs && oaiWs.readyState === WebSocket.OPEN) {
      oaiWs.send(JSON.stringify(obj));
    }
  }

  function commitOAI() {
    sendOAI({ type: 'input_audio_buffer.commit' });
  }

  // Speak via response.create; ensure audio modality; add safety fuse
  function speak(text) {
    if (!text) return;
    if (responseInFlight) return;
    responseInFlight = true;
    sendOAI({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: text
      }
    });
    // safety fuse in case response.completed never arrives
    setTimeout(() => { responseInFlight = false; }, 8000);
  }

  // Server-side VAD flow: when we detect stopped, OAI will emit that event.
  // But Twilio itself doesn't send explicit VAD. To help OAI, periodically commit.
  // This keeps buffers from getting "stuck" and reduces commit_empty noise.
  const commitInterval = setInterval(() => {
    // Commit every ~600ms if we have a stream
    if (oaiWs?.readyState === WebSocket.OPEN) {
      commitOAI();
    }
  }, 600);

  // Cleanup
  const cleanup = () => {
    clearInterval(commitInterval);
    try { oaiWs?.close(); } catch {}
    try { twilioWs?.close(); } catch {}
  };

  twilioWs.on('close', cleanup);
  oaiWs.on('close', () => {
    cleanup();
  });
});

// ---------- Start ----------
server.listen(PORT, () => {
  console.log(`🚀 Server listening on :${PORT}`);
});
