// src/utils/logger.js
const ts = () => new Date().toISOString();

const safe = (v) => {
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  if (typeof v === 'object' && v !== null) {
    try {
      const seen = new WeakSet();
      return JSON.stringify(v, (k, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      });
    } catch { /* fall through */ }
  }
  return String(v);
};

const line = (level, args) => `[${ts()}] ${level} ${args.map(safe).join(' ')}`;

export const log = {
  info:  (...a) => console.log(line('INFO ', a)),
  warn:  (...a) => console.warn(line('WARN ', a)),
  error: (...a) => console.error(line('ERROR', a)),
  debug: (...a) => {
    if (String(process.env.DEBUG || '').toLowerCase() === 'true') {
      console.log(line('DEBUG', a));
    }
  },
};
