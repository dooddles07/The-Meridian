const mongoose = require('mongoose');
const GuardLog = require('../models/guardlog.model');

const dbReady = () => mongoose.connection.readyState === 1;

function fmt(e) {
  return {
    id: String(e._id), cat: e.cat, key: e.key, type: e.type, label: e.label, name: e.name, meta: e.meta,
    time: new Date(e.updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Singapore' }),
  };
}

// GET /api/guardhouse/log — the shared feed, newest first.
async function list(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const rows = await GuardLog.find({}).sort({ updatedAt: -1 }).lean();
  return res.json({ success: true, entries: rows.map(fmt) });
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

// DELETE /api/guardhouse/log?scope=guest|parcel — clear one category for all stations.
async function clear(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const filter = req.query.scope === 'parcel' ? { cat: 'parcel' } : { cat: { $ne: 'parcel' } };
  await GuardLog.deleteMany(filter);
  return res.json({ success: true });
}

module.exports = { list, upsert, clear };
