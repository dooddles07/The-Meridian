const mongoose = require('mongoose');
const Resource = require('../models/resource.model');

const dbReady = () => mongoose.connection.readyState === 1;

const fmt = (r) => ({
  id:          String(r._id),
  title:       r.title,
  category:    r.category || 'General',
  visibility:  r.visibility || 'residents',
  file_name:   r.file_name || '',
  file_type:   r.file_type || '',
  file_size:   r.file_size || 0,
  uploaded_by: r.uploaded_by || '',
  createdAt:   r.createdAt,
});

// GET /api/resources — resident-visible documents only.
async function listForResidents(req, res) {
  if (!dbReady()) return res.json({ success: true, resources: [] });
  try {
    const rows = await Resource.find({ visibility: 'residents' })
      .sort({ category: 1, createdAt: -1 })
      .select('-file_data')
      .lean();
    return res.json({ success: true, resources: rows.map(fmt) });
  } catch (err) {
    console.error('[resources] list failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// GET /api/resources/:id/download — fetch file data for a resident-visible document.
async function downloadForResident(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  try {
    const doc = await Resource.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Resource not found.' });
    if (doc.visibility !== 'residents') {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    return res.json({ success: true, file_data: doc.file_data, file_name: doc.file_name, file_type: doc.file_type });
  } catch (err) {
    console.error('[resources] download failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// GET /api/management/resources — all documents (both visibility levels).
async function listForManagement(req, res) {
  if (!dbReady()) return res.json({ success: true, resources: [] });
  try {
    const rows = await Resource.find()
      .sort({ visibility: 1, category: 1, createdAt: -1 })
      .select('-file_data')
      .lean();
    return res.json({ success: true, resources: rows.map(fmt) });
  } catch (err) {
    console.error('[resources] mgmt list failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// GET /api/management/resources/:id/download — fetch file data (management can access all).
async function downloadForManagement(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  try {
    const doc = await Resource.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Resource not found.' });
    return res.json({ success: true, file_data: doc.file_data, file_name: doc.file_name, file_type: doc.file_type });
  } catch (err) {
    console.error('[resources] mgmt download failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// POST /api/management/resources — upload a new document.
async function create(req, res) {
  const { title, category, visibility, file_data, file_name, file_type, file_size } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ success: false, message: 'Title is required.' });
  }
  if (!file_data) {
    return res.status(400).json({ success: false, message: 'File is required.' });
  }
  if (!dbReady()) {
    return res.status(503).json({ success: false, message: 'Database not connected — cannot upload.' });
  }
  const vis = visibility === 'management' ? 'management' : 'residents';
  try {
    const r = await Resource.create({
      title:       String(title).trim(),
      category:    category || 'General',
      visibility:  vis,
      file_data,
      file_name:   file_name || 'document',
      file_type:   file_type || 'application/octet-stream',
      file_size:   Number(file_size) || 0,
      uploaded_by: req.user?.username || req.user?.email || '',
    });
    console.log(`[resources] uploaded "${r.title}" (${r.visibility}) by ${r.uploaded_by}`);
    return res.json({ success: true, resource: fmt(r) });
  } catch (err) {
    console.error('[resources] create failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// DELETE /api/management/resources/:id — remove a document.
async function remove(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  try {
    const result = await Resource.deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Resource not found.' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[resources] delete failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

module.exports = { listForResidents, downloadForResident, listForManagement, downloadForManagement, create, remove };
