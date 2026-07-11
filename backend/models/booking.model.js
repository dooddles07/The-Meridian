const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  facilityKey:    { type: String, required: true },
  // Snapshotted from the facility config at creation time (not trusted from the
  // client) so a booking's display name/icon stay stable even if the catalogue
  // entry is ever renamed later.
  facilityName:   { type: String, required: true },
  emoji:          { type: String, default: '' },
  date:           { type: String, required: true }, // YYYY-MM-DD, SGT calendar date
  slot:           { type: String, required: true }, // display string, e.g. "9:00 AM - 10:00 AM"
  slotStartMin:   { type: Number, required: true },  // derived from slot, for fast overlap queries
  slotEndMin:     { type: Number, required: true },
  pax:            { type: Number, default: 1 },
  notes:          { type: String, default: '' },
  status:         { type: String, enum: ['Deposit Pending', 'Confirmed', 'Completed', 'No-Show', 'Cancelled'], default: 'Confirmed' },
  contact_id:     { type: String, required: true, index: true },
  resident_name:  { type: String, default: '' },
  resident_email: { type: String, default: '' },
  resident_unit:  { type: String, default: '' },
  createdAt:      { type: Date, default: Date.now },
});

module.exports = mongoose.models.Booking || mongoose.model('Booking', schema);
