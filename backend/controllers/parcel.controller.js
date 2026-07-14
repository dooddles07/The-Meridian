const Parcel   = require('../models/parcel.model');
const { isDbReady: dbReady } = require('../utils/db');

const ALL_STAGES = ['Notified', 'Received', 'Collected', 'Uncollected / Returned'];
// Guardhouse action → stage. "received" = physically in hand; there is no
// separate "hold" — a received parcel is held until collected.
const STATUS_MAP = { received: 'Received', collected: 'Collected', uncollected: 'Uncollected / Returned' };

const COLLECTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// A parcel held (Received) but not collected within 7 days is auto-returned —
// honouring the resident-facing "collect within 7 days or it's returned" copy.
// Lazy sweep on read (same pattern as move.controller's expireStaleDeposits).
async function autoReturnStale() {
  await Parcel.updateMany(
    { status: 'Received', receivedAt: { $ne: null, $lt: new Date(Date.now() - COLLECTION_WINDOW_MS) } },
    { $set: { status: 'Uncollected / Returned' } },
  );
}

// ---- Resident ----

// POST /api/parcel — pre-register an expected parcel (dedup by reference).
async function create(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const reference = String(req.body.parcel_reference || '').trim();
  if (!reference) return res.status(400).json({ success: false, message: 'Please enter the parcel reference.' });
  const dup = await Parcel.findOne({ reference: new RegExp(`^${reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
  if (dup) return res.json({ success: true, message: 'This parcel is already logged with the guardhouse.', reference, duplicate: true });
  const doc = await Parcel.create({
    reference,
    courier:             String(req.body.courier || '').trim(),
    description:         String(req.body.description || '').trim(),
    authorizedCollector: String(req.body.authorized_collector || '').trim(),
    status:              'Notified',
    contact_id:          req.resident.contact_id,
    resident_name:       req.resident.name,
    resident_email:      req.resident.email,
    resident_unit:       req.resident.unit,
  });
  return res.json({ success: true, message: 'Guardhouse notified.', reference: doc.reference });
}

function toResidentRow(p) {
  return {
    id: String(p._id), ref: p.reference, courier: p.courier || '', desc: p.description || '',
    collector: p.authorizedCollector || '', stage: p.status, receivedAt: p.receivedAt || null,
    createdAt: p.createdAt, ts: p.createdAt,
  };
}

// GET /api/parcel/mine
async function listMine(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  await autoReturnStale();
  const items = await Parcel.find({ contact_id: req.resident.contact_id }).sort({ createdAt: -1 }).lean();
  return res.json({ success: true, items: items.map(toResidentRow) });
}

// GET /api/parcel/:id — hydrate the edit form
async function getOne(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const p = await Parcel.findOne({ _id: req.params.id, contact_id: req.resident.contact_id }).lean();
  if (!p) return res.status(404).json({ success: false, message: 'Parcel not found.' });
  return res.json({ success: true, parcel: { id: String(p._id), reference: p.reference, courier: p.courier || '', description: p.description || '', authorizedCollector: p.authorizedCollector || '', stage: p.status } });
}

// A resident may amend/cancel only while still 'Notified' (before it arrives).
async function findEditableOwn(req, res) {
  const p = await Parcel.findOne({ _id: req.params.id, contact_id: req.resident.contact_id });
  if (!p) { res.status(404).json({ success: false, message: 'Parcel not found.' }); return null; }
  if (p.status !== 'Notified') {
    res.status(400).json({ success: false, message: 'This parcel has already arrived at the guardhouse and can no longer be changed here.' });
    return null;
  }
  return p;
}

// PUT /api/parcel/:id
async function update(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const p = await findEditableOwn(req, res);
  if (!p) return;
  const reference = String(req.body.parcel_reference || '').trim();
  if (!reference) return res.status(400).json({ success: false, message: 'Please enter the parcel reference.' });
  p.reference           = reference;
  p.courier             = String(req.body.courier || '').trim();
  p.description         = String(req.body.description || '').trim();
  p.authorizedCollector = String(req.body.authorized_collector || '').trim();
  await p.save();
  return res.json({ success: true, message: 'Parcel updated.', reference: p.reference });
}

// DELETE /api/parcel/:id
async function remove(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const p = await findEditableOwn(req, res);
  if (!p) return;
  await p.deleteOne();
  return res.json({ success: true, message: 'Parcel notification cancelled.' });
}

// ---- Management ----

// GET /api/management/parcels
async function listForManagement(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  await autoReturnStale();
  const items = await Parcel.find({}).sort({ createdAt: -1 }).limit(500).lean();
  return res.json({
    success: true,
    items: items.map(p => ({
      oppId: String(p._id), reference: p.reference, courier: p.courier || '', authorizedCollector: p.authorizedCollector || '',
      contact: p.resident_name, unit: p.resident_unit, stage: p.status, createdAt: p.createdAt,
    })),
    stages: ALL_STAGES,
  });
}

// PUT /api/management/parcels/:id/stage
async function updateStage(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const { stage } = req.body || {};
  if (!ALL_STAGES.includes(stage)) return res.status(400).json({ success: false, message: 'Invalid stage.' });
  const existing = await Parcel.findById(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Parcel not found.' });
  existing.status = stage;
  await existing.save();
  return res.json({ success: true, message: `Parcel moved to ${stage}.`, stage });
}

// ---- Guardhouse ----

// GET /api/guardhouse/parcel?reference=
async function guardLookup(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  await autoReturnStale();
  const reference = String(req.query.reference || req.query.ref || '').trim();
  if (!reference) return res.status(400).json({ success: false, message: 'Enter a parcel reference.' });
  const p = await Parcel.findOne({ reference: new RegExp(`^${reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
  if (!p) return res.json({ success: true, found: false });
  return res.json({
    success: true, found: true, reference: p.reference, opportunityId: String(p._id),
    resident: p.resident_name, unit: p.resident_unit, stage: p.status, authorizedCollector: p.authorizedCollector || '',
  });
}

// POST /api/guardhouse/parcel/status
async function guardUpdateStatus(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const stage = STATUS_MAP[req.body.status];
  if (!stage) return res.status(400).json({ success: false, message: 'Invalid status.' });
  const ref = String(req.body.reference || '').trim();
  const p = req.body.opportunity_id
    ? await Parcel.findById(req.body.opportunity_id)
    : (ref ? await Parcel.findOne({ reference: new RegExp(`^${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }) : null);
  if (!p) return res.status(404).json({ success: false, message: 'Parcel not found.' });
  p.status = stage;
  // Stamp arrival time the first time it's marked Received — starts the 7-day
  // collection clock the auto-return sweep reads.
  if (stage === 'Received' && !p.receivedAt) p.receivedAt = new Date();
  await p.save();
  return res.json({ success: true, stage, tag: 'parcel-' + req.body.status });
}

module.exports = { create, listMine, getOne, update, remove, listForManagement, updateStage, guardLookup, guardUpdateStatus };
