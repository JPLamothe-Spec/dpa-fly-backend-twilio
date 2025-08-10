// dpa.js — Direct Phone Assistant logic (CommonJS)
// Goals: low-latency, no meta-commentary, anti-spiral, minimal deps.

const crypto = require("crypto");

// --- helpers ---------------------------------------------------------------
const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const hash = (s) => crypto.createHash("sha1").update(s || "").digest("hex");

const isFiller = (n) =>
  !n ||
  n.length <= 2 ||
  /^(you|ya|uh|um|mm+|ah+|hmm+|yeah|yep|ok|okay|right|huh)$/.test(n);

// --- DPA engine ------------------------------------------------------------
class DPAEngine {
  constructor() {
    this.state = {
      greeted: false,
      lastReplyHash: null,
      lastSpokeAt: 0,
      lastHeardCheckAt: 0,
      lastIntent: null,
    };

    // configurable guardrails
    this.cooldowns = {
      repeatReplyMs: 8000,   // avoid sending the same TTS twice within 8s
      heardCheckMs: 8000,    // don't confirm "can you hear me" too often
    };
  }

  analyze(text) {
    const now = Date.now();
    const n = normalize(text);

    // 1) ignore silence/filler to keep latency & chatter down
    if (isFiller(n)) return this.noop("filler_or_silence");

    // 2) “Can you hear me?” / audibility checks
    if (
      /(can|could)\s+(you|ya)\s+hear\s+(me|us)/.test(n) ||
      /(any(one|body))\s+hear\s+(me|us)/.test(n) ||
      /\b(am\s*i|are\s*you)\s+(audible|hearing|heard)\b/.test(n)
    ) {
      if (now - this.state.lastHeardCheckAt < this.cooldowns.heardCheckMs) {
        return this.noop("debounced_heard_check");
      }
      this.state.lastHeardCheckAt = now;
      return this.reply(
        "Yes, I can hear you clearly. This is Anna. How can I help?",
        "check_audio",
        "low",
        { ack: true }
      );
    }

    // 3) greeting
    if (
      /\b(hello|hi|hey|good\s*(morning|afternoon|evening))\b/.test(n)
    ) {
      if (this.state.greeted) return this.noop("already_greeted");
      this.state.greeted = true;
      return this.reply(
        "Hi! This is Anna. I can hear you. What would you like to do?",
        "greet",
        "low",
        {}
      );
    }

    // 4) goodbye / thanks
    if (/\b(bye|goodbye|see\s*you|talk\s*to\s*you\s*later)\b/.test(n)) {
      return this.reply(
        "Thanks for calling. I’ll hang up now. Bye!",
        "goodbye",
        "low",
        { end: true }
      );
    }
    if (/\b(thanks|thank you|appreciate it)\b/.test(n)) {
      return this.reply(
        "You’re welcome. Is there anything else you need?",
        "ack_thanks",
        "low",
        {}
      );
    }

    // 5) who/what can you do
    if (
      /\b(who are you|what can you do|help me|assist|what do you do)\b/.test(n)
    ) {
      return this.reply(
        "I’m Anna. I can take a message, schedule a call, or answer simple questions. What would you like to do?",
        "introduce",
        "low",
        {}
      );
    }

    // 6) short/unclear input => quick clarify, no narration
    if (n.length < 6) return this.noop("very_short");

    // 7) default: concise clarify (prevents meta rambling)
    return this.reply("Okay. How can I help?", "clarify", "med", {});
  }

  reply(text, intent, urgency, entities) {
    const now = Date.now();
    const h = hash(text);

    // anti-spiral: block identical replies within cooldown window
    if (
      this.state.lastReplyHash === h &&
      now - this.state.lastSpokeAt < this.cooldowns.repeatReplyMs
    ) {
      return this.noop("dedup_same_reply_cooldown");
    }

    this.state.lastReplyHash = h;
    this.state.lastSpokeAt = now;
    this.state.lastIntent = intent;

    return {
      assistant_reply: text,
      intent,
      entities: entities || {},
      urgency: urgency || "low",
    };
  }

  noop(reason) {
    return {
      assistant_reply: null, // null => do NOT speak
      intent: "noop",
      urgency: "low",
      entities: { reason },
    };
  }
}

// singleton for simple usage
const engine = new DPAEngine();

// Public API
function analyze(transcript) {
  return engine.analyze(transcript);
}

module.exports = { analyze, DPAEngine };
