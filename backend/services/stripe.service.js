// Thin Stripe wrapper — one place for the SDK client so callers never touch
// Stripe directly. Test-mode keys only for now (see backend/.env.example).

const Stripe = require('stripe');

const KEY = process.env.STRIPE_SECRET_KEY || '';
const isConfigured = () => Boolean(KEY);
const stripe = KEY ? new Stripe(KEY) : null;

const APP_URL = (process.env.PUBLIC_APP_URL || 'https://the-lumina-production.up.railway.app').replace(/\/$/, '');

const toCents = (n) => Math.round(Number(n) * 100);

const MIN_EXPIRY_SECONDS = 30 * 60;       // Stripe's own floor
const MAX_EXPIRY_SECONDS = 24 * 60 * 60;  // Stripe's own ceiling

// Without this, Stripe's own default 24h session expiry is anchored to
// SESSION creation time - which can be hours after the booking itself (a
// resident who waits, then clicks "Pay Deposit" late) - while our booking's
// own depositDueAt is anchored to BOOKING creation time. That gap meant a
// Stripe session could still be payable after our own 24h sweep had already
// cancelled the booking and released the slot to someone else. Clamping
// expires_at to depositDueAt (within Stripe's [30min, 24h] window) means
// Stripe can never accept money for a booking we've already given up on.
function clampExpiry(depositDueAt) {
  if (!depositDueAt) return undefined;
  const secondsUntilDue = Math.floor((new Date(depositDueAt).getTime() - Date.now()) / 1000);
  const clamped = Math.min(Math.max(secondsUntilDue, MIN_EXPIRY_SECONDS), MAX_EXPIRY_SECONDS);
  return Math.floor(Date.now() / 1000) + clamped;
}

// One Checkout Session per deposit - one card charge, but split into two line
// items when the facility has a non-refundable booking fee on top of the
// refundable deposit (e.g. Verandah: $200 fee + $400 deposit = $600 total),
// so the resident sees exactly what's refundable right on Stripe's own page.
// bookingId travels in metadata (not the URL) so the webhook can trust it
// without re-parsing anything resident-controlled.
async function createDepositCheckoutSession({ bookingId, facilityName, amount, bookingFee = 0, refundableAmount, residentEmail, depositDueAt }) {
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
    expires_at: clampExpiry(depositDueAt),
    success_url: `${APP_URL}/portal.html?paid=1&booking=${encodeURIComponent(bookingId)}`,
    cancel_url:  `${APP_URL}/portal.html?paid=0`,
  });
}

// Looked up before minting a new session, so a resident clicking "Pay
// Deposit" again reuses/checks the one already in flight instead of always
// creating a fresh one (see createCheckoutSession in booking.controller.js).
async function retrieveCheckoutSession(sessionId) {
  if (!stripe) { const e = new Error('Payments are not configured.'); e.status = 503; throw e; }
  return stripe.checkout.sessions.retrieve(sessionId);
}

// Verifies the webhook actually came from Stripe (not a spoofed request) using
// the raw request body + the signing secret from the Stripe dashboard/CLI.
function constructWebhookEvent(rawBody, signature) {
  if (!stripe) { const e = new Error('Payments are not configured.'); e.status = 503; throw e; }
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

// Actually returns money to the card - amount is the REFUNDABLE portion only
// (e.g. Verandah's $400, never the $200 booking fee bundled in the same
// charge). Stripe partial-refunds against the PaymentIntent, so the
// non-refundable part of the original charge is simply left alone.
async function refundDeposit({ paymentIntentId, amount }) {
  if (!stripe) { const e = new Error('Payments are not configured.'); e.status = 503; throw e; }
  return stripe.refunds.create({ payment_intent: paymentIntentId, amount: toCents(amount) });
}

module.exports = { isConfigured, createDepositCheckoutSession, retrieveCheckoutSession, constructWebhookEvent, refundDeposit };
