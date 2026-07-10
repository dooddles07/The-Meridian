// Single, validated source for security-critical secrets. Loaded at boot via the
// auth modules; if a required secret is missing or weak, the process refuses to
// start rather than silently falling back to a known/insecure default.

const MIN_JWT_LEN = 32;

const JWT_SECRET = process.env.JWT_SECRET || '';

// Fail fast. A missing/short secret — or the old hardcoded dev value — means tokens
// could be forged, so we must not boot. Exit with a clear, actionable message.
if (JWT_SECRET.length < MIN_JWT_LEN || JWT_SECRET === 'meridian-dev-secret') {
  console.error(
    '\n[FATAL] JWT_SECRET is missing, too short, or using the insecure default.\n' +
    `        Set JWT_SECRET to a random string of at least ${MIN_JWT_LEN} characters.\n` +
    '        Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"\n' +
    '        The server will not start until this is fixed.\n'
  );
  process.exit(1);
}

// Signs/verifies in one place so options never drift. Every token is bound to this
// issuer + audience and carries a version claim; bumping MERIDIAN_TOKEN_VERSION
// instantly invalidates all existing tokens (a global revocation / logout lever).
const jwt = require('jsonwebtoken');

const JWT_ISSUER    = 'meridian-portal';
const JWT_AUDIENCE  = 'meridian-app';
const TOKEN_VERSION = Number(process.env.MERIDIAN_TOKEN_VERSION || 1);
const TOKEN_TTL     = process.env.MERIDIAN_TOKEN_TTL || '8h';

function signToken(payload) {
  return jwt.sign(
    { ...payload, ver: TOKEN_VERSION },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL, issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
  );
}

// Throws on any mismatch — callers already treat a throw as "session invalid → 401".
function verifyToken(token) {
  const payload = jwt.verify(token, JWT_SECRET, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
  if (Number(payload.ver) !== TOKEN_VERSION) {
    const e = new Error('Token version no longer valid'); e.name = 'TokenVersionError'; throw e;
  }
  return payload;
}

module.exports = { JWT_SECRET, signToken, verifyToken, TOKEN_VERSION };
