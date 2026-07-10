const mongoose = require('mongoose');

// Persisted facility bookings — resident-facing source of truth (replaces the old
// per-device localStorage store). GHL remains the calendar + pipeline mirror: the
// appointment is the schedule, the opportunity carries the live lifecycle stage,
// which is overlaid onto these rows at read time so management stage moves stay synced.
const bookingSchema = new mongoose.Schema({
  contactId:        { type: String, default: '', index: true }, // from the signed token at write time, never the client
  email:            { type: String, default: '', lowercase: true, trim: true, index: true },
  unit:             { type: String, default: '' },
  residentName:     { type: String, default: '' },
  facilityKey:      { type: String, required: true },
  facilityName:     { type: String, default: '' },
  emoji:            { type: String, default: '' },
  date:             { type: String, required: true },   // "YYYY-MM-DD" (SGT)
  slot:             { type: String, required: true },   // "9:00 AM – 10:00 AM"
  pax:              { type: Number, default: 1 },
  notes:            { type: String, default: '' },
  status:           { type: String, default: 'Confirmed' }, // Deposit Pending / Confirmed / Completed / No-Show / Cancelled
  ghlAppointmentId: { type: String, default: '', index: true },
  ghlOppId:         { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.models.Booking || mongoose.model('Booking', bookingSchema);
