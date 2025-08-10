import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { xml } from 'xmlbuilder2';
import pino from 'pino';
import { handleStreamConnection } from './media/stream-handler.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_WSS_URL = process.env.PUBLIC_WSS_URL; // e.g. wss://dpa-fly-backend-twilio.fly.dev/media

const log = pino({ level: process.env.LOG_LEVEL || 'info', transport: { target: 'pino-pretty' }});
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.post('/twilio/voice', (req, res) => {
  log.info('➡️ POST /twilio/voice');
  const twiml = xml({
    Response: {
      Say: { '@voice': 'Polly.Joanna', '#': 'Connecting you now.' },
      Start: {
        Stream: { '@url': `${PUBLIC_WSS_URL}` }
      }
    }
  }).end({ prettyPrint: false });

  res.set('Content-Type', 'text/xml');
  return res.send(twiml);
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (ws) => {
  log.info('✅ WebSocket connection established');
  handleStreamConnection(ws, log.child({ scope: 'media' }));
});

server.listen(PORT, () => log.info(`🚀 Server listening on port ${PORT}`));
