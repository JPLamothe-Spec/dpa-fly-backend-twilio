import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import xml from 'xml';
import fs from 'fs';

// ───────────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────────
const {
  PORT = 8080,
  OPENAI_API_KEY = '',
  OPENAI_REALTIME_MODEL = 'gpt-4o-realtime-preview-2024-12-17',
  PUBLIC_HOST = '' // e.g. "https://dpa-fly-backend-twilio.fly.dev"
} = process.env;

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

// Load persona
const personaPath = './persona.json';
const persona = JSON.parse(fs.readFileSync(personaPath, 'utf8'));

// ───────────────────────────────────────────────────────────────────────────────
// HTTP server for Twilio <Stream/>
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio Voice webhook -> return TwiML that opens a bidirectional stream
app.post('/twilio/voice', (req, res) => {
  console.log('➡️ /twilio/voice hit (POST)');
  const streamUrl = `${(PUBLIC_HOST || '').replace(/\/$/,'')}/call`;

  const response = xml({
    Response: [
      {
        Connect: [
          {
            Stream: [
              { _attr: { url: streamUrl, track: 'inbound_track' } }
            ]
          }
        ]
      },
      { Pause: [{ _attr: { length: 600 } }] } // keep call open
    ]
  }, { declaration: true });

  console.log('🧾 TwiML returned:');
  console.log(response);
  res.set('Content-Type', 'text/xml');
  res.send(response);
});

const server = app.listen(PORT, () => {
  console.log(`HTTP listening on :${PORT}`);
});

// ───────────────────────────────────────────────────────────────────────────────
// WebSocket bridge: /call  (Twilio Media Stream <-> OpenAI Realtime)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/call' });

