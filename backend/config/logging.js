// config/logging.js
// Redacts PII and secrets from ALL console output (M-04). Patching console once here
// covers every existing log call across the app without editing each one. Emails are
// partially masked (domain kept for debugging); JWTs and Bearer tokens are removed.
// Require this first in server.js, before anything that logs.

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
