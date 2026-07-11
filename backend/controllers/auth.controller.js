const model     = require('../models/auth.model');
const residents = require('../services/residents.service');
const email     = require('../services/email.service');
const { signToken, SESSION_COOKIE, COOKIE_OPTIONS } = require('../config/secrets');

const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'http://localhost:3000';

// The token is still returned in the JSON body too (so the API stays directly
// callable/testable without a browser), but the browser itself authenticates via
// the httpOnly cookie set here, not by reading/storing this value.
function issueToken(res, role, account) {
  const displayName = account.displayName || role;
  const username    = model.clean(account.username).toLowerCase();
  const token       = signToken({ role, username, displayName });
  res.cookie(SESSION_COOKIE, token, COOKIE_OPTIONS);
  return res.json({ success: true, token, user: { username, role, displayName } });
}

// Shared shape for both signup and login — one code path on the frontend for either.
function issueResidentSession(res, account) {
  const name       = account.name || account.email;
  const initials   = name.split(/\s+/).map(p => p[0] || '').join('').slice(0, 2).toUpperCase() || 'R';
  const cleanEmail = model.clean(account.email).toLowerCase();
  const normUnit   = model.normalizeUnit(account.unit);
  const token      = signToken({ role: 'resident', contact_id: account.contact_id || '', email: cleanEmail, unit: normUnit, name });
  res.cookie(SESSION_COOKIE, token, COOKIE_OPTIONS);

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

// POST /api/auth/logout — clears the session cookie server-side. Required because
// an httpOnly cookie can't be cleared by client-side JS (document.cookie can't
// touch it), unlike the old localStorage-token approach.
// maxAge is dropped: passing it through would override clearCookie's own forced
// past-dated expiry, so the browser would keep the cookie for its original 8h
// lifetime instead of deleting it immediately.
const { maxAge: _unused, ...CLEAR_COOKIE_OPTIONS } = COOKIE_OPTIONS;
function logout(req, res) {
  res.clearCookie(SESSION_COOKIE, CLEAR_COOKIE_OPTIONS);
  return res.json({ success: true });
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

  account.contact_id = String(account._id);
  return issueResidentSession(res, account);
}

async function residentLogin(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required.' });

  const account = await residents.findByEmail(email);
  // Anti-enumeration: always perform one bcrypt compare, even for an unknown email.
  const matched = model.passwordMatches(account ? account.password : model.DUMMY_HASH, password);
  if (!account || !matched) return res.status(401).json({ success: false, message: 'Invalid email or password.' });

  account.contact_id = String(account._id);
  return issueResidentSession(res, account);
}

// POST /api/auth/resident/request-reset — always responds identically whether
// or not the email matches an account, so this endpoint can't be used to test
// which emails are registered (same anti-enumeration principle as login).
async function requestPasswordReset(req, res) {
  const { email: rawEmail } = req.body || {};
  const GENERIC_MESSAGE = 'If an account exists for that email, a reset link has been sent.';
  if (!rawEmail) return res.status(400).json({ success: false, message: 'Email is required.' });

  const result = await residents.setResetToken(rawEmail);
  if (result) {
    const resetUrl = `${PUBLIC_APP_URL}/portal.html?resetToken=${result.rawToken}`;
    email.sendPasswordResetEmail({ to: result.account.email, name: result.account.name, resetUrl }).catch(() => {});
  }
  return res.json({ success: true, message: GENERIC_MESSAGE });
}

// POST /api/auth/resident/reset-password — the token itself is the secret here
// (only ever known to whoever clicked the emailed link), so confirming it's
// invalid/expired doesn't leak account existence the way a login error would.
async function resetPassword(req, res) {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ success: false, message: 'Token and new password are required.' });
  if (password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });

  const residentDoc = await residents.verifyResetToken(token);
  if (!residentDoc) {
    return res.status(400).json({ success: false, message: 'This reset link is invalid or has expired. Please request a new one.' });
  }
  const account = await residents.resetPasswordByToken(residentDoc, password);
  account.contact_id = String(account._id);
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

module.exports = { residentSignup, residentLogin, requestPasswordReset, resetPassword, managementLogin, guardhouseLogin, logout };
