const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const ghl      = require('./ghl.service');
const Resident = require('../models/resident.model');
const { RESIDENTS, normalizeUnit, clean } = require('../models/auth.model');

const UNIT_FIELD = 'local-field-unit';
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
          $set: { unit: r.unit || '', name: r.name || '', residentType: r.residentType || 'Resident', ghl_contact_id: r.ghl_contact_id || '', active: true } },
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
async function createResident({ name, email, unit, password }) {
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
      residentType: 'Resident',
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

// Creates/updates the GHL contact for this account and persists the id back to the DB.
async function ensureContact(account) {
  if (!account || !account.email || !ghl.isConfigured()) return account?.ghl_contact_id || '';
  const parts = clean(account.name).split(/\s+/).filter(Boolean);
  try {
    const c = await ghl.upsertContact({
      email:     clean(account.email),
      firstName: parts[0] || clean(account.email),
      lastName:  parts.slice(1).join(' '),
      customFields: account.unit ? [{ id: UNIT_FIELD, field_value: normalizeUnit(account.unit) }] : [],
    });
    const id = c && c.id;
    if (id && dbReady()) {
      Resident.updateOne({ email: clean(account.email).toLowerCase() }, { $set: { ghl_contact_id: id } }).catch(() => {});
    }
    return id || account.ghl_contact_id || '';
  } catch (e) {
    console.warn('[residents] ensureContact failed:', e.response?.data?.message || e.message);
    return account.ghl_contact_id || '';
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

module.exports = { seed, findByEmail, createResident, ensureContact, listResidents, dbReady };