wss.on('connection', (twilioWs, req) => {
  const remoteAddr = req.socket.remoteAddress;
  console.log(`✅ Twilio WebSocket connected from ${remoteAddr}`);

  // Track streamSid for replies to Twilio
  let streamSid = null;

  // Connect to OpenAI Realtime
  const oaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;
  const oaiWs = new WebSocket(oaiUrl, {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    }
  });

  // State for assistant text accumulation
  let asstCurrent = '';
  let responseInFlight = false;
  let turnCounter = 0;

  oaiWs.on('open', () => {
    console.log('🔗 OpenAI Realtime connected');
    console.log('👤 persona snapshot:', {
      name: persona.name,
      language: persona.language,
      voice: persona.voice,
      scope: persona.scope
    });

    // Configure session: server VAD, transcription, and audio formats
    sendOAI({
      type: 'session.update',
      session: {
        // core persona / behavior
        instructions: persona.instructions,
        voice: persona.voice,
        modalities: ['text', 'audio'],

        // audio formats (Twilio uses G.711 μ-law 8k)
        input_audio_format: { type: 'g711_ulaw', sample_rate: 8000 },
        output_audio_format: { type: 'g711_ulaw', sample_rate: 8000 },

        // server VAD means we do NOT manually commit
        turn_detection: { type: 'server_vad', silence_duration_ms: 550 },

        // enable ASR transcripts so we can log clean user lines
        input_audio_transcription: { enabled: true, language: persona.language || 'en' }
      }
    });

    console.log('✅ session.update sent (ASR=en, VAD=server, format=g711_ulaw)');

    // Send a short greeting once per call
    greet(`Hi, ${persona.name} here. Are we running a test, or do you need help with something today? You can also tell me your name if you'd like me to use it.`);
  });

  // Utility: send any event to OpenAI
  function sendOAI(obj) {
    try {
      oaiWs.readyState === WebSocket.OPEN && oaiWs.send(JSON.stringify(obj));
    } catch (e) {
      console.error('⚠️ sendOAI error:', e);
    }
  }

  // Utility: ask assistant to speak text (guard against collisions)
  function speak(text) {
    if (!text) return;
    if (responseInFlight) return; // simple gate; could be a queue if desired
    responseInFlight = true;
    sendOAI({
      type: 'response.create',
      response: { instructions: text }
    });
  }

  function greet(text) {
    console.log('📣 greeting response.create sent');
    speak(text);
  }

  // ── Handle incoming messages from Twilio (audio from caller)
  twilioWs.on('message', (msg) => {
    if (typeof msg !== 'string') {
      // Twilio sends JSON strings; ignore binary pings
      return;
    }

    try {
      const data = JSON.parse(msg);

      switch (data.event) {
        case 'start':
          streamSid = data.start?.streamSid;
          console.log('🎬 Twilio stream START:', {
            streamSid,
            model: OPENAI_REALTIME_MODEL,
            voice: persona.voice,
            dev: false
          });
          break;

        case 'media': {
          // Twilio media payload is base64 G.711 μ-law frames (20ms @ 8kHz)
          const payload = data.media?.payload;
          if (payload) {
            // Append straight through to OAI buffer (we do NOT commit manually with server VAD)
            sendOAI({
              type: 'input_audio_buffer.append',
              audio: payload
            });
          }
          break;
        }

        case 'mark':
          // Ignore; server VAD will decide turns
          break;

        case 'stop':
          console.log('🧵 Twilio event: stop');
          safeClose(oaiWs, 'Twilio stop');
          break;
      }
    } catch (e) {
      console.error('⚠️ Twilio WS parse error:', e);
    }
  });

  twilioWs.on('close', () => {
    console.log('❌ Twilio WebSocket closed');
    safeClose(oaiWs, 'Twilio closed');
  });

  // ── Handle messages from OpenAI (assistant text + audio back to Twilio)
  oaiWs.on('message', (buf) => {
    // OpenAI sends JSON frames (and occasionally binary for audio? we configured output as JSON deltas)
    let evt;
    try {
      evt = JSON.parse(buf.toString());
    } catch {
      // Not JSON — ignore
      return;
    }

    // Debug low-level VAD markers (optional)
    if (evt.type === 'input_audio_buffer.speech_started') {
      console.log('🔎 OAI event: input_audio_buffer.speech_started');
      return;
    }
    if (evt.type === 'input_audio_buffer.speech_stopped') {
      console.log('🔎 OAI event: input_audio_buffer.speech_stopped');
      return;
    }

    // Completed user transcription (definitive "what user said")
    if (evt.type === 'conversation.item.input_audio_transcription.completed') {
      turnCounter += 1;
      const text = evt?.transcription?.text || evt?.text || '';
      if (text) console.log(`📝 [turn ${turnCounter}] user: ${text}`);
      return;
    }

    // Assistant text streaming
    if (evt.type === 'response.output_text.delta') {
      const delta = evt.delta || '';
      if (delta) {
        asstCurrent += delta;
        process.stdout.write(`🎧 asstΔ ${delta}`);
      }
      return;
    }

    // Assistant text finished
    if (evt.type === 'response.completed') {
      if (asstCurrent.trim()) {
        console.log(`\n🎧 [turn ${turnCounter}] asst: ${asstCurrent.trim()}`);
      }
      asstCurrent = '';
      responseInFlight = false;
      return;
    }

    // Assistant audio streaming back to caller
    if (evt.type === 'output_audio.delta') {
      // evt.delta is base64 G.711 μ-law (because we set output format)
      if (evt.delta && streamSid && twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: evt.delta }
        }));
      }
      return;
    }

    // Assistant audio done (no-op)
    if (evt.type === 'output_audio.completed') {
      return;
    }

    // Errors
    if (evt.type === 'error') {
      console.log('🔻 OAI error:', JSON.stringify(evt, null, 2));
      // Clear in-flight if an active response errored
      responseInFlight = false;
      return;
    }
  });

  oaiWs.on('close', () => {
    console.log('❌ OpenAI Realtime closed');
    safeClose(twilioWs, 'OAI closed');
  });

  oaiWs.on('error', (err) => {
    console.error('⚠️ OAI WS error:', err);
  });

  function safeClose(ws, reason) {
    if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
    try {
      ws.close(1000, reason || 'done');
    } catch {}
  }
});
