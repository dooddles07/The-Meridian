const model     = require('../models/auth.model');
const residents = require('../services/residents.service');
const { signToken } = require('../config/secrets');

function issueToken(res, role, account) {
  const displayName = account.displayName || role;
  const username    = model.clean(account.username).toLowerCase();
  const token       = signToken({ role, username, displayName });
  return res.json({ success: true, token, user: { username, role, displayName } });
}

async function residentLogin(req, res) {
  const { email, unit } = req.body || {};
  if (!email || !unit) return res.status(400).json({ success: false, message: 'Email and unit number are required.' });

  // DB-backed account lookup (falls back to the env list if the DB is down).
  const account = await residents.findResident(email, unit);
  if (!account) return res.status(401).json({ success: false, message: 'Details not found. Please check your unit number and email address.' });

  const name      = account.name || account.email;
  const initials  = name.split(/\s+/).map(p => p[0] || '').join('').slice(0, 2).toUpperCase() || 'R';
  const cleanEmail = model.clean(account.email);
  const normUnit   = model.normalizeUnit(account.unit);

  // Auto-render the account into GHL: create-or-update the contact by email,
  // sync name + unit, and persist the resulting contact ID. Self-healing —
  // a deleted/recreated contact is recreated here on next login.
  const contact_id = await residents.ensureContact(account);

  // Issue a signed session token. Every resident API call must present this; the
  // backend trusts the identity baked into it, never identifiers from the request.
  const token = signToken({ role: 'resident', contact_id: contact_id || '', email: cleanEmail.toLowerCase(), unit: normUnit, name });

  return res.json({
    success: true,
    token,
    member: {
      name, initials,
      email: cleanEmail,
      unit:  normUnit,
      type:  account.residentType || 'Resident',
      contact_id,
    },
  });
}

function managementLogin(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password are required.' });
  const account = model.findManagement(username, password);
  if (!account) return res.status(401).json({ success: false, message: 'Invalid username or password.' });
  return issueToken(res, 'management', account);
}

function guardhouseLogin(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password are required.' });
  const account = model.findGuardhouse(username, password);
  if (!account) return res.status(401).json({ success: false, message: 'Invalid username or password.' });
  return issueToken(res, 'guardhouse', account);
}

module.exports = { residentLogin, managementLogin, guardhouseLogin };
