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
  // Only set for deposit-required facilities, at creation time (now + 24h). A
  // background sweep (see expireStaleDeposits in the controller) auto-cancels
  // any booking still Deposit Pending past this point, releasing the slot -
  // otherwise an unpaid booking would hold it forever.
  depositDueAt:   { type: Date, default: null },
  // Set when the sweep (not the resident) is what cancelled the booking, so the
  // frontend can show "deposit not paid in time" instead of a plain Cancelled,
  // which would otherwise look like a bug ("I never cancelled this!").
  cancelReason:   { type: String, default: '' },
  // Tracks the MONEY separately from the booking's own lifecycle (status) - a
  // Completed booking's deposit can still be sitting "held" for days while
  // management inspects the facility before deciding to refund or forfeit it.
  // 'held' is set the moment a deposit-required booking becomes Confirmed;
  // stays 'none' for facilities with no deposit at all.
  depositStatus:    { type: String, enum: ['none', 'held', 'refunded', 'forfeited'], default: 'none' },
  depositResolvedAt:{ type: Date, default: null },
  depositNote:      { type: String, default: '' }, // required reason when forfeited
  // Audit trail: how the deposit actually got collected - 'stripe' only ever
  // set by the webhook (a real charge happened), 'manual' by management's own
  // "mark as paid" (updateStage). Without this, a Stripe-verified payment and
  // a management override look identical in the record.
  depositConfirmedVia: { type: String, enum: ['', 'stripe', 'manual'], default: '' },
  // Set by the Stripe webhook once a real Checkout Session completes - lets
  // manageDeposit issue an actual stripe.refunds.create() later instead of
  // just flipping depositStatus with no money ever moving back. Empty for a
  // booking confirmed without a real charge (a management "mark as paid") -
  // refund then stays internal-only.
  stripePaymentIntentId: { type: String, default: '' },
  // Set when a Checkout Session is CREATED (before payment completes), so a
  // second "Pay Deposit" click can reuse/check it instead of always minting a
  // fresh one - without this, two sessions for the same booking could both
  // be completed and the resident's card charged twice. See createCheckoutSession.
  stripeCheckoutSessionId: { type: String, default: '' },
  contact_id:     { type: String, required: true, index: true },
  resident_name:  { type: String, default: '' },
  resident_email: { type: String, default: '' },
  resident_unit:  { type: String, default: '' },
  createdAt:      { type: Date, default: Date.now },
});

schema.index({ date: 1 }); // management list is filtered/sorted by calendar date

module.exports = mongoose.models.Booking || mongoose.model('Booking', schema);
