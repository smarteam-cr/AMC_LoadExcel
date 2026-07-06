'use strict';

/**
 * Logger mínimo basado en console, con timestamp y nivel.
 * Suficiente para este proyecto; fácil de reemplazar por pino/winston si crece.
 */
function format(level, args) {
  const timestamp = new Date().toISOString();
  return [`[${timestamp}] [${level}]`, ...args];
}

const logger = {
  info: (...args) => console.log(...format('INFO', args)),
  warn: (...args) => console.warn(...format('WARN', args)),
  error: (...args) => console.error(...format('ERROR', args)),
  debug: (...args) => {
    if (process.env.DEBUG === 'true') {
      console.debug(...format('DEBUG', args));
    }
  },
};

module.exports = logger;
