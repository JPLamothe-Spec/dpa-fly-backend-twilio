import fetch from 'node-fetch';

// Returns an MP3 Buffer (24kHz mono). No WAV -> fixes "invalid RIFF header".
export async function ttsToMp3(text) {
  const voice = process.env.TTS_VOICE || 'alloy';
  const model = process.env.TTS_MODEL || 'gpt-4o-mini-tts'; // or your preferred TTS model

  // OpenAI TTS (Audio Speech) – MP3 out
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      format: 'mp3',
      sample_rate: 24000
    })
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`TTS error: ${r.status} ${errText}`);
  }
  const arrayBuf = await r.arrayBuffer();
  return Buffer.from(arrayBuf);
}
