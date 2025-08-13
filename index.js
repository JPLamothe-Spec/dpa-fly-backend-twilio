/**
 * DPA Twilio <-> OpenAI Realtime bridge (CommonJS)
 * - Port: 3000
 * - Audio codec: G.711 μ-law (8kHz) passthrough end-to-end
 * - Incremental latency improvements: 120–300ms commit cadence
 *
 * ENV:
 *   OPENAI_API_KEY=sk-...
 *   OAI_MODEL=gpt-4o-realtime-preview-2024-12-17  (default)
 *   OAI_VOICE=shimmer                                (default)
 *   DEV_LOG=true                                     (optional)
 */

const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OAI_MODEL = process.env.OAI_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const OAI_VOICE = process.env.OAI_VOICE || 'shimmer';
const DEV = String(process.env.DEV_LOG || 'true') === 'true';

function log(...args) { if (DEV) console.log(...args); }

function twiml(strings) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    '  <Connect>',
    '    <Stream url="wss://'+process.env.FLY_APP_NAME+'.fly.dev/call" track="inbound_track"/>',
    '  </Connect>',
    '  <Pause length="30"/>',
    '</Response>'
  ].join('\n');
}

/** Twilio webhook -> return TwiML that opens the <Stream> to our /call WS */
app.post('/twilio/voice', (req, res) => {
  log('➡️ /twilio/voice hit (POST)');
  const xml = twiml();
  log('🧾 TwiML returned:\n' + xml.replaceAll('<','\n<'));
  res.type('text/xml').status(200).send(xml);
});

/**
 * We host both HTTP and WS on the same server to accept Twilio <Stream>.
 * Twilio will connect a WS to /call and stream 20ms μ-law frames at 8kHz.
 */
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

/** Helper: build OpenAI Realtime event frame */
function rtEvent(type, payload = {}) {
  return JSON.stringify({ type, ...payload });
}

/** Base64 helpers */
const b64ToBuf = (b64) => Buffer.from(b64, 'base64');
const bufToB64 = (buf) => Buffer.from(buf).toString('base64');

