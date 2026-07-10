const model     = require('../models/auth.model');
const residents = require('../services/residents.service');
const { signToken } = require('../config/secrets');

function issueToken(res, role, account) {
  const displayName = account.displayName || role;
  const username    = model.clean(account.username).toLowerCase();
  const token       = signToken({ role, username, displayName });
  return res.json({ success: true, token, user: { username, role, displayName } });
}

// Shared shape for both signup and login — one code path on the frontend for either.
function issueResidentSession(res, account) {
  const name       = account.name || account.email;
  const initials   = name.split(/\s+/).map(p => p[0] || '').join('').slice(0, 2).toUpperCase() || 'R';
  const cleanEmail = model.clean(account.email).toLowerCase();
  const normUnit   = model.normalizeUnit(account.unit);
  const token      = signToken({ role: 'resident', contact_id: account.contact_id || '', email: cleanEmail, unit: normUnit, name });

  return res.json({
    success: true,
    token,
    member: {
      name, initials,
      email: cleanEmail,
      unit:  normUnit,
      type:  account.residentType || 'Resident',
      contact_id: account.contact_id || '',
    },
  });
}

async function residentSignup(req, res) {
  const { name, email, unit, password } = req.body || {};
  if (!name || !email || !unit || !password) {
    return res.status(400).json({ success: false, message: 'Name, unit number, email and password are required.' });
  }

  const existing = await residents.findByEmail(email);
  if (existing) return res.status(409).json({ success: false, message: 'An account with this email already exists. Try signing in instead.' });

  let account;
  try {
    account = await residents.createResident({ name, email, unit, password });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Unable to create account.' });
  }

  // Create-or-update the GHL contact by email and persist its id, same as login.
  account.contact_id = await residents.ensureContact(account);
  return issueResidentSession(res, account);
}

async function residentLogin(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required.' });

  const account = await residents.findByEmail(email);
  // Anti-enumeration: always perform one bcrypt compare, even for an unknown email.
  const matched = model.passwordMatches(account ? account.password : model.DUMMY_HASH, password);
  if (!account || !matched) return res.status(401).json({ success: false, message: 'Invalid email or password.' });

  // Create-or-update the GHL contact by email and persist its id. Self-healing —
  // a deleted/recreated contact is restored here on next login.
  account.contact_id = await residents.ensureContact(account);
  return issueResidentSession(res, account);
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
