// src/utils/logger.js
export const log = {
  info: (...a) => console.log(...a),
  error: (...a) => console.error(...a),
  debug: (...a) => {
    if (String(process.env.DEBUG || '').toLowerCase() === 'true') console.log(...a);
  }
};
