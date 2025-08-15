// dpa.js — Direct Phone Assistant logic (CommonJS)
// Goals: low-latency, natural vibe, no canned greeting, anti-spiral, minimal deps.

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
  /^(ya|uh|um|mm+|ah+|hmm+|yeah|yep|ok|okay|right|huh)$/i.test(n);

// Small variety to avoid repetition without sounding weird
const nudgePhrases = [
  "Got it.",
  "Okay.",
  "Alright.",
];

// --- DPA engine ------------------------------------------------------------
class DPAEngine {
  constructor(opts = {}) {
    this.cfg = {
      greetingEnabled: false,        // <- no standard greeting for now
      personaName: opts.personaName || "Anna",
    };

    this.state = {
      greeted: false,
      lastReplyHash: null,
      lastSpokeAt: 0,
      lastHeardCheckAt: 0,
      lastIntent: null,
      nudgeIx: 0,
    };

    this.cooldowns = {
      repeatReplyMs: 8000,   // avoid saying the exact same thing inside 8s
      heardCheckMs: 8000,    // rate-limit "can you hear me" acknowledgements
    };
  }

  analyze(text) {
    const now = Date.now();
    const n = normalize(text);

    // 1) ignore silence/filler to keep it natural
    if (isFiller(n)) return this.noop("filler_or_silence");

    // 2) “can you hear me?” checks (short + neutral)
    if (
      /(can|could)\s+(you|ya)\s+hear\s+(me|us)/.test(n) ||
      /(any(one|body))\s+hear\s+(me|us)/.test(n) ||
      /\b(am\s*i|are\s*you)\s+(audible|hearing|heard)\b/.test(n)
    ) {
      if (now - this.state.lastHeardCheckAt < this.cooldowns.heardCheckMs) {
        return this.noop("debounced_heard_check");
      }
      this.state.lastHeardCheckAt = now;
      return this.reply("Yep, I can hear you.", "check_audio", "low", { ack: true });
    }

    // 3) greeting — disabled unless explicitly enabled
    if (this.cfg.greetingEnabled) {
      if (/\b(hello|hi|hey|good\s*(morning|afternoon|evening))\b/.test(n)) {
        if (this.state.greeted) return this.noop("already_greeted");
        this.state.greeted = true;
        return this.reply("Hi.", "greet", "low", {});
      }
    }

    // 4) goodbye / thanks
    if (/\b(bye|goodbye|see\s*you|talk\s*to\s*you\s*later)\b/.test(n)) {
      return this.reply("Thanks for calling. I’ll hang up now. Bye.", "goodbye", "low", { end: true });
    }
    if (/\b(thanks|thank you|appreciate it)\b/.test(n)) {
      return this.reply("You’re welcome. Anything else?", "ack_thanks", "low", {});
    }

    // 5) who/what can you do — keep it concise, no “how can I help”
    if (/\b(who are you|what can you do|what do you do)\b/.test(n)) {
      return this.reply(
        "I can take a message, schedule a call, or answer simple questions.",
        "introduce",
        "low",
        {}
      );
    }

    // 6) very short/unclear -> give a tiny nudge, not a question loop
    if (n.length < 6) {
      return this.reply(this.nextNudge(), "nudge", "low", { reason: "very_short" });
    }

    // 7) default: acknowledge without the generic helper prompt
    return this.reply(this.nextNudge(), "ack", "low", {});
  }

  nextNudge() {
    const s = nudgePhrases[this.state.nudgeIx % nudgePhrases.length];
    this.state.nudgeIx++;
    return s;
  }

  reply(text, intent, urgency, entities) {
    const now = Date.now();
    const h = hash(text);

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
      assistant_reply: text,          // non-null => TTS it
      intent,
      entities: entities || {},
      urgency: urgency || "low",
    };
  }

  noop(reason) {
    return {
      assistant_reply: null,          // null => do NOT speak
      intent: "noop",
      urgency: "low",
      entities: { reason },
    };
  }
}

// singleton + public API
const engine = new DPAEngine();

function analyze(transcript) {
  return engine.analyze(transcript);
}

module.exports = { analyze, DPAEngine };
