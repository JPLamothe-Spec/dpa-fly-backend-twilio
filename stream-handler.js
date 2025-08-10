// stream-handler.js — full-duplex: inbound (log only) + outbound TTS via system ffmpeg
const { spawn } = require("node:child_process");
const { ttsToMp3 } = require("./tts");

// Convert MP3 → mulaw@8k via system ffmpeg
async function mp3ToMulaw8k(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "warning",
      "-f", "mp3", "-i", "pipe:0",
      "-f", "mulaw", "-ar", "8000", "-ac", "1",
      "pipe:1"
    ], { stdio: ["pipe", "pipe", "inherit"] });

    const out = [];
    ff.stdout.on("data", (d) => out.push(d));
    ff.on("error", reject);
    ff.on("close", (code) => code === 0 ? resolve(Buffer.concat(out))
                                        : reject(new Error(`ffmpeg mp3→mulaw exited ${code}`)));
    try { ff.stdin.end(mp3Buffer); } catch (e) { reject(e); }
  });
}

// Split μ-law buffer into 20ms frames (160 bytes @8kHz)
function* frameMulaw(mu) {
  const FRAME = 160;
  for (let i = 0; i < mu.length; i += FRAME) {
    yield mu.subarray(i, Math.min(i + FRAME, mu.length));
  }
}

function handleStream(ws) {
  let streamSid = null;
  let greeted = false;

  const safeClose = () => { try { ws.close(); } catch {} };

  // Simple outbound player: send μ-law frames + final mark
  async function playMulawFrames(muBuffer) {
    if (!streamSid || ws.readyState !== 1) return;
    for (const fr of frameMulaw(muBuffer)) {
      ws.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: fr.toString("base64") }
      }));
    }
    // send a mark so we know playback finished
    ws.send(JSON.stringify({
      event: "mark",
      streamSid,
      mark: { name: `utt-${Date.now()}` }
    }));
  }

  // Speak helper: TTS → μ-law → send frames
  async function speak(text) {
    try {
      const mp3 = await ttsToMp3(text);
      const mu = await mp3ToMulaw8k(mp3);
      await playMulawFrames(mu);
    } catch (e) {
      console.error("TTS/playback error:", e?.message || e);
    }
  }

  ws.on("message", async (message) => {
    let msg;
    try { msg = JSON.parse(message.toString()); }
    catch { return; }

    switch (msg.event) {
      case "connected":
        console.log("📞 Twilio media stream connected");
        break;

      case "start":
        streamSid = msg.start?.streamSid;
        console.log(`🔗 Stream started. streamSid=${streamSid || "unknown"}`);
        // One-time greeting so you can confirm two-way audio immediately
        if (!greeted) {
          greeted = true;
          speak("Hi, this is Anna. I can hear you. How can I help?");
        }
        break;

      case "media": {
        // Inbound audio arrives here (base64 μ-law). We’ll log size for now.
        const b64 = msg.media?.payload;
        if (!b64) return;
        // const mulaw = Buffer.from(b64, "base64"); // available for future ASR
        // console.log("📨 inbound media bytes:", mulaw.length);
        break;
      }

      case "mark":
        console.log(`✔️ Playback mark: ${msg.mark?.name || ""}`);
        break;

      case "stop":
        console.log("🛑 Twilio signaled stop — closing stream");
        safeClose();
        break;

      default:
        break;
    }
  });

  ws.on("close", () => console.log("❌ WebSocket closed"));
  ws.on("error", (e) => console.error("⚠️ WebSocket error:", e));
}

module.exports = { handleStream };
