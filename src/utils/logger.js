// src/utils/logger.js
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// Resolve level from env: LOG_LEVEL (error|warn|info|debug) or legacy DEBUG=true => debug
function resolveLevel() {
  const lvl = String(process.env.LOG_LEVEL || '').toLowerCase();
  if (lvl in LEVELS) return lvl;
  const legacyDebug = String(process.env.DEBUG || '').toLowerCase() === 'true';
  return legacyDebug ? 'debug' : 'info';
}

let CURRENT_LEVEL = resolveLevel();

function ts() {
  return new Date().toISOString();
}

// Redact simple secrets/tokens from strings
function redact(value) {
  if (typeof value !== 'string') return value;
  // Basic patterns; keep conservative to avoid over-redaction
  const patterns = [
    /(sk-[a-zA-Z0-9]{20,})/g,                 // OpenAI-style keys
    /(Bearer\s+[a-zA-Z0-9\-\._~\+\/]+=*)/gi,  // Bearer tokens
    /(api[_-]?key\s*[:=]\s*)([^\s"'“”]+)/gi,  // apiKey: xxx
    /(token\s*[:=]\s*)([^\s"'“”]+)/gi,        // token: xxx
  ];
  let out = value;
  for (const re of patterns) out = out.replace(re, (_, p1, p2) => (p2 ? `${p1}[REDACTED]` : '[REDACTED]'));
  return out;
}

// Safe stringify that handles Errors and circulars
function safeFormat(arg) {
  if (arg instanceof Error) {
    return {
      name: arg.name,
      message: arg.message,
      stack: arg.stack,
    };
  }
  if (typeof arg === 'string') return redact(arg);
  try {
    return JSON.parse(JSON.stringify(arg, (_k, v) => (typeof v === 'string' ? redact(v) : v)));
  } catch {
    // Last resort: toString
    try { return String(arg); } catch { return '[Unprintable]'; }
  }
}

function emit(level, args) {
  if (LEVELS[level] > LEVELS[CURRENT_LEVEL]) return;
  const pieces = args.map(safeFormat);
  const line = `[${ts()}] ${level.toUpperCase()}:`;
  // Use console method matching level for correct streams
  const fn = level === 'error' ? console.error
          : level === 'warn'  ? console.warn
          : console.log;
  fn(line, ...pieces);
}

export const log = {
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
  debug: (...a) => emit('debug', a),
  // Allow runtime change without restart (optional)
  setLevel: (lvl) => {
    const next = String(lvl || '').toLowerCase();
    if (next in LEVELS) CURRENT_LEVEL = next;
  }
};
