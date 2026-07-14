const mongoose = require('mongoose');
const Feedback = require('../models/feedback.model');

const dbReady = () => mongoose.connection.readyState === 1;

const ALL_STAGES = ['Submitted', 'Under Review', 'Resolved', 'Closed'];
const TYPES      = ['Complaint', 'Feedback', 'Suggestion'];

// Type-prefixed reference so the management type filter (which keys off the
// CMP/FBK/SUG prefix) works, and residents get a memorable case number.
function feedbackRef(type) {
  const prefix = type === 'Complaint' ? 'CMP' : type === 'Suggestion' ? 'SUG' : 'FBK';
  return prefix + '-' + Date.now().toString(36).toUpperCase().slice(-6);
}

// Pack reference + type/category/content into the management "Reference" cell —
// the table has no type/description column, so without this a triager sees a
// blank first column and can't tell a complaint from a suggestion.
function mgmtReference(f) {
  const cat = f.category ? ` / ${f.category}` : '';
  return `${f.reference} · ${f.type}${cat}: ${f.description}`;
}

// POST /api/feedback  (resident)
async function create(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const description = String(req.body.description || '').trim();
  if (!description) return res.status(400).json({ success: false, message: 'Please describe your submission.' });
  const type = TYPES.includes(req.body.type) ? req.body.type : 'Complaint';
  // Incident date/time only apply to a Complaint.
  const incident_date = type === 'Complaint' ? String(req.body.incident_date || '').trim() : '';
  const incident_time = type === 'Complaint' ? String(req.body.incident_time || '').trim() : '';
  const doc = await Feedback.create({
    reference: feedbackRef(type),
    type,
    category:  String(req.body.category || 'General').trim() || 'General',
    description, incident_date, incident_time,
    status: 'Submitted',
    contact_id:     req.resident.contact_id,
    resident_name:  req.resident.name,
    resident_email: req.resident.email,
    resident_unit:  req.resident.unit,
  });
  return res.json({ success: true, message: 'Submission received.', reference: doc.reference });
}

// GET /api/feedback/mine  (resident)
async function listMine(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const items = await Feedback.find({ contact_id: req.resident.contact_id }).sort({ createdAt: -1 }).lean();
  return res.json({
    success: true,
    items: items.map(f => ({
      id: String(f._id),
      reference: f.reference,
      type: f.type,
      category: f.category,
      desc: f.description,
      incident_date: f.incident_date || '',
      incident_time: f.incident_time || '',
      stage: f.status,
      response: f.response || '',
      respondedAt: f.respondedAt || null,
      createdAt: f.createdAt,
      ts: f.createdAt,
    })),
  });
}

// GET /api/feedback/:id  (resident) — hydrate the edit form
async function getOne(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const f = await Feedback.findOne({ _id: req.params.id, contact_id: req.resident.contact_id }).lean();
  if (!f) return res.status(404).json({ success: false, message: 'Submission not found.' });
  return res.json({
    success: true,
    feedback: {
      id: String(f._id), reference: f.reference, type: f.type, category: f.category,
      description: f.description, incident_date: f.incident_date || '', incident_time: f.incident_time || '', stage: f.status,
    },
  });
}

// A resident may amend/withdraw only while still 'Submitted' (before management
// starts reviewing).
async function findEditableOwn(req, res) {
  const f = await Feedback.findOne({ _id: req.params.id, contact_id: req.resident.contact_id });
  if (!f) { res.status(404).json({ success: false, message: 'Submission not found.' }); return null; }
  if (f.status !== 'Submitted') {
    res.status(400).json({ success: false, message: 'This submission is already being reviewed and can no longer be changed.' });
    return null;
  }
  return f;
}

// PUT /api/feedback/:id  (resident)
async function update(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const f = await findEditableOwn(req, res);
  if (!f) return;
  const description = String(req.body.description || '').trim();
  if (!description) return res.status(400).json({ success: false, message: 'Please describe your submission.' });
  const type = TYPES.includes(req.body.type) ? req.body.type : f.type;
  f.type          = type;
  f.category      = String(req.body.category || 'General').trim() || 'General';
  f.description   = description;
  f.incident_date = type === 'Complaint' ? String(req.body.incident_date || '').trim() : '';
  f.incident_time = type === 'Complaint' ? String(req.body.incident_time || '').trim() : '';
  await f.save();
  return res.json({ success: true, message: 'Submission updated.', reference: f.reference });
}

// DELETE /api/feedback/:id  (resident)
async function remove(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const f = await findEditableOwn(req, res);
  if (!f) return;
  await f.deleteOne();
  return res.json({ success: true, message: 'Submission withdrawn.' });
}

// GET /api/management/feedback  (management)
async function listForManagement(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const items = await Feedback.find({}).sort({ createdAt: -1 }).lean();
  return res.json({
    success: true,
    items: items.map(f => ({
      oppId: String(f._id),
      contactId: f.contact_id,
      reference: mgmtReference(f),
      type: f.type,
      contact: f.resident_name,
      unit: f.resident_unit,
      stage: f.status,
      response: f.response || '',
      createdAt: f.createdAt,
    })),
    stages: ALL_STAGES,
  });
}

// PUT /api/management/feedback/:id/response  (management) — reply to a resident.
// Recording a reply also advances a still-'Submitted' case to 'Under Review'.
async function respond(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const response = String(req.body.response || '').trim();
  if (!response) return res.status(400).json({ success: false, message: 'A response is required.' });
  if (response.length > 2000) return res.status(400).json({ success: false, message: 'Response is too long (2000 characters max).' });
  const existing = await Feedback.findById(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Submission not found.' });
  existing.response = response;
  existing.respondedAt = new Date();
  if (existing.status === 'Submitted') existing.status = 'Under Review';
  await existing.save();
  return res.json({ success: true, message: 'Response sent.', stage: existing.status });
}

// PUT /api/management/feedback/:id/stage  (management)
async function updateStage(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const { stage } = req.body || {};
  if (!ALL_STAGES.includes(stage)) return res.status(400).json({ success: false, message: 'Invalid stage.' });
  const existing = await Feedback.findById(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Submission not found.' });
  existing.status = stage;
  await existing.save();
  return res.json({ success: true, message: `Moved to ${stage}.`, stage });
}

module.exports = { create, listMine, getOne, update, remove, listForManagement, updateStage, respond };
