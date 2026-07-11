// Thin Stripe wrapper — one place for the SDK client so callers never touch
// Stripe directly. Test-mode keys only for now (see backend/.env.example).

const Stripe = require('stripe');

const KEY = process.env.STRIPE_SECRET_KEY || '';
const isConfigured = () => Boolean(KEY);
const stripe = KEY ? new Stripe(KEY) : null;

const APP_URL = (process.env.PUBLIC_APP_URL || 'https://the-lumina-production.up.railway.app').replace(/\/$/, '');

const toCents = (n) => Math.round(Number(n) * 100);

// One Checkout Session per deposit - one card charge, but split into two line
// items when the facility has a non-refundable booking fee on top of the
// refundable deposit (e.g. Verandah: $200 fee + $400 deposit = $600 total),
// so the resident sees exactly what's refundable right on Stripe's own page.
// bookingId travels in metadata (not the URL) so the webhook can trust it
// without re-parsing anything resident-controlled.
async function createDepositCheckoutSession({ bookingId, facilityName, amount, bookingFee = 0, refundableAmount, residentEmail }) {
  if (!stripe) { const e = new Error('Payments are not configured.'); e.status = 503; throw e; }
  const refundable = refundableAmount != null ? refundableAmount : amount;
  const lineItems = bookingFee > 0
    ? [
        { quantity: 1, price_data: { currency: 'usd', unit_amount: toCents(bookingFee), product_data: { name: `${facilityName} — Booking Fee (non-refundable)` } } },
        { quantity: 1, price_data: { currency: 'usd', unit_amount: toCents(refundable), product_data: { name: `${facilityName} — Refundable Deposit` } } },
      ]
    : [
        { quantity: 1, price_data: { currency: 'usd', unit_amount: toCents(amount), product_data: { name: `${facilityName} — Refundable Deposit` } } },
      ];
  return stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: residentEmail || undefined,
    line_items: lineItems,
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
