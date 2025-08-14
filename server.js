// server.js
// Express app that serves TwiML and terminates the Twilio <Stream> WebSocket,
// then bridges to OpenAI Realtime.

import 'dotenv/config';
import express from 'express';
import http from 'http';
import { xml } from 'xmlbuilder2';
import { WebSocketServer } from 'ws';
import { handleTwilioStream } from './src/index.js';
import { log } from './src/utils/logger.js';

const app = express();

// Basic health
app.get('/health', (_req, res) => res.status(200).send('ok'));

// TwiML entrypoint for your Twilio Voice number webhook
// Twilio will POST here, we return <Connect><Stream/></Connect> so it dials our WS.
app.post('/twilio/voice', express.urlencoded({ extended: false }), (req, res) => {
  const streamUrl =
    process.env.PUBLIC_WS_URL ||
    `wss://${process.env.FLY_APP_NAME}.fly.dev${process.env.TWILIO_STREAM_PATH || '/call'}`;

  const doc = xml.create({ version: '1.0', encoding: 'UTF-8' })
    .ele('Response')
      .ele('Connect')
        .ele('Stream', { url: streamUrl, track: 'inbound_track' }).up()
      .up()
      // Long pause to keep the SIP leg alive while the stream runs
      .ele('Pause', { length: process.env.TWIML_PAUSE_LEN || '600' }).up()
    .up();

  const twiml = doc.end({ prettyPrint: false });

  log.info('➡️ /twilio/voice hit (POST)');
  log.info('🧾 TwiML returned:\n' + twiml);
  res.type('text/xml').send(twiml);
});

const server = http.createServer(app);

// Upgrade path Twilio hits for the <Stream> websocket
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if ((process.env.TWILIO_STREAM_PATH || '/call') !== new URL(req.url, `http://${req.headers.host}`).pathname) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (twilioWs) => {
    handleTwilioStream(twilioWs, req);
  });
});

const PORT = Number(process.env.PORT || process.env.FLY_PRIVATE_PORT || 8080);
server.listen(PORT, () => {
  log.info(`🚀 Server listening on ${PORT}`);
});
