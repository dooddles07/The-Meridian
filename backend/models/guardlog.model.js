const mongoose = require('mongoose');

// Shared guardhouse activity log — every scan / check-in / parcel action by any
// station, persisted so all guardhouse devices show one live, cross-device feed
// (replaces the old per-tab sessionStorage log). Entries with a `key` (e.g. a parcel
// reference) are upserted so a later status change updates the same row.
const schema = new mongoose.Schema({
  cat:   { type: String, default: 'guest' },          // 'parcel' | 'guest'
  key:   { type: String, default: '', index: true },  // dedup/update key (e.g. "parcel:GST-…")
  type:  { type: String, default: '' },               // 'green' | 'red' | 'grey' (dot/tag style)
  label: { type: String, default: '' },
  name:  { type: String, default: '' },
  meta:  { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.models.GuardLog || mongoose.model('GuardLog', schema);
