// persona.js — load persona from env (JSON or Base64 JSON) with safe fallbacks

function safeParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function decodeBase64Safe(b64) {
  try {
    // strip whitespace/newlines that sometimes sneak into envs
    const cleaned = (b64 || "").replace(/\s+/g, "");
    return Buffer.from(cleaned, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function softTrim(str, max = 4096) {
  const s = (str || "").replace(/^\uFEFF/, "").trim(); // strip BOM & trim
  return s.length > max ? s.slice(0, max) : s;
}

function personaFromEnv() {
  // 1) Load structured JSON (Base64 has priority)
  let raw = null;
  if (process.env.DPA_PERSONA_JSON_B64) {
    raw = decodeBase64Safe(process.env.DPA_PERSONA_JSON_B64);
    if (!raw) console.error("⚠️ Failed to decode DPA_PERSONA_JSON_B64");
  }
  if (!raw && process.env.DPA_PERSONA_JSON) {
    raw = process.env.DPA_PERSONA_JSON;
  }

  const cfg = raw ? safeParseJSON(raw) : null;

  // 2) Pull fields from JSON first, then allow simple env overrides
  const name      = process.env.DPA_NAME      ?? cfg?.name  ?? "Assistant";
  const role      = process.env.DPA_ROLE      ?? cfg?.role  ?? "Helpful real-time voice assistant";
  const tone      = process.env.DPA_TONE      ?? cfg?.tone  ?? "friendly, concise, helpful";
  const style     = process.env.DPA_STYLE     ?? cfg?.style ?? "neutral";
  const language  = process.env.DPA_LANGUAGE  ?? cfg?.language ?? "en-AU";

  // Behavior list (array or string)
  let behaviorLines = [];
  if (Array.isArray(cfg?.behavior)) {
    behaviorLines = cfg.behavior;
  } else if (typeof cfg?.behavior === "string" && cfg.behavior.trim()) {
    behaviorLines = cfg.behavior.split("\n").map(s => s.trim()).filter(Boolean);
  } else {
    behaviorLines = [
      "Be brief but clear.",
      "Wait for the caller to finish speaking.",
      "Ask short clarifying questions when needed.",
      "Avoid interrupting; let short pauses happen.",
    ];
  }
  // Env append (optional): DPA_BEHAVIOR_APPEND = "Extra rule 1|Extra rule 2"
  if (process.env.DPA_BEHAVIOR_APPEND) {
    behaviorLines = behaviorLines.concat(
      process.env.DPA_BEHAVIOR_APPEND.split("|").map(s => s.trim()).filter(Boolean)
    );
  }

  // 3) Build instructions and soft-cap length
  const instructions = softTrim(
    [
      `Name: ${name}`,
      `Role: ${role}`,
      `Language: ${language}`,
      `Tone: ${tone}`,
      `Style: ${style}`,
      "Behavior:",
      ...behaviorLines.map(s => `- ${s}`)
    ].join("\n")
  );

  // 4) Voice / Models
  const voice    = process.env.DPA_VOICE    ?? cfg?.voice    ?? "shimmer";
  const asrModel = process.env.DPA_ASR_MODEL ?? cfg?.asrModel ?? "gpt-4o-mini-transcribe";
  const ttsModel = process.env.DPA_TTS_MODEL ?? cfg?.ttsModel ?? "gpt-4o-realtime-preview-2024-12-17";

  // 5) Log a safe summary (no secrets)
  console.log("🧠 Persona resolved:", {
    name, voice, asrModel, ttsModel, language,
    instructions_len: instructions.length
  });

  return { instructions, voice, asrModel, ttsModel, language };
}

module.exports = { personaFromEnv };