/** A per-call session handler */
function handleTwilioCallWS(twilioWS, req) {
  const remoteAddrs = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  log(`✅ Twilio WebSocket connected from ${remoteAddrs}`);
  let streamSid = null;

  // ---- OpenAI Realtime socket
  const oaiUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OAI_MODEL)}`;
  const oaiWS = new WebSocket(oaiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
      'User-Agent': 'dpa-twilio-g711/1.0'
    }
  });

  // --- State for buffering + commit cadence
  let lastAppendTs = 0;
  let lastCommitTs = 0;
  let bufferedMs = 0;        // ms of audio since last commit
  let closed = false;

  // We’ll trickle commits: commit every 200–300ms if we have ≥120ms buffered
  const MIN_COMMIT_MS = 120;     // don’t commit <120ms
  const TARGET_COMMIT_MS = 240;  // try to commit at ~240ms cadence
  const MAX_COMMIT_MS = 400;     // force commit by 400ms as upper bound

  // Twilio sends 20ms μ-law frames
  const FRAME_MS = 20;

  function safeSendTwilio(obj) {
    try {
      if (twilioWS.readyState === WebSocket.OPEN) twilioWS.send(JSON.stringify(obj));
    } catch {}
  }

  function safeSendOAI(objStr) {
    try {
      if (oaiWS.readyState === WebSocket.OPEN) oaiWS.send(objStr);
    } catch {}
  }

  function appendToOAI(b64) {
    // Append μ-law frame to OAI input buffer
    safeSendOAI(rtEvent('input_audio_buffer.append', { audio: b64 }));
    bufferedMs += FRAME_MS;
    lastAppendTs = Date.now();
  }

  function tryCommit(cause) {
    const now = Date.now();
    const sinceCommit = now - lastCommitTs;
    if (bufferedMs >= MIN_COMMIT_MS && sinceCommit >= MIN_COMMIT_MS) {
      safeSendOAI(rtEvent('input_audio_buffer.commit'));
      if (DEV) log(`🔊 committed ~${bufferedMs}ms cause=${cause}`);
      bufferedMs = 0;
      lastCommitTs = now;
      // Request a response (non-blocking). If model already speaking, it's fine.
      safeSendOAI(rtEvent('response.create', {}));
    }
  }

  // Commit ticker to keep cadence ~240ms even if user speaks continuously
  const commitTicker = setInterval(() => {
    if (closed) return;
    const sinceCommit = Date.now() - lastCommitTs;
    if (bufferedMs >= TARGET_COMMIT_MS || sinceCommit >= MAX_COMMIT_MS) {
      tryCommit('ticker');
    }
  }, 60);

  oaiWS.on('open', () => {
    log('🔗 OpenAI Realtime connected');

    // IMPORTANT: audio formats must be STRINGs for μ-law. (Fixes previous error.)
    safeSendOAI(rtEvent('session.update', {
      session: {
        voice: OAI_VOICE,
        turn_detection: null,               // we control commits for low latency
        input_audio_format: 'g711_ulaw',    // ✅ string, not object
        output_audio_format: 'g711_ulaw',   // ✅ string, not object
        input_audio_transcription: { model: 'gpt-4o-mini-transcribe' }
      }
    }));
    log('✅ session.updated (ASR=g711_ulaw, 8kHz)');
  });

  oaiWS.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }

    switch (msg.type) {
      // Audio back from OpenAI in μ-law deltas (base64)
      case 'response.audio.delta': {
        const b64 = msg.delta;
        if (!b64) break;
        if (!streamSid) break; // wait until we know Twilio stream id
        safeSendTwilio({
          event: 'media',
          streamSid,
          media: { payload: b64 }
        });
        break;
      }

      // Optional: human-readable transcript as we go
      case 'response.transcript.delta': {
        if (DEV && msg.delta) {
          // Log small fragments inline
          process.stdout.write(`🗣️ ANNA SAID: ${msg.delta}\n`);
        }
        break;
      }

      // Useful to know when TTS actually starts
      case 'response.output_audio.started':
        log('🔊 OAI TTS started');
        break;

      // Errors
      case 'error':
      case 'response.error':
        log('🔻 OAI error:', JSON.stringify(msg, null, 2));
        break;
    }
  });

  oaiWS.on('close', (code) => {
    log('🔚 OAI socket closed', code);
    try { twilioWS.close(); } catch {}
  });

  oaiWS.on('error', (err) => {
    log('🔻 OAI WS error', err?.message || err);
  });

  // ---- Twilio <Stream> messages
  twilioWS.on('message', (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString('utf8')); } catch { return; }

    switch (evt.event) {
      case 'start': {
        streamSid = evt.start.streamSid;
        log('📞 Twilio media stream connected (sid=' + streamSid + ')');
        break;
      }

      case 'media': {
        // 20ms μ-law audio payload (base64)
        const payloadB64 = evt.media?.payload;
        if (!payloadB64) return;

        // Forward to OAI buffer and trickle-commit
        appendToOAI(payloadB64);

        // Commit more aggressively for low-latency
        const sinceCommit = Date.now() - lastCommitTs;
        if (bufferedMs >= TARGET_COMMIT_MS || sinceCommit >= MAX_COMMIT_MS) {
          tryCommit('trickle');
        }
        break;
      }

      case 'mark':
        // ignore
        break;

      case 'stop': {
        log('🛑 Twilio STOP event');
        // Final commit if we still have audio
        tryCommit('stop');
        try { oaiWS.close(); } catch {}
        break;
      }
    }
  });

  twilioWS.on('close', () => {
    log('❌ Twilio WS closed');
    closed = true;
    clearInterval(commitTicker);
    try { oaiWS.close(); } catch {}
  });

  twilioWS.on('error', (err) => {
    log('🔻 Twilio WS error', err?.message || err);
  });
}

// Upgrade HTTP -> WS for /call (Twilio <Stream>)
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/call') {
    // Basic auth-like guard if you want (optional)
    // if (req.headers['authorization'] !== `Bearer ${process.env.TWILIO_STREAM_TOKEN}`) { ... }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  handleTwilioCallWS(ws, req);
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
