// persona.js — load persona from env (JSON or Base64 JSON)

function safeParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function personaFromEnv() {
  // Prefer Base64 if set
  let raw;
  if (process.env.DPA_PERSONA_JSON_B64) {
    try {
      raw = Buffer.from(process.env.DPA_PERSONA_JSON_B64, "base64").toString("utf8");
    } catch (err) {
      console.error("⚠️ Failed to decode Base64 persona JSON:", err);
    }
  } else if (process.env.DPA_PERSONA_JSON) {
    raw = process.env.DPA_PERSONA_JSON;
  }

  const cfg = raw ? safeParseJSON(raw) : null;

  const name  = cfg?.name  ?? "Assistant";
  const role  = cfg?.role  ?? "Helpful real-time voice assistant";
  const tone  = cfg?.tone  ?? "Friendly and concise";
  const style = cfg?.style ?? "Neutral";
  const behavior = Array.isArray(cfg?.behavior)
    ? cfg.behavior.map(s => `- ${s}`).join("\n")
    : "- Be brief but clear.\n- Wait for the caller to finish speaking.\n- Ask short clarifying questions when needed.";

  const instructions = `Name: ${name}
Role: ${role}
Tone: ${tone}
Style: ${style}
Behavior:
${behavior}`;

  return {
    instructions,
    voice: process.env.DPA_VOICE || "shimmer",
    asrModel: process.env.DPA_ASR_MODEL || "gpt-4o-mini-transcribe",
    ttsModel: process.env.DPA_TTS_MODEL || "gpt-4o-realtime-preview-2024-12-17",
  };
}

module.exports = { personaFromEnv };
