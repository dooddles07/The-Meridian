const mongoose = require('mongoose');
const Defect   = require('../models/defect.model');

const dbReady = () => mongoose.connection.readyState === 1;

const ALL_STAGES = ['Reported', 'Acknowledged', 'In Progress', 'Resolved', 'Closed'];
const URGENCIES  = ['Routine', 'Urgent', 'Emergency'];

// A photo arrives as a base64 data URL already downscaled + JPEG-compressed on
// the client. Reject anything that isn't a plausible image data URL or that
// blows the size budget, rather than persisting junk.
const MAX_PHOTO_CHARS = 1_500_000; // ~1.1MB decoded
function sanitizePhoto(v) {
  if (typeof v !== 'string') return '';
  if (!/^data:image\/[a-z+]+;base64,/i.test(v)) return '';
  if (v.length > MAX_PHOTO_CHARS) return '';
  return v;
}

function defectRef() {
  return 'DFT-' + Date.now().toString(36).toUpperCase().slice(-6);
}

// Pack the tracking code + reported issue into one label for the management
// table's "Reference" column (a defect has no natural reference like a parcel).
function mgmtReference(d) {
  const cat = d.secondaryCategory ? `${d.category} + ${d.secondaryCategory}` : d.category;
  return `${d.reference} · ${cat ? cat + ': ' : ''}${d.description}`;
}

// POST /api/defect  (resident)
async function create(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const description = String(req.body.description || '').trim();
  if (!description) return res.status(400).json({ success: false, message: 'Please describe the issue.' });
  const urgency = URGENCIES.includes(req.body.urgency) ? req.body.urgency : 'Routine';
  const doc = await Defect.create({
    reference:         defectRef(),
    description,
    category:          String(req.body.category || 'General').trim() || 'General',
    secondaryCategory: String(req.body.secondaryCategory || '').trim(),
    location:          String(req.body.location || '').trim(),
    urgency,
    photo:             sanitizePhoto(req.body.defect_file),
    status:            'Reported',
    contact_id:        req.resident.contact_id,
    resident_name:     req.resident.name,
    resident_email:    req.resident.email,
    resident_unit:     req.resident.unit,
  });
  return res.json({ success: true, message: 'Defect report submitted.', reference: doc.reference });
}

// GET /api/defect/mine  (resident)
async function listMine(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const items = await Defect.find({ contact_id: req.resident.contact_id }).sort({ createdAt: -1 }).lean();
  return res.json({
    success: true,
    items: items.map(d => ({
      id: String(d._id),
      reference: d.reference,
      desc: d.description,
      category: d.category,
      secondaryCategory: d.secondaryCategory || '',
      location: d.location || '',
      urgency: d.urgency,
      photo: d.photo || '',
      stage: d.status,
      createdAt: d.createdAt,
      ts: d.createdAt, // renderRecords matches saved rows by `ts`
    })),
  });
}

// GET /api/management/defects  (management)
async function listForManagement(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const items = await Defect.find({}).sort({ createdAt: -1 }).lean();
  return res.json({
    success: true,
    items: items.map(d => ({
      oppId: String(d._id),
      contactId: d.contact_id,
      reference: mgmtReference(d),
      contact: d.resident_name,
      unit: d.resident_unit,
      stage: d.status,
      urgency: d.urgency,
      photo: d.photo || '',
      location: d.location || '',
      createdAt: d.createdAt,
    })),
    stages: ALL_STAGES,
  });
}

// GET /api/defect/:id  (resident) — hydrate the edit form
async function getOne(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const d = await Defect.findOne({ _id: req.params.id, contact_id: req.resident.contact_id }).lean();
  if (!d) return res.status(404).json({ success: false, message: 'Defect report not found.' });
  return res.json({
    success: true,
    defect: {
      id: String(d._id), reference: d.reference, description: d.description,
      category: d.category, secondaryCategory: d.secondaryCategory || '',
      location: d.location || '', urgency: d.urgency, photo: d.photo || '', stage: d.status,
    },
  });
}

// A resident may only amend/withdraw their own report while it's still
// 'Reported' — once management has Acknowledged it (or beyond), it's locked.
async function findEditableOwn(req, res) {
  const d = await Defect.findOne({ _id: req.params.id, contact_id: req.resident.contact_id });
  if (!d) { res.status(404).json({ success: false, message: 'Defect report not found.' }); return null; }
  if (d.status !== 'Reported') {
    res.status(400).json({ success: false, message: 'This report is already being handled and can no longer be changed.' });
    return null;
  }
  return d;
}

// PUT /api/defect/:id  (resident) — edit an unhandled report
async function update(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const d = await findEditableOwn(req, res);
  if (!d) return;
  const description = String(req.body.description || '').trim();
  if (!description) return res.status(400).json({ success: false, message: 'Please describe the issue.' });
  d.description       = description;
  d.category          = String(req.body.category || 'General').trim() || 'General';
  d.secondaryCategory = String(req.body.secondaryCategory || '').trim();
  d.location          = String(req.body.location || '').trim();
  d.urgency           = URGENCIES.includes(req.body.urgency) ? req.body.urgency : 'Routine';
  // Only replace the photo when a new valid one is supplied; an empty/omitted
  // field leaves the existing photo untouched.
  const newPhoto = sanitizePhoto(req.body.defect_file);
  if (newPhoto) d.photo = newPhoto;
  await d.save();
  return res.json({ success: true, message: 'Report updated.', reference: d.reference });
}

// DELETE /api/defect/:id  (resident) — withdraw an unhandled report
async function remove(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const d = await findEditableOwn(req, res);
  if (!d) return;
  await d.deleteOne();
  return res.json({ success: true, message: 'Report withdrawn.' });
}

// PUT /api/management/defects/:id/stage  (management)
async function updateStage(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const { stage } = req.body || {};
  if (!ALL_STAGES.includes(stage)) return res.status(400).json({ success: false, message: 'Invalid stage.' });
  const existing = await Defect.findById(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Defect report not found.' });
  existing.status = stage;
  await existing.save();
  return res.json({ success: true, message: `Moved to ${stage}.`, stage });
}

module.exports = { create, listMine, getOne, update, remove, listForManagement, updateStage };
