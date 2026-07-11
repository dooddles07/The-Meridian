const mongoose = require('mongoose');
const Resource = require('../models/resource.model');

const dbReady = () => mongoose.connection.readyState === 1;

// Matches the client's 10MB file-size cap. Enforced server-side too since the
// client check is only a UX nicety — a direct API call could send anything.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function decodeDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const raw = comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(raw, 'base64');
}

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
]);

// The client reports file_type itself, so it can't be trusted alone — a
// renamed executable would sail through as a "PDF" otherwise. Check the
// actual bytes match what's claimed. DOC/DOCX are OLE2/ZIP containers; we
// only verify the container signature (not a full parse), which is enough to
// block anything that isn't at least the right container format.
function signatureMatches(buf, mime) {
  switch (mime) {
    case 'application/pdf':
      return buf.length >= 4 && buf.slice(0, 4).toString('ascii') === '%PDF';
    case 'image/jpeg':
      return buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    case 'image/png':
      return buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    case 'application/msword':
      return buf.length >= 4 && buf.slice(0, 4).equals(Buffer.from([0xD0, 0xCF, 0x11, 0xE0]));
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return buf.length >= 2 && buf.slice(0, 2).toString('ascii') === 'PK';
    default:
      return false;
  }
}

// Returns an error message string, or null if the upload is valid.
function validateUpload(fileType, buf) {
  if (buf.length > MAX_FILE_BYTES) return 'File is too large. Maximum size is 10 MB.';
  if (!ALLOWED_MIME.has(fileType)) return 'Unsupported file type. Allowed: PDF, Word (.doc/.docx), JPG, PNG.';
  if (!signatureMatches(buf, fileType)) return "The file's contents don't match its reported type.";
  return null;
}

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

// GET /api/resources — resident-visible, non-archived documents only.
async function listForResidents(req, res) {
  if (!dbReady()) return res.json({ success: true, resources: [] });
  try {
    const rows = await Resource.find({ visibility: 'residents', archived: { $ne: true } })
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
    if (!doc || doc.archived) return res.status(404).json({ success: false, message: 'Resource not found.' });
    if (doc.visibility !== 'residents') {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    return res.json({ success: true, file_data: doc.file_data, file_name: doc.file_name, file_type: doc.file_type });
  } catch (err) {
    console.error('[resources] download failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// GET /api/management/resources — all non-archived documents (both visibility levels).
async function listForManagement(req, res) {
  if (!dbReady()) return res.json({ success: true, resources: [] });
  try {
    const rows = await Resource.find({ archived: { $ne: true } })
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
    if (!doc || doc.archived) return res.status(404).json({ success: false, message: 'Resource not found.' });
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
  let buf;
  try { buf = decodeDataUrl(String(file_data)); } catch { return res.status(400).json({ success: false, message: 'Invalid file data.' }); }
  const validationError = validateUpload(file_type, buf);
  if (validationError) {
    return res.status(validationError.startsWith('File is too large') ? 413 : 400).json({ success: false, message: validationError });
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
      file_type,
      file_size:   buf.length,
      uploaded_by: req.user?.username || req.user?.email || '',
    });
    console.log(`[resources] uploaded "${r.title}" (${r.visibility}) by ${r.uploaded_by}`);
    return res.json({ success: true, resource: fmt(r) });
  } catch (err) {
    console.error('[resources] create failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// PATCH /api/management/resources/:id — update metadata (title/category/visibility)
// and/or replace the file itself. Only the fields present in the body are changed.
async function patch(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const { title, category, visibility, file_data, file_name, file_type } = req.body || {};
  const update = {};
  if (title !== undefined) {
    if (!String(title).trim()) return res.status(400).json({ success: false, message: 'Title cannot be empty.' });
    update.title = String(title).trim();
  }
  if (category !== undefined) update.category = category || 'General';
  if (visibility !== undefined) update.visibility = visibility === 'management' ? 'management' : 'residents';
  if (file_data !== undefined) {
    let buf;
    try { buf = decodeDataUrl(String(file_data)); } catch { return res.status(400).json({ success: false, message: 'Invalid file data.' }); }
    const validationError = validateUpload(file_type, buf);
    if (validationError) {
      return res.status(validationError.startsWith('File is too large') ? 413 : 400).json({ success: false, message: validationError });
    }
    update.file_data = file_data;
    update.file_name = file_name || 'document';
    update.file_type = file_type;
    update.file_size = buf.length;
  }
  if (!Object.keys(update).length) {
    return res.status(400).json({ success: false, message: 'No changes provided.' });
  }
  try {
    const r = await Resource.findOneAndUpdate(
      { _id: req.params.id, archived: { $ne: true } },
      update,
      { new: true },
    );
    if (!r) return res.status(404).json({ success: false, message: 'Resource not found.' });
    console.log(`[resources] updated "${r.title}" by ${req.user?.username || req.user?.email || ''}`);
    return res.json({ success: true, resource: fmt(r) });
  } catch (err) {
    console.error('[resources] patch failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// DELETE /api/management/resources/:id — soft-delete. Marks the document
// archived instead of removing it, so an accidental delete is recoverable
// (directly in the database, until a restore UI exists) and never silently
// destroys a published by-law or meeting minutes with no way back.
async function remove(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  try {
    const r = await Resource.findOneAndUpdate(
      { _id: req.params.id, archived: { $ne: true } },
      { archived: true },
      { new: true },
    );
    if (!r) return res.status(404).json({ success: false, message: 'Resource not found.' });
    return res.json({ success: true });
  } catch (err) {
    console.error('[resources] delete failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

module.exports = { listForResidents, downloadForResident, listForManagement, downloadForManagement, create, patch, remove };
