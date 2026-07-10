const mongoose = require('mongoose');

// Resident parcel notification detail — the resident's full submission. Mongo is
// the source of truth (shared across devices/portals, replacing the old
// localStorage mirror); the GHL opportunity carries only a truncated name, so the
// description/courier/collector are recovered from here.
const schema = new mongoose.Schema({
  contact_id:           { type: String, default: '', index: true },
  email:                { type: String, default: '', lowercase: true, trim: true, index: true },
  unit:                 { type: String, default: '' },
  parcel_reference:     { type: String, default: '' },
  courier:              { type: String, default: '' },
  description:          { type: String, default: '' },
  authorized_collector: { type: String, default: '' },
  created_at:           { type: Date,   default: Date.now },
});

module.exports = mongoose.models.Parcel || mongoose.model('Parcel', schema);
