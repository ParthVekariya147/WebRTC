// Centralised logger — silences output in tests, controlled by VITE_LOG_LEVEL in production.
// Levels: debug < info < warn < error < silent
// Default: 'warn' in dev/prod, 'error' in vitest (import.meta.env.MODE === 'test').
// To see all output locally: VITE_LOG_LEVEL=debug npm run dev

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

const raw = import.meta.env?.VITE_LOG_LEVEL
    ?? (import.meta.env?.MODE === 'test' ? 'error' : 'warn');
const threshold = LEVELS[raw] ?? LEVELS.warn;

export const log = {
    debug: (...a) => threshold <= 0 && console.debug('[p2p:dbg]', ...a),
    info:  (...a) => threshold <= 1 && console.log  ('[p2p]    ', ...a),
    warn:  (...a) => threshold <= 2 && console.warn ('[p2p:wrn]', ...a),
    error: (...a) => threshold <= 3 && console.error('[p2p:err]', ...a),
};
