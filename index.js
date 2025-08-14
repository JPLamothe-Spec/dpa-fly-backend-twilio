// src/index.js
// Bridges Twilio Media Stream <-> OpenAI Realtime WS with robust lifecycle handling.

import WebSocket from 'ws';
import { log } from './utils/logger.js';
import { loadPersona } from './persona.js';
import {
  createRealtimeUrl,
  encodeAppendFrame,
  TwilioCoalescer,
} from './utils/realtime.js';

export function handleTwilioStream(twilioWs, req) {
  const ipChain = [req.socket.remoteAddress, req.headers['x-forwarded-for']].filter(Boolean).join(', ');
  log.info(`✅ Twilio WebSocket connected from ${ipChain}`);

  const persona = loadPersona();
  log.info('🧠 Persona loaded: ' + JSON.stringify({
    voice: persona.voice,
    asrModel: persona.asrModel,
    ttsModel: persona.ttsModel
  }, null, 2));

  // --- OpenAI Realtime socket ---
  const oaiUrl = createRealtimeUrl({ model: persona.ttsModel, voice: persona.voice, dev: persona.devMode });
  const oaiWs = new WebSocket(oaiUrl, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
  });

  // Close + error logging (both sockets)
  const wireCloseLogging = () => {
    oaiWs.on('close', (code, reason) => log.error('❌ OAI WS closed', { code, reason: reason?.toString() }));
    oaiWs.on('error', (err) => log.error('🧨 OAI WS error', err));
    twilioWs.on('close', (code, reason) => log.error('❌ Twilio WS closed', { code, reason: reason?.toString() }));
    twilioWs.on('error', (err) => log.error('🧨 Twilio WS error', err));
  };
  wireCloseLogging();

  // Always drain Realtime messages (don’t back up the socket)
  oaiWs.on('message', (buf) => {
    let evt;
    try { evt = JSON.parse(buf.toString()); } catch { return; }
    const t = evt?.type || evt?.event || 'unknown';
    if (t.startsWith('response.audio_transcript.')) {
      if (t.endsWith('delta')) log.info(`🔎 OAI event: ${t}`);
      if (evt?.delta) log.info(`🗣️ ANNA SAID: ${evt.delta}`);
      if (t.endsWith('done')) log.info(`🔎 OAI event: ${t}`);
    } else if (t.startsWith('conversation.item.input_audio_transcription.')) {
      // keep, useful for dev
      if (t.endsWith('delta') && evt?.delta) log.info(`👂 YOU SAID (conv.delta): ${evt.delta}`);
      if (t.endsWith('completed') && evt?.transcript) log.info(`👂 YOU SAID (conv.completed): ${evt.transcript}`);
      if (!evt?.transcript && (t.endsWith('delta') || t.endsWith('completed')))
        log.info(`🔎 conv.${t.split('.').pop()} arrived but no transcript field found`);
    } else if (t.startsWith('input_audio_buffer.')) {
      log.debug(`🔎 OAI event: ${t}`);
    } else if (evt?.type === 'error' || evt?.error) {
      log.error('🔻 OAI error:', evt);
    }
  });

  oaiWs.on('open', () => {
    log.info('🔗 OpenAI Realtime connected');

    // Configure session (ASR model etc.)
    const sessionUpdate = {
      type: 'session.update',
      session: {
        input_audio_format: { type: 'g711_ulaw', channels: 1, sample_rate_hz: 8000 }, // matches Twilio media
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 200, silence_duration_ms: 300 },
        input_audio_transcription: { model: persona.asrModel },
      }
    };
    oaiWs.send(JSON.stringify(sessionUpdate));
    log.info(`✅ session.updated (ASR=${persona.asrModel})`);

    // Immediate keep-alive / prompt a greeting turn to avoid idle close
    oaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        instructions: persona.systemPrompt || ' ',
        modalities: ['audio'],
      }
    }));
  });

  // Ping keepalive (some edges get grumpy)
  const ping = setInterval(() => { try { oaiWs.ping(); } catch {} }, 15000);
  oaiWs.on('close', () => clearInterval(ping));

  // --- Twilio -> Realtime audio pipeline with 100ms commit rule ---
  const coalescer = new TwilioCoalescer({
    minCommitMs: 120, // commit >=100ms; 120ms gives headroom
    onCommit: (packed) => {
      // packed is a contiguous Base64 μ-law 8k chunk representing >=100ms
      // Realtime append frame
      const msg = encodeAppendFrame(packed);
      oaiWs.readyState === WebSocket.OPEN && oaiWs.send(msg);
      // Then commit
      oaiWs.readyState === WebSocket.OPEN && oaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      log.info(`🔊 committed ~${packed.approxMs}ms cause=coalesce`);
    }
  });

  // Drain Twilio stream events
  twilioWs.on('message', (buf) => {
    let evt;
    try { evt = JSON.parse(buf.toString()); } catch { return; }

    // Twilio Media Streams events of interest:
    //   "start", "media", "mark", "stop"
    switch (evt.event) {
      case 'start': {
        const dev = String(process.env.DEV_MODE || '').toLowerCase() === 'true';
        log.info('🎬 Twilio stream START: ' + JSON.stringify({
          streamSid: evt.start?.streamSid,
          voice: loadPersona().voice,
          model: loadPersona().ttsModel,
          dev
        }, null, 2));
        break;
      }
      case 'media': {
        // evt.media.payload is base64 μ-law 8k mono 20ms frames from Twilio
        const base64Mulaw = evt.media?.payload;
        if (base64Mulaw) coalescer.push(base64Mulaw, 20); // 20ms per frame
        break;
      }
      case 'mark':
        // no-op
        break;
      case 'stop':
        log.info('🛑 Twilio stream STOP');
        try { oaiWs.close(); } catch {}
        try { twilioWs.close(); } catch {}
        break;
      default:
        // ignore others
        break;
    }
  });

  // If either socket dies, clean up the other
  const closeBoth = () => {
    try { oaiWs.close(); } catch {}
    try { twilioWs.close(); } catch {}
  };
  twilioWs.on('close', closeBoth);
  oaiWs.on('close', closeBoth);
}
