const mongoose = require('mongoose');
const ghl      = require('./ghl.service');
const Resident = require('../models/resident.model');
const { RESIDENTS, normalizeUnit, clean } = require('../models/auth.model');

const UNIT_FIELD = 'demo-field-unit';
const dbReady    = () => mongoose.connection.readyState === 1;

// Seed the DB from the configured account list (idempotent upsert by email).
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

// Match an account by email + unit. DB first, falls back to the in-memory seed.
async function findResident(email, unit) {
  const e = clean(email).toLowerCase();
  const n = normalizeUnit(unit);
  if (dbReady()) {
    try {
      const r = await Resident.findOne({ email: e, active: true }).lean();
      if (r) return normalizeUnit(r.unit) === n ? r : null;
    } catch (_) { /* fall through to seed */ }
  }
  return RESIDENTS.find(x => clean(x.email).toLowerCase() === e && normalizeUnit(x.unit) === n) || null;
}

// Ensure the account has a live GHL contact (create or update by email), sync
// name + unit, persist the resulting contact ID back to the DB. Returns the ID.
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

module.exports = { seed, findResident, ensureContact, listResidents, dbReady };
