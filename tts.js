import fetch from "node-fetch";

// Returns 16kHz PCM Buffer for Twilio
export async function ttsToPCM(text) {
  const voice = process.env.TTS_VOICE || "alloy";
  const model = process.env.TTS_MODEL || "gpt-4o-mini-tts";

  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      format: "pcm",
      sample_rate: 16000,
    }),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`TTS error: ${r.status} ${errText}`);
  }

  const arrayBuf = await r.arrayBuffer();
  return Buffer.from(arrayBuf);
}
