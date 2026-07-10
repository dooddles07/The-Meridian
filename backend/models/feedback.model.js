const mongoose = require('mongoose');

// Resident feedback/complaint/suggestion detail — the resident's full submission.
// Mongo is the source of truth (shared across devices/portals, replacing the old
// localStorage mirror); the GHL opportunity name holds only "<REF> — <Type> ·
// <Category>", so the description is recovered from here.
const schema = new mongoose.Schema({
  contact_id:    { type: String, default: '', index: true },
  email:         { type: String, default: '', lowercase: true, trim: true, index: true },
  unit:          { type: String, default: '' },
  reference:     { type: String, default: '' },
  type:          { type: String, default: '' },
  category:      { type: String, default: '' },
  description:   { type: String, default: '' },
  incident_date: { type: String, default: '' },
  incident_time: { type: String, default: '' },
  created_at:    { type: Date,   default: Date.now },
});

module.exports = mongoose.models.Feedback || mongoose.model('Feedback', schema);
