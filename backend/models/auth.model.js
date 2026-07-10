// Account store — env-driven, no hardcoded accounts. All accounts come from the
// environment; nothing is baked into source. Required env vars:
//   LUMINA_MANAGEMENT  JSON: [{ "username", "password", "displayName" }]
//   LUMINA_RESIDENTS   JSON: [{ "email", "unit", "name", "residentType", "ghl_contact_id" }]
//   LUMINA_GUARDHOUSE  JSON: [{ "username", "password", "displayName" }]

const bcrypt = require('bcryptjs');

const clean         = (v) => String(v || '').trim();
const normalizeUnit = (u) => clean(u).replace(/^#/, '').toUpperCase();

const isBcryptHash = (s) => /^\$2[aby]\$\d{2}\$/.test(String(s || ''));

// bcrypt hashes are verified in constant time; plaintext is still accepted for
// transition, but the boot guard below blocks the old defaults.
function passwordMatches(stored, provided) {
  const s = String(stored || '');
  const p = clean(provided);
  if (isBcryptHash(s)) {
    try { return bcrypt.compareSync(p, s); } catch { return false; }
  }
  return s === p;
}

// Parse an account list from env. No built-in fallback — an unset/invalid var
// yields an empty list (that role simply has no accounts until configured).
function load(key) {
  const raw = process.env[key];
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    console.warn(`[auth] ${key} is not valid JSON — ignoring (no accounts loaded for it).`);
    return [];
  }
}

const MANAGEMENT = load('LUMINA_MANAGEMENT');
const RESIDENTS  = load('LUMINA_RESIDENTS');
const GUARDHOUSE = load('LUMINA_GUARDHOUSE');

// Refuse to run with the old shipped defaults or obvious placeholder passwords —
// these were public in source, so any deployment still using them is compromised.
const BANNED_PASSWORDS = new Set([
  'admin123', 'guard123', 'replace-me', 'replace-with-a-long-random-secret',
  'password', 'changeme', 'admin', 'guardhouse', 'management', '123456',
]);

function assertNoDefaultCreds(list, key) {
  for (const a of (list || [])) {
    const pw = clean(a && a.password);
    // Hashed passwords can't be inspected for banned values — and don't need to be.
    if (isBcryptHash(pw)) continue;
    if (!pw || BANNED_PASSWORDS.has(pw.toLowerCase())) {
      console.error(
        `\n[FATAL] ${key} uses a missing, default, or placeholder password for ` +
        `"${clean(a && a.username) || '(no username)'}".\n` +
        '        Set a real password in the environment — the server will not start otherwise.\n'
      );
      process.exit(1);
    }
  }
}
assertNoDefaultCreds(MANAGEMENT, 'LUMINA_MANAGEMENT');
assertNoDefaultCreds(GUARDHOUSE, 'LUMINA_GUARDHOUSE');
if (!MANAGEMENT.length) {
  console.warn('[auth] LUMINA_MANAGEMENT is empty — no management account can sign in until it is set.');
}

// Anti-enumeration: always perform exactly one password comparison, even when the
// username is unknown (against a dummy hash), so response timing doesn't reveal
// whether a username exists. Login error messages are already uniform.
const DUMMY_HASH = bcrypt.hashSync('lumina-nonexistent-account-baseline', 12);

function authenticate(list, username, password) {
  const u = clean(username).toLowerCase();
  const account = list.find(a => clean(a.username).toLowerCase() === u) || null;
  const matched = passwordMatches(account ? account.password : DUMMY_HASH, password);
  return account && matched ? account : null;
}

const findManagement = (username, password) => authenticate(MANAGEMENT, username, password);
const findGuardhouse = (username, password) => authenticate(GUARDHOUSE, username, password);

module.exports = {
  findManagement, findGuardhouse, normalizeUnit, clean, RESIDENTS,
  passwordMatches, isBcryptHash, DUMMY_HASH,
};
