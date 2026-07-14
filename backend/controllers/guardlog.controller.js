const mongoose = require('mongoose');
const GuardLog = require('../models/guardlog.model');

const dbReady = () => mongoose.connection.readyState === 1;

function fmt(e) {
  return {
    id: String(e._id), cat: e.cat, key: e.key, type: e.type, label: e.label, name: e.name, meta: e.meta,
    time: new Date(e.updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Singapore' }),
  };
}

// [start, end) of "today" in Asia/Singapore (UTC+8, no DST), as UTC Date
// instants suitable for a Mongo range query on updatedAt. The log itself is
// permanent (Mongo never auto-expires it) - this only scopes what a given
// request sees, matching the app's fixed-SGT-day convention used elsewhere
// (deposit windows, move-date gating, etc.) rather than the guard device's
// local browser clock.
function todaySGTBounds() {
  const sgtNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const y = sgtNow.getUTCFullYear(), m = sgtNow.getUTCMonth(), d = sgtNow.getUTCDate();
  const startUtcMs = Date.UTC(y, m, d, 0, 0, 0) - 8 * 60 * 60 * 1000;
  return { start: new Date(startUtcMs), end: new Date(startUtcMs + 24 * 60 * 60 * 1000) };
}

// GET /api/guardhouse/log?range=today|all — the shared feed, newest first.
// Defaults to today's entries; ?range=all returns the full permanent history.
async function list(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const range = req.query.range === 'all' ? 'all' : 'today';
  const filter = {};
  if (range === 'today') {
    const { start, end } = todaySGTBounds();
    filter.updatedAt = { $gte: start, $lt: end };
  }
  const rows = await GuardLog.find(filter).sort({ updatedAt: -1 }).lean();
  return res.json({ success: true, entries: rows.map(fmt), range });
}

// POST /api/guardhouse/log — add an entry, or update the one matching `key`.
async function upsert(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const b = req.body || {};
  const set = { cat: b.cat || 'guest', type: b.type || '', label: b.label || '', name: b.name || '', meta: b.meta || '' };
  if (b.key) await GuardLog.findOneAndUpdate({ key: b.key }, { $set: { ...set, key: b.key } }, { upsert: true, new: true });
  else       await GuardLog.create(set);
  return res.json({ success: true });
}

// DELETE /api/guardhouse/log?scope=guest|parcel&range=today|all — clear one
// category for all stations. Defaults to today's entries only; wiping the
// full permanent history requires the explicit ?range=all (now that the log
// is a real Mongo history rather than an ephemeral daily/session one, an
// unscoped Clear would otherwise silently destroy history a guard viewing
// "Today" has no reason to expect it can reach).
async function clear(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const filter = req.query.scope === 'parcel' ? { cat: 'parcel' } : { cat: { $ne: 'parcel' } };
  if (req.query.range !== 'all') {
    const { start, end } = todaySGTBounds();
    filter.updatedAt = { $gte: start, $lt: end };
  }
  await GuardLog.deleteMany(filter);
  return res.json({ success: true });
}

module.exports = { list, upsert, clear };
