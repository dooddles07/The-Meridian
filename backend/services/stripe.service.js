// Thin Stripe wrapper — one place for the SDK client so callers never touch
// Stripe directly. Test-mode keys only for now (see backend/.env.example).

const Stripe = require('stripe');

const KEY = process.env.STRIPE_SECRET_KEY || '';
const isConfigured = () => Boolean(KEY);
const stripe = KEY ? new Stripe(KEY) : null;

const APP_URL = (process.env.PUBLIC_APP_URL || 'https://the-lumina-production.up.railway.app').replace(/\/$/, '');

// One Checkout Session per deposit. bookingId travels in metadata (not the URL)
// so the webhook can trust it without re-parsing anything resident-controlled.
async function createDepositCheckoutSession({ bookingId, facilityName, amount, residentEmail }) {
  if (!stripe) { const e = new Error('Payments are not configured.'); e.status = 503; throw e; }
  return stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: residentEmail || undefined,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'sgd',
        unit_amount: Math.round(Number(amount) * 100), // Stripe wants the smallest currency unit (cents)
        product_data: { name: `${facilityName} — Refundable Deposit` },
      },
    }],
    metadata: { bookingId },
    success_url: `${APP_URL}/portal.html?paid=1&booking=${encodeURIComponent(bookingId)}`,
    cancel_url:  `${APP_URL}/portal.html?paid=0`,
  });
}

// Verifies the webhook actually came from Stripe (not a spoofed request) using
// the raw request body + the signing secret from the Stripe dashboard/CLI.
function constructWebhookEvent(rawBody, signature) {
  if (!stripe) { const e = new Error('Payments are not configured.'); e.status = 503; throw e; }
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = { isConfigured, createDepositCheckoutSession, constructWebhookEvent };
