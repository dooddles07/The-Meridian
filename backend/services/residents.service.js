const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const Resident = require('../models/resident.model');
const { RESIDENTS, normalizeUnit, clean } = require('../models/auth.model');

const dbReady    = () => mongoose.connection.readyState === 1;

// Idempotent upsert by email — safe to reseed without duplicating accounts.
async function seed() {
  if (!dbReady()) return;
  try {
    for (const r of RESIDENTS) {
      const email = clean(r.email).toLowerCase();
      if (!email) continue;
      await Resident.updateOne(
        { email },
        { $setOnInsert: { email },
          $set: { unit: r.unit || '', name: r.name || '', residentType: r.residentType || 'Resident', active: true } },
        { upsert: true }
      );
    }
    console.log(`[residents] seeded ${RESIDENTS.length} account(s) to database`);
  } catch (e) {
    console.warn('[residents] seed failed:', e.message);
  }
}

// Look up a self-service resident account by email. Password auth requires the
// DB (a bcrypt hash can't live safely in the env-JSON fallback list), so this
// does not fall back to RESIDENTS the way the old lookup + listResidents() do.
async function findByEmail(email) {
  if (!dbReady()) return null;
  const e = clean(email).toLowerCase();
  try {
    return await Resident.findOne({ email: e, active: true }).lean();
  } catch (_) {
    return null;
  }
}

// Self-service signup. Requires the DB — throws a plain Error the controller
// turns into a 503 rather than pretending to succeed with nowhere to persist to.
async function createResident({ name, email, unit, password, residentType }) {
  if (!dbReady()) {
    const e = new Error('Database unavailable — cannot create an account right now.');
    e.status = 503;
    throw e;
  }
  const cleanEmail = clean(email).toLowerCase();
  const hash = await bcrypt.hash(clean(password), 12);
  try {
    const doc = await Resident.create({
      email: cleanEmail,
      password: hash,
      unit: normalizeUnit(unit),
      name: clean(name),
      residentType: residentType === 'Tenant' ? 'Tenant' : 'Owner',
      active: true,
    });
    return doc.toObject();
  } catch (err) {
    if (err && err.code === 11000) {
      const e = new Error('An account with this email already exists.');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

// Fixed account behind the zero-click portfolio preview (see client-backend.js's
// seedSession). Its email is namespaced so it can never collide with a real
// visitor's signup, and the password is not a secret worth protecting — it's a
// public preview persona with no sensitive data behind it. Idempotent: only
// creates the account once, so it survives redeploys without duplicating.
const PREVIEW_EMAIL    = 'alex.tan@preview.thelumina.app';
const PREVIEW_PASSWORD = 'LuminaPreview2026!';
async function seedPreviewAccount() {
  if (!dbReady()) return;
  try {
    const existing = await Resident.findOne({ email: PREVIEW_EMAIL });
    if (existing) return;
    const hash = await bcrypt.hash(PREVIEW_PASSWORD, 12);
    await Resident.create({
      email: PREVIEW_EMAIL, password: hash, unit: '12-09', name: 'Alex Tan',
      residentType: 'Owner', active: true,
    });
    console.log('[residents] seeded the zero-click preview account');
  } catch (e) {
    console.warn('[residents] seedPreviewAccount failed:', e.message);
  }
}

// List all resident accounts (DB if available, else the configured seed list).
async function listResidents() {
  if (dbReady()) {
    try {
      const rows = await Resident.find({ active: true }).sort({ unit: 1 }).lean();
      if (rows && rows.length) return rows;
    } catch (_) { /* fall through to seed */ }
  }
  return RESIDENTS;
}

module.exports = {
  seed, seedPreviewAccount, findByEmail, createResident, listResidents, dbReady,
};
