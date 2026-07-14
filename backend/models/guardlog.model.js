const mongoose = require('mongoose');

// Shared guardhouse activity log — one feed across all guard stations (visitor
// check-ins + parcel actions). Entries carrying a `key` (e.g. a parcel ref) are
// upserted so repeated actions update one row rather than piling up.
const schema = new mongoose.Schema({
  cat:   { type: String, default: 'guest' }, // 'guest' | 'parcel'
  key:   { type: String, default: '', index: true },
  type:  { type: String, default: '' },      // dot/tag colour: green | red | amber …
  label: { type: String, default: '' },
  name:  { type: String, default: '' },
  meta:  { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.models.GuardLog || mongoose.model('GuardLog', schema);
