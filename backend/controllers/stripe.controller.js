const mongoose = require('mongoose');
const Booking  = require('../models/booking.model');
const Move     = require('../models/move.model');
const stripeService = require('../services/stripe.service');

const MODELS = { booking: Booking, move: Move };

// POST /api/stripe/webhook — Stripe calls this directly (no session cookie, no
// resident auth); the payload signature IS the auth, verified against the raw
// body below. Must respond fast and with 200 once handled, or Stripe retries.
async function handleWebhook(req, res) {
  let event;
  try {
    event = stripeService.constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.warn('[stripe] webhook signature check failed:', err.message);
    return res.status(400).json({ success: false, message: 'Invalid signature.' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const kind  = session.metadata && session.metadata.kind;
    const id    = session.metadata && session.metadata.id;
    const Model = MODELS[kind];
    if (Model && id && mongoose.connection.readyState === 1) {
      const doc = await Model.findById(id).catch(() => null);
      // Idempotent: Stripe can deliver the same event more than once.
      if (doc && doc.status === 'Deposit Pending') {
        doc.status = 'Confirmed';
        doc.depositStatus = 'held';
        doc.depositConfirmedVia = 'stripe';
        // string ID on a completed Session in `payment` mode - not expanded,
        // exactly what stripe.refunds.create() needs later.
        if (session.payment_intent) doc.stripePaymentIntentId = session.payment_intent;
        await doc.save();
      }
    }
  }

  return res.json({ received: true });
}

module.exports = { handleWebhook };
