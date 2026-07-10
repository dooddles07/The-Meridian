// Redacts PII and secrets from all console output. Patches console once so every
// log call is covered without touching each call site. Emails keep their domain
// (useful for debugging); JWTs and Bearer tokens are stripped entirely.
// Must be required first in server.js, before anything else logs.

const EMAIL  = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const JWT    = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const BEARER = /Bearer\s+[A-Za-z0-9._-]+/gi;

function scrub(v) {
  if (typeof v !== 'string') return v;
  return v
    .replace(JWT, '[redacted-token]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(EMAIL, '$1***$2');
}

['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
  const orig = console[level].bind(console);
  console[level] = (...args) => orig(...args.map(scrub));
});

module.exports = {};
