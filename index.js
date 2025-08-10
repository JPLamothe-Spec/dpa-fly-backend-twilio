const express = require("express");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();

const { handleIncomingAudio } = require("./stream-handler");
const { ttsToPCM } = require("./tts");

const app = express();
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

// Simple GET check
app.get("/", (req, res) => {
  res.status(200).send("DPA backend (low latency) is live ✅");
});

// Twilio webhook → start streaming
app.post("/twilio/voice", (req, res) => {
  const twiml = `
    <Response>
      <Start>
        <Stream url="wss://${req.headers.host}/media-stream" track="inbound_track" />
      </Start>
      <Pause length="30" />
    </Response>
  `;
  res.type("text/xml");
  res.send(twiml.trim());
});

// HTTP server
const server = http.createServer(app);

// WebSocket server
const wss = new WebSocket.Server({ noServer: true });
let lastAIResponse = ""; // 🛑 Prevent spirals

wss.on("connection", (ws) => {
  console.log("✅ WebSocket connection established");

  ws.on("message", async (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.event === "media") {
        await handleIncomingAudio(msg.media.payload, async (aiText) => {
          // Skip duplicate responses
          if (aiText && aiText !== lastAIResponse) {
            lastAIResponse = aiText;
            console.log(`🧠 AI says: ${aiText}`);

            const audioPCM = await ttsToPCM(aiText);
            ws.send(
              JSON.stringify({
                event: "media",
                media: {
                  payload: audioPCM.toString("base64"),
                },
              })
            );
          }
        });
      }
    } catch (err) {
      console.error("⚠️ WS message error:", err);
    }
  });

  ws.on("close", () => {
    console.log("❌ WebSocket connection closed");
  });
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media-stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
