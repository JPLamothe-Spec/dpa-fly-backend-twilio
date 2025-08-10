// stream-handler.js (CommonJS) — Twilio media stream → ffmpeg (mulaw 8k → s16le 16k)
const { spawn } = require("node:child_process");
// const { ttsToMp3 } = require("./tts"); // keep commented out until you use it

function handleStream(ws) {
  let ffmpeg = null;
  let closed = false;

  const safeKill = () => {
    if (ffmpeg) {
      try { ffmpeg.stdin.end(); } catch {}
      try { ffmpeg.kill("SIGINT"); } catch {}
      ffmpeg = null;
    }
  };

  ws.on("message", (message) => {
    let msg;
    try {
      msg = JSON.parse(message.toString());
    } catch {
      // Twilio sends only JSON, but be defensive.
      return;
    }

    if (msg.event === "connected") {
      console.log("🔌 Twilio stream: connected");
      return;
    }

    if (msg.event === "start") {
      console.log(`🔗 Stream started: ${msg.streamSid}`);

      // Spawn system ffmpeg (installed via APK in Dockerfile)
      try {
        ffmpeg = spawn("ffmpeg", [
          "-hide_banner", "-loglevel", "warning",
          "-f", "mulaw", "-ar", "8000", "-ac", "1", "-i", "pipe:0",
          "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1"
        ]);

        ffmpeg.on("error", (e) => console.error("❌ ffmpeg spawn error:", e));
        ffmpeg.stderr.on("data", (d) => console.log(String(d).trim()));

        // If/when you wire ASR, consume stdout frames here.
        ffmpeg.stdout.on("data", (_chunk) => {
          // TODO: send PCM to ASR/GPT
        });

        ffmpeg.stdin.on("error", (e) => {
          // Happens if Twilio closes while we're writing — don’t crash.
          console.warn("⚠️ ffmpeg stdin error:", e.message);
        });

        ffmpeg.on("close", (code) => {
          console.log("🧹 ffmpeg closed", code);
        });
      } catch (e) {
        console.error("❌ Failed to start ffmpeg:", e);
        try { ws.close(); } catch {}
      }
      return;
    }

    if (msg.event === "media" && ffmpeg && msg.media?.payload) {
      const mulaw = Buffer.from(msg.media.payload, "base64");
      // Best-effort write; ignore backpressure for now (frames are small).
      try { ffmpeg.stdin.write(mulaw); } catch (e) {
        console.warn("⚠️ write to ffmpeg failed:", e.message);
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("🛑 Twilio stream stopped");
      safeKill();
      try { ws.close(); } catch {}
      return;
    }

    // Optional: handle "mark" events etc.
  });

  ws.on("close", () => {
    if (closed) return;
    closed = true;
    console.log("❌ WebSocket closed");
    safeKill();
  });

  ws.on("error", (e) => {
    console.error("⚠️ WebSocket error:", e);
    safeKill();
  });
}

module.exports = { handleStream };
