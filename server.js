// server.js
// Node 20+, ESM (package.json: { "type": "module" })
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import http from 'http';
import bodyParser from 'body-parser';
import WebSocket, { WebSocketServer } from 'ws';

// ---------- config ----------
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const VOICE = process.env.REALTIME_VOICE || 'shimmer';
const DEV_SCOPE = process.env.DPA_SCOPE || 'dev_test_personal_assistant';

// ---------- tiny logger ----------
const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---------- persona loader ----------
function loadPersona() {
  // Default to ./persona/anna.json (shape: {name, language, voice, system?})
  // You can swap this to import a JS file if you prefer.
  const p = path.resolve(process.cwd(), 'persona', 'anna.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const persona = JSON.parse(raw);
    return {
      name: persona.name || 'Anna',
      language: persona.language || 'en',
      voice: persona.voice || VOICE,
      scope: persona.scope || DEV_SCOPE,
      system: persona.system || '',
    };
  } catch (e) {
    log('⚠️  Persona load failed, using defaults:', e.message);
    return { name: 'Anna', language: 'en', voice: VOICE, scope: DEV_SCOPE, system: '' };
  }
}

// ---------- app & routes ----------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health + root so Fly smoke checks succeed
app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

// Twilio hits this to begin the websocket media stream
app.post('/twilio/voice', (req, res) => {
  const streamUrl = `${req.protocol}://${req.get('host')}/call`;
  const twiml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `  <Connect><Stream url="${streamUrl}" track="inbound_track"/></Connect>`,
    '  <Pause length="600"/>', // keep call open; assistant handles turn-taking
    '</Response>',
  ].join('');
  log('➡️ /twilio/voice hit (POST)');
  log('🧾 TwiML returned:\n' + twiml);
  res.type('text/xml').send(twiml);
});

// ---------- HTTP server + WS endpoint for Twilio ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/call') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ---------- Twilio <-> OpenAI Realtime bridge ----------
wss.on('connection', async (twilioWs, req) => {
  const persona = loadPersona();
  log('✅ Twilio WebSocket connected from', req.socket.remoteAddress);

  // Connect to OpenAI Realtime WebSocket
  const oaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  let framesSinceLastCommit = 0; // to avoid commit_empty
  let userPartial = '';
  let asstPartial = '';
  let streamSid = undefined;

  const sendToTwilio = (payloadBase64) => {
    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(
        JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: payloadBase64 },
        })
      );
    }
  };

  const oaiSend = (obj) => {
    if (oaiWs.readyState === WebSocket.OPEN) oaiWs.send(JSON.stringify(obj));
  };

  // ---- Twilio incoming -> OpenAI ----
  twilioWs.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case 'start': {
        streamSid = msg.start?.streamSid;
        log('🎬 Twilio stream START:', {
          streamSid,
          model: MODEL,
          voice: persona.voice,
          dev: false,
        });

        // configure Realtime session: input & output are G.711 μ-law @8k for Twilio
        oaiSend({
          type: 'session.update',
          session: {
            input_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
            output_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
            turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 200 },
            input_transcription: { model: 'whisper-1', language: persona.language },
            instructions: [
              `You are ${persona.name}, a helpful, concise personal assistant.`,
              persona.system || '',
            ]
              .filter(Boolean)
              .join('\n'),
            voice: persona.voice,
          },
        });
        log('✅ session.update sent (ASR=en, VAD=server, format=g711_ulaw)');

        // kick off greeting
        oaiSend({
          type: 'response.create',
          response: {
            modalities: ['audio', 'text'],
            conversation: 'none',
            instructions:
              'Greet the caller briefly and ask how you can help. If testing, acknowledge test mode.',
          },
        });
        log('📣 greeting response.create sent');
        break;
      }

      case 'media': {
        // Twilio audio (8k ulaw) -> OAI input buffer
        framesSinceLastCommit++;
        oaiSend({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload, // pass-through base64 ulaw
        });
        break;
      }

      case 'mark':
        break;

      case 'stop': {
        log('🧵 Twilio event: stop');
        try {
          twilioWs.close();
        } catch {}
        break;
      }
    }
  });

  twilioWs.on('close', () => {
    try {
      oaiWs.close();
    } catch {}
    log('❌ Twilio WebSocket closed');
  });

  twilioWs.on('error', (e) => log('❌ Twilio WS error:', e?.message));

  // ---- OpenAI -> events / audio back to Twilio ----
  oaiWs.on('open', () => {
    log('🔗 OpenAI Realtime connected');
    log('👤 persona snapshot:', {
      name: persona.name,
      language: persona.language,
      voice: persona.voice,
      scope: persona.scope,
    });
  });

  oaiWs.on('message', (raw) => {
    const evt = JSON.parse(raw.toString());

    // Helpful debug: log certain engine-side events
    if (evt.type === 'input_audio_buffer.speech_started') {
      log('🔎 OAI event: input_audio_buffer.speech_started');
      userPartial = '';
      framesSinceLastCommit = 0;
    }

    if (evt.type === 'input_audio_buffer.speech_stopped') {
      log('🔎 OAI event: input_audio_buffer.speech_stopped');
      // Only commit if we actually buffered audio (prevents commit_empty)
      if (framesSinceLastCommit > 0) {
        oaiSend({ type: 'input_audio_buffer.commit' });
      }
      framesSinceLastCommit = 0;
      // Ask for a transcript of what user just said
      oaiSend({ type: 'input_transcription.create' });
    }

    // User transcript completed
    if (evt.type === 'input_transcription.completed') {
      const text = (evt.transcript || '').trim();
      if (text) {
        log('📝 user:', text);
      }
    }

    // Assistant text deltas
    if (evt.type === 'response.output_text.delta') {
      asstPartial += evt.delta || '';
      // Print incremental words with the "asstΔ" style seen in your logs
      const tokens = (evt.delta || '').split(/\s+/).filter(Boolean);
      if (tokens.length) {
        log('🎧 asstΔ', tokens.join(' '));
      }
    }

    // Assistant text completed (print the full line once)
    if (evt.type === 'response.output_text.done') {
      const line = (asstPartial || '').trim();
      if (line) log('🎧 asst:', line);
      asstPartial = '';
    }

    // Assistant audio stream (already g711_ulaw base64) -> Twilio
    if (evt.type === 'response.audio.delta') {
      sendToTwilio(evt.delta);
    }

    // When the response is fully done, request the next turn (if needed)
    if (evt.type === 'response.completed') {
      // noop — VAD will trigger next turn when the user speaks
    }

    // Bubble up any OpenAI errors cleanly in logs
    if (evt.type === 'error') {
      log('🔻 OAI error:', JSON.stringify(evt, null, 2));
    }
  });

  oaiWs.on('close', () => {
    log('❌ OpenAI Realtime closed');
    try {
      twilioWs.close();
    } catch {}
  });

  oaiWs.on('error', (e) => log('❌ OpenAI WS error:', e?.message));
});

// ---------- start ----------
server.listen(PORT, () => {
  log(`🚀 server listening on :${PORT}`);
  if (!OPENAI_API_KEY) {
    log('❗ OPENAI_API_KEY is not set — the Realtime connection will fail.');
  }
});
