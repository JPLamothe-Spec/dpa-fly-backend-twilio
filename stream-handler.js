const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");
const { ttsToMp3 } = require("./tts");
require("dotenv").config();

function handleStream(ws) {
  let ffmpeg;

  ws.on("message", async (message) => {
    const msg = JSON.parse(message);

    if (msg.event === "start") {
      console.log(`🔗 Stream started: ${msg.streamSid}`);
      ffmpeg = spawn(ffmpegPath, [
        "-f", "mulaw",
        "-ar", "8000",
        "-ac", "1",
        "-i", "pipe:0",
        "-f", "s16le",
        "-ar", "16000",
        "pipe:1"
      ]);
      ffmpeg.stdout.on("data", (chunk) => {
        // Here you could forward PCM chunks to GPT
      });
    }

    if (msg.event === "media" && ffmpeg) {
      const audio = Buffer.from(msg.media.payload, "base64");
      ffmpeg.stdin.write(audio);
    }

    if (msg.event === "stop") {
      console.log("🛑 Stream stopped");
      if (ffmpeg) ffmpeg.kill("SIGINT");
      ws.close();
    }
  });

  ws.on("close", () => {
    console.log("❌ WebSocket closed");
    if (ffmpeg) ffmpeg.kill("SIGINT");
  });
}

module.exports = { handleStream };
