const mongoose = require('mongoose');

// Move-in/out requests - real backend (mirrors booking.model.js's shape and
// deposit lifecycle; no facility catalog/slot logic needed since a move is
// just one request, not a bookable resource with availability to check).
const schema = new mongoose.Schema({
  moveType:       { type: String, enum: ['Move-In', 'Move-Out'], required: true },
  moveDate:       { type: String, required: true }, // YYYY-MM-DD, SGT calendar date
  moveTime:       { type: String, required: true }, // display string, e.g. "10:00 AM - 1:00 PM"
  notes:          { type: String, default: '' },
  status:         { type: String, enum: ['Deposit Pending', 'Confirmed', 'Completed', 'Cancelled'], default: 'Deposit Pending' },
  // Every move requires a deposit - set at creation time (now + 24h), same
  // lazy-sweep pattern as bookings (see expireStaleDeposits in the controller).
  depositDueAt:   { type: Date, default: null },
  cancelReason:   { type: String, default: '' },
  // $200 admin fee (non-refundable) + $2000 refundable deposit = $2200 total -
  // depositStatus only ever concerns the refundable $2000 portion, same split
  // model as the Verandah facility booking.
  depositStatus:    { type: String, enum: ['none', 'held', 'refunded', 'forfeited'], default: 'none' },
  depositResolvedAt:{ type: Date, default: null },
  depositNote:      { type: String, default: '' }, // required reason when forfeited
  // Audit trail: how the deposit actually got collected - see booking.model.js's
  // identical field for the full rationale.
  depositConfirmedVia: { type: String, enum: ['', 'stripe', 'manual'], default: '' },
  stripePaymentIntentId:   { type: String, default: '' },
  stripeCheckoutSessionId: { type: String, default: '' },
  contact_id:     { type: String, required: true, index: true },
  resident_name:  { type: String, default: '' },
  resident_email: { type: String, default: '' },
  resident_unit:  { type: String, default: '' },
  createdAt:      { type: Date, default: Date.now },
});

schema.index({ moveDate: 1 }); // management list is filtered/sorted by calendar date

module.exports = mongoose.models.Move || mongoose.model('Move', schema);
