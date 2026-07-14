const mongoose = require('mongoose');

// Parcel notifications — real backend (mirrors defect/feedback). Lifecycle:
//   Notified  — resident pre-registered an expected parcel
//   Received  — guardhouse has it in hand
//   Collected — resident (or authorised collector) picked it up
//   Uncollected / Returned — not collected in time, returned to sender
const schema = new mongoose.Schema({
  reference:           { type: String, required: true, index: true },
  courier:             { type: String, default: '' },
  description:         { type: String, default: '' },
  authorizedCollector: { type: String, default: '' },
  status:              { type: String, enum: ['Notified', 'Received', 'Collected', 'Uncollected / Returned'], default: 'Notified' },
  contact_id:          { type: String, required: true, index: true },
  resident_name:       { type: String, default: '' },
  resident_email:      { type: String, default: '' },
  resident_unit:       { type: String, default: '' },
  createdAt:           { type: Date, default: Date.now },
});

module.exports = mongoose.models.Parcel || mongoose.model('Parcel', schema);
