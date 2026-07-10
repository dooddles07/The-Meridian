const mongoose = require('mongoose');

// Resident payment ledger. Records are read-only in the portal; created by
// management/billing out-of-band (or seeded). Keyed to a resident by contact_id
// (preferred) or email.
const paymentSchema = new mongoose.Schema({
  contact_id:     { type: String, default: '' },
  resident_email: { type: String, default: '' },
  resident_unit:  { type: String, default: '' },
  description:    { type: String, required: true },
  amount:         { type: Number, required: true },          // dollars
  currency:       { type: String, default: 'SGD' },
  category:       { type: String, default: 'General' },       // e.g. Maintenance Fee, Facility, Fine
  status:         { type: String, enum: ['paid', 'pending', 'overdue', 'refunded'], default: 'pending' },
  reference:      { type: String, default: '' },
  opportunity_id: { type: String, default: '' },
  fee_label:      { type: String, default: '' },  // 'booking_fee' | 'deposit' | ''
  paid_at:        { type: Date },
  due_at:         { type: Date },
}, { timestamps: true });

paymentSchema.index({ contact_id: 1 });
paymentSchema.index({ resident_email: 1 });

module.exports = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
