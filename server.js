// server.js — CommonJS, Fly.io + Twilio Realtime bridge
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;

// ---- config ----
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000; // Fly default
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const DEFAULT_VOICE = process.env.REALTIME_VOICE || 'shimmer';
const DEFAULT_SCOPE = process.env.DPA_SCOPE || 'dev_test_personal_assistant';
const PUBLIC_HOST = process.env.PUBLIC_HOST || ''; // e.g. "dpa-fly-backend-twilio.fly.dev"

// ---- tiny logger ----
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- persona loader ----
function loadPersona() {
  const file = path.resolve(process.cwd(), 'persona', 'anna.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const p = JSON.parse(raw);
    return {
      name: p.name || 'Anna',
      language: p.language || 'en',
      voice: p.voice || DEFAULT_VOICE,
      scope: p.scope || DEFAULT_SCOPE,
      system: p.system || '',
    };
  } catch (err) {
    log('⚠️ Persona load failed, using defaults:', err.message);
    return { name: 'Anna', language: 'en', voice: DEFAULT_VOICE, scope: DEFAULT_SCOPE, system: '' };
  }
}

// ---- express ----
const app = express();
app.set('trust proxy', true);
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

// Twilio entry point – returns TwiML with a **WSS** stream URL
app.post('/twilio/voice', (req, res) => {
  const host =
    PUBLIC_HOST ||
    req.get('x-forwarded-host') ||
    req.get('host');

  const streamUrl = `wss://${host}/call`; // <— force WSS
  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Connect><Stream url="${streamUrl}" track="inbound_track"/></Connect>` +
    `<Pause length="600"/>` +
    `</Response>`;

  log('➡️ /twilio/voice hit (POST)');
  log('🧾 TwiML returned:\n' + twiml);
  res.type('text/xml').send(twiml);
});

// ---- HTTP + WS endpoint ----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/call') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ---- Twilio <-> OpenAI bridge ----
wss.on('connection', async (twilioWs, req) => {
  const persona = loadPersona();
  log('✅ Twilio WebSocket connected from', req.socket.remoteAddress);

  const oaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  let streamSid;
  let framesSinceLastCommit = 0; // avoid commit_empty
  let asstPartial = '';

  const oaiSend = obj => {
    if (oaiWs.readyState === WebSocket.OPEN) oaiWs.send(JSON.stringify(obj));
  };

  const sendToTwilio = base64Ulaw => {
    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: base64Ulaw } }));
    }
  };

  // ---- Twilio -> OpenAI ----
  twilioWs.on('message', data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.event) {
      case 'start': {
        streamSid = msg.start?.streamSid;
        log('🎬 Twilio stream START:', {
          streamSid,
          model: MODEL,
          voice: persona.voice,
          dev: false,
        });

        oaiSend({
          type: 'session.update',
          session: {
            input_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
            output_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000 },
            turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 200 },
            input_transcription: { model: 'whisper-1', language: persona.language },
            voice: persona.voice,
            instructions: [
              `You are ${persona.name}, a concise, friendly personal assistant.`,
              persona.system || '',
            ].filter(Boolean).join('\n'),
          },
        });
        log('✅ session.update sent (ASR=en, VAD=server, format=g711_ulaw)');

        oaiSend({
          type: 'response.create',
          response: {
            modalities: ['audio', 'text'],
            conversation: 'none',
            instructions: 'Greet briefly and ask how you can help.',
          },
        });
        log('📣 greeting response.create sent');
        break;
      }

      case 'media': {
        framesSinceLastCommit++;
        oaiSend({ type: 'input_audio_buffer.append', audio: msg.media.payload });
        break;
      }

      case 'stop': {
        log('🧵 Twilio event: stop');
        try { twilioWs.close(); } catch {}
        break;
      }
    }
  });

  twilioWs.on('close', () => {
    try { oaiWs.close(); } catch {}
    log('❌ Twilio WebSocket closed');
  });

  twilioWs.on('error', e => log('❌ Twilio WS error:', e?.message));

  // ---- OpenAI -> Twilio ----
  oaiWs.on('open', () => {
    log('🔗 OpenAI Realtime connected');
    log('👤 persona snapshot:', {
      name: persona.name, language: persona.language, voice: persona.voice, scope: persona.scope,
    });
  });

  oaiWs.on('message', raw => {
    const evt = JSON.parse(raw.toString());

    if (evt.type === 'input_audio_buffer.speech_started') {
      log('🔎 OAI event: input_audio_buffer.speech_started');
      framesSinceLastCommit = 0;
    }

    if (evt.type === 'input_audio_buffer.speech_stopped') {
      log('🔎 OAI event: input_audio_buffer.speech_stopped');
      if (framesSinceLastCommit > 0) oaiSend({ type: 'input_audio_buffer.commit' });
      framesSinceLastCommit = 0;
      oaiSend({ type: 'input_transcription.create' });
    }

    if (evt.type === 'input_transcription.completed') {
      const text = (evt.transcript || '').trim();
      if (text) log('📝 user:', text);
    }

    if (evt.type === 'response.output_text.delta') {
      const delta = evt.delta || '';
      asstPartial += delta;
      const tokens = delta.split(/\s+/).filter(Boolean);
      if (tokens.length) log('🎧 asstΔ', tokens.join(' '));
    }

    if (evt.type === 'response.output_text.done') {
      const line = (asstPartial || '').trim();
      if (line) log('🎧 asst:', line);
      asstPartial = '';
    }

    if (evt.type === 'response.audio.delta') {
      sendToTwilio(evt.delta); // base64 g711 μ-law back to Twilio
    }

    if (evt.type === 'error') {
      log('🔻 OAI error:', JSON.stringify(evt, null, 2));
    }
  });

  oaiWs.on('close', () => {
    log('❌ OpenAI Realtime closed');
    try { twilioWs.close(); } catch {}
  });

  oaiWs.on('error', e => log('❌ OpenAI WS error:', e?.message));
});

// ---- start ----
server.listen(PORT, () => {
  log(`🚀 server listening on :${PORT}`);
  if (!OPENAI_API_KEY) log('❗ OPENAI_API_KEY is not set — Realtime connection will fail.');
});
