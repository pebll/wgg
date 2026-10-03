const RESET = '\u001b[0m';
const LEVELS = {
  debug: { label: 'DEBUG', colour: '\u001b[36m' },
  info: { label: 'INFO', colour: '\u001b[32m' },
  warn: { label: 'WARN', colour: '\u001b[33m' },
  error: { label: 'ERROR', colour: '\u001b[31m' },
};

// Both values are fixed at load time on purpose: they never change during a run.
const useColour = Boolean(process.stdout.isTTY || process.stderr.isTTY);
const debugEnabled = (process.env.NODE_ENV ?? 'development') === 'development';

const pad = (n) => String(n).padStart(2, '0');

function timestamp() {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${date} ${time}`;
}

function makeWriter(level) {
  const { label, colour } = LEVELS[level];
  return (...args) => {
    if (level === 'debug' && !debugEnabled) return;
    const tag = useColour ? `${colour}${label}${RESET}` : label;
    /* oxlint-disable no-console */
    console[level](`[${timestamp()}] ${tag}:`, ...args);
    /* oxlint-enable no-console */
  };
}

export default {
  debug: makeWriter('debug'),
  info: makeWriter('info'),
  warn: makeWriter('warn'),
  error: makeWriter('error'),
};
