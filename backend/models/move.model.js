const mongoose = require('mongoose');

// Resident move-in/out request detail — the resident's full submission. Mongo is
// the source of truth (shared across devices/portals, replacing the old
// localStorage mirror).
const schema = new mongoose.Schema({
  contact_id: { type: String, default: '', index: true },
  email:      { type: String, default: '', lowercase: true, trim: true, index: true },
  unit:       { type: String, default: '' },
  move_type:  { type: String, default: '' },
  move_date:  { type: String, default: '' },
  move_time:  { type: String, default: '' },
  notes:      { type: String, default: '' },
  created_at: { type: Date,   default: Date.now },
});

module.exports = mongoose.models.Move || mongoose.model('Move', schema);
