const mongoose = require('mongoose');

// Persisted facility bookings — the resident-facing source of truth (replaces the
// old browser-localStorage store, which was per-device and invisible across
// devices/portals). GHL stays the calendar + pipeline mirror: the appointment is
// the schedule, the opportunity carries the live lifecycle stage. We overlay that
// live GHL stage onto these rows at read time so management stage moves still sync.
const bookingSchema = new mongoose.Schema({
  // Identity (from the signed token at write time — never trusted from the client).
  contactId:        { type: String, default: '', index: true },
  email:            { type: String, default: '', lowercase: true, trim: true, index: true },
  unit:             { type: String, default: '' },
  residentName:     { type: String, default: '' },
  // Booking details.
  facilityKey:      { type: String, required: true },
  facilityName:     { type: String, default: '' },
  emoji:            { type: String, default: '' },
  date:             { type: String, required: true },   // "YYYY-MM-DD" (SGT)
  slot:             { type: String, required: true },   // "9:00 AM – 10:00 AM"
  pax:              { type: Number, default: 1 },
  notes:            { type: String, default: '' },
  // Lifecycle stage (Deposit Pending / Confirmed / Completed / No-Show / Cancelled).
  status:           { type: String, default: 'Confirmed' },
  // GHL links (the calendar appointment + the pipeline opportunity).
  ghlAppointmentId: { type: String, default: '', index: true },
  ghlOppId:         { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.models.Booking || mongoose.model('Booking', bookingSchema);
