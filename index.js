// index.js
import express from 'express';
import http from 'http';
import WebSocket from 'ws';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
dotenv.config();

import { handleStream } from './stream-handler.js';

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ✅ Health check endpoint for Fly.io
app.get('/health', (req, res) => res.send('ok'));

// ✅ Twilio webhook to start streaming
app.post('/twilio/voice', (req, res) => {
  console.log('📞 Incoming Twilio Voice webhook hit');

  const host = req.headers.host;
  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${host}/media-stream" track="inbound_track" />
      </Start>
      <Pause length="30" />
    </Response>
  `;

  res.type('text/xml');
  res.send(twiml.trim());
});

// ✅ Create HTTP server
const server = http.createServer(app);

// ✅ WebSocket server (noServer mode for manual upgrade)
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/media-stream') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log('✅ WebSocket connection established with Twilio');
      handleStream(ws);
    });
  } else {
    socket.destroy();
  }
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
