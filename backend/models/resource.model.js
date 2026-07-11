const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true },
  category:    { type: String, default: 'General' },
  visibility:  { type: String, enum: ['residents', 'management'], default: 'residents' },
  // Legacy: base64 data URL, from before file storage moved to disk (see
  // config/storage.js). Only ever read now, never written by new uploads -
  // kept so pre-migration documents still download correctly.
  file_data:   { type: String, default: '' },
  // Current storage method: filename under STORAGE_DIR (config/storage.js).
  file_path:   { type: String, default: '' },
  file_name:   { type: String, default: '' },
  file_type:   { type: String, default: '' },
  file_size:   { type: Number, default: 0 },
  uploaded_by: { type: String, default: '' },
  createdAt:   { type: Date, default: Date.now },
  // Set only on auto-seeded starter documents (see resources.service.js's
  // seedExamples) - lets a content/format update replace stale seeded copies
  // on the next boot without ever touching a real management upload, which
  // will always have this empty.
  seedKey:     { type: String, default: '' },
  // Soft-delete flag - a "deleted" document is hidden from every list/download
  // endpoint but never actually removed, so it stays recoverable.
  archived:    { type: Boolean, default: false },
});

module.exports = mongoose.models.Resource || mongoose.model('Resource', schema);
