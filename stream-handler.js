const prism = require("prism-media");
const fetch = require("node-fetch");

let aiBuffer = Buffer.alloc(0);

async function handleIncomingAudio(base64Chunk, onAIResponse) {
  const chunk = Buffer.from(base64Chunk, "base64");
  aiBuffer = Buffer.concat([aiBuffer, chunk]);

  // Process every ~1 sec of audio
  if (aiBuffer.length >= 32000) {
    const transcript = await transcribeWithGPT(aiBuffer);
    aiBuffer = Buffer.alloc(0);

    // Skip empty/silent transcripts
    if (transcript && transcript.trim().length > 0) {
      const aiReply = await getGPTReply(transcript);
      if (aiReply) {
        await onAIResponse(aiReply);
      }
    }
  }
}

async function transcribeWithGPT(audioBuffer) {
  try {
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: audioBuffer,
    });
    if (!r.ok) return "";
    const data = await r.json();
    return data.text || "";
  } catch (err) {
    console.error("Transcription error:", err);
    return "";
  }
}

async function getGPTReply(prompt) {
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are Anna, JP's friendly Australian digital assistant. Keep responses short, relevant, and avoid repeating yourself.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    const data = await r.json();
    return data.choices?.[0]?.message?.content || "";
  } catch (err) {
    console.error("GPT reply error:", err);
    return "";
  }
}

module.exports = { handleIncomingAudio };
