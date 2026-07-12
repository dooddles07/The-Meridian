// Shared "get or create a Stripe Checkout Session for this deposit" flow, used
// by both booking.controller.js and move.controller.js so the double-charge
// guard (reuse an open session, reconcile a completed one, replace an expired
// one) only has to be written and tested once. Works against any Mongoose
// document that has status/depositStatus/stripeCheckoutSessionId/
// stripePaymentIntentId fields (Booking and Move both do).

const stripeService = require('./stripe.service');

// doc: the Booking or Move document (already fetched, status already
// verified as 'Deposit Pending' by the caller).
// kind: 'booking' | 'move' - travels in Stripe metadata so the webhook knows
// which model to update.
// label: display name for Stripe's line items (facility name, or "Move-In"/"Move-Out").
async function getOrCreateCheckoutSession(doc, { kind, label, amount, bookingFee, refundableAmount }) {
  if (doc.stripeCheckoutSessionId) {
    const prior = await stripeService.retrieveCheckoutSession(doc.stripeCheckoutSessionId).catch(() => null);
    if (prior && prior.status === 'complete') {
      // Stripe already has a successful payment the webhook may not have
      // processed yet - reconcile right here rather than let a second charge happen.
      doc.status = 'Confirmed';
      doc.depositStatus = 'held';
      if (prior.payment_intent) doc.stripePaymentIntentId = prior.payment_intent;
      await doc.save();
      return { alreadyPaid: true };
    }
    if (prior && prior.status === 'open') {
      return { url: prior.url }; // still awaiting payment - same session, not a new one
    }
    // 'expired' (or lookup failed) - falls through to create a fresh session below.
  }

  const session = await stripeService.createDepositCheckoutSession({
    kind, id: String(doc._id), label, amount, bookingFee, refundableAmount,
    residentEmail: doc.resident_email, depositDueAt: doc.depositDueAt,
  });
  doc.stripeCheckoutSessionId = session.id;
  await doc.save();
  return { url: session.url };
}

module.exports = { getOrCreateCheckoutSession };
