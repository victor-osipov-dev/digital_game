'use strict';

const { config } = require('./config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, msg) {
  if ((LEVELS[level] ?? 2) > threshold) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  error: (m) => emit('error', m),
  warn: (m) => emit('warn', m),
  info: (m) => emit('info', m),
  debug: (m) => emit('debug', m),
};
