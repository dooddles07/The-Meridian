const mongoose = require('mongoose');
const Move     = require('../models/move.model');
const stripeService = require('../services/stripe.service');
const depositCheckout = require('../services/depositCheckout.service');

const dbReady = () => mongoose.connection.readyState === 1;

// $200 admin fee (non-refundable) + $2000 refundable deposit = $2200 total.
// No facility config for this to live in (Move-In/Out isn't a bookable
// resource with a catalog entry) - kept here as the one place these figures
// are defined, same "single source of truth" reasoning as facilities.js.
const ADMIN_FEE          = 200;
const REFUNDABLE_DEPOSIT = 2000;
const TOTAL_DEPOSIT      = ADMIN_FEE + REFUNDABLE_DEPOSIT;

const ALL_STAGES = ['Deposit Pending', 'Confirmed', 'Completed', 'Cancelled'];
const LEGAL_TRANSITIONS = {
  'Deposit Pending': ['Confirmed', 'Cancelled'],
  'Confirmed':       ['Completed', 'Cancelled'],
  'Completed':       [],
  'Cancelled':       [],
};

const DEPOSIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MOVE_TIMES = ['9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM'];

// SGT calendar date / time-of-day - matches facilities.js's identical helpers
// (kept local rather than shared since Move has no other facilities.js overlap).
function todaySGT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}
function addDaysSGT(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
// Counts 7 WORKING days (Mon-Fri) forward from today - mirrors the frontend's
// calcMinMoveDate() exactly, so a date the client shows as pickable is also
// one the server accepts.
function minMoveDate() {
  const today = todaySGT();
  let d = new Date(today + 'T00:00:00');
  let count = 0;
  while (count < 7) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) count++;
  }
  return d.toISOString().slice(0, 10);
}

async function expireStaleDeposits() {
  await Move.updateMany(
    { status: 'Deposit Pending', depositDueAt: { $lt: new Date() } },
    { $set: { status: 'Cancelled', cancelReason: 'deposit_expired' } },
  );
}
// A Confirmed move whose date has passed becomes Completed on its own -
// otherwise every move would need a manual management click before its
// deposit could ever reach the refund/forfeit step (same reasoning as
// booking.controller.js's completePastBookings).
async function completePastMoves() {
  const today = todaySGT();
  await Move.updateMany({ status: 'Confirmed', moveDate: { $lt: today } }, { $set: { status: 'Completed' } });
}
async function runSweeps() {
  await expireStaleDeposits();
  await completePastMoves();
}

function validateMoveInput(req, res) {
  const { moveType, moveDate, moveTime } = req.body || {};
  if (!['Move-In', 'Move-Out'].includes(moveType)) {
    res.status(400).json({ success: false, message: 'Please choose a valid move type.' }); return null;
  }
  if (!moveDate || moveDate < minMoveDate()) {
    res.status(400).json({ success: false, message: 'A minimum of 7 working days advance notice is required.' }); return null;
  }
  const dow = new Date(moveDate + 'T00:00:00').getDay();
  if (dow === 0 || dow === 6) {
    res.status(400).json({ success: false, message: 'Move In/Out is only permitted Monday to Friday.' }); return null;
  }
  if (!MOVE_TIMES.includes(moveTime)) {
    res.status(400).json({ success: false, message: 'Please select a valid time slot.' }); return null;
  }
  return { moveType, moveDate, moveTime };
}

// POST /api/move
async function create(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  await runSweeps();
  const valid = validateMoveInput(req, res);
  if (!valid) return;
  const depositDueAt = new Date(Date.now() + DEPOSIT_WINDOW_MS);
  const doc = await Move.create({
    ...valid, notes: (req.body.notes || '').trim(),
    status: 'Deposit Pending', depositDueAt,
    contact_id: req.resident.contact_id, resident_name: req.resident.name,
    resident_email: req.resident.email, resident_unit: req.resident.unit,
  });
  return res.json({ success: true, moveId: String(doc._id), depositDueAt });
}

// GET /api/move/mine
async function listMine(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  await runSweeps();
  const items = await Move.find({ contact_id: req.resident.contact_id }).sort({ moveDate: 1 }).lean();
  return res.json({
    success: true,
    items: items.map(m => ({
      id: String(m._id), moveId: String(m._id),
      moveType: m.moveType, move_type: m.moveType, moveDate: m.moveDate, move_date: m.moveDate,
      moveTime: m.moveTime, move_time: m.moveTime, notes: m.notes, createdAt: m.createdAt,
      status: m.status, stage: m.status,
      depositDueAt: m.depositDueAt || null, cancelReason: m.cancelReason || '',
      depositStatus: m.depositStatus || 'none', depositResolvedAt: m.depositResolvedAt || null, depositNote: m.depositNote || '',
      depositConfirmedVia: m.depositConfirmedVia || '',
    })),
  });
}

// DELETE /api/move/:id
async function cancel(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const existing = await Move.findOne({ _id: req.params.id, contact_id: req.resident.contact_id });
  if (!existing) return res.status(404).json({ success: false, message: 'Move request not found.' });
  if (!(LEGAL_TRANSITIONS[existing.status] || []).includes('Cancelled')) {
    return res.status(400).json({ success: false, message: 'This move request has already ended and cannot be cancelled.' });
  }
  existing.status = 'Cancelled';
  await existing.save();
  return res.json({ success: true });
}

// POST /api/move/:id/checkout-session
async function createCheckoutSession(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const existing = await Move.findOne({ _id: req.params.id, contact_id: req.resident.contact_id });
  if (!existing) return res.status(404).json({ success: false, message: 'Move request not found.' });
  if (existing.status !== 'Deposit Pending') {
    return res.status(400).json({ success: false, message: 'This request is not awaiting a deposit.' });
  }
  const result = await depositCheckout.getOrCreateCheckoutSession(existing, {
    kind: 'move', label: existing.moveType, amount: TOTAL_DEPOSIT,
    bookingFee: ADMIN_FEE, refundableAmount: REFUNDABLE_DEPOSIT,
  });
  if (result.alreadyPaid) return res.json({ success: true, alreadyPaid: true, message: 'This deposit has already been paid.' });
  return res.json({ success: true, url: result.url });
}

// GET /api/management/moves
async function listForManagement(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  await runSweeps();
  const items = await Move.find({}).sort({ moveDate: 1 }).lean();
  return res.json({
    success: true,
    items: items.map(m => ({
      oppId: String(m._id), moveType: m.moveType, resident: m.resident_name, unit: m.resident_unit,
      moveDate: m.moveDate, moveTime: m.moveTime, notes: m.notes, stage: m.status,
      depositDueAt: m.depositDueAt || null, cancelReason: m.cancelReason || '',
      depositStatus: m.depositStatus || 'none', depositResolvedAt: m.depositResolvedAt || null, depositNote: m.depositNote || '',
      depositConfirmedVia: m.depositConfirmedVia || '',
    })),
    stages: ALL_STAGES,
  });
}

// PUT /api/management/moves/:id/stage
async function updateStage(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const { stage } = req.body || {};
  if (!ALL_STAGES.includes(stage)) return res.status(400).json({ success: false, message: 'Invalid stage.' });
  const existing = await Move.findById(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Move request not found.' });
  if (stage !== existing.status && !(LEGAL_TRANSITIONS[existing.status] || []).includes(stage)) {
    return res.status(400).json({ success: false, message: `Cannot move a ${existing.status} request to ${stage}.` });
  }
  // Covers management confirming a deposit manually ("Mark as Paid") rather
  // than the resident's own Stripe checkout - either path collects the
  // money, so either path must start the deposit's held/refund/forfeit lifecycle.
  if (stage === 'Confirmed' && existing.depositStatus === 'none') { existing.depositStatus = 'held'; existing.depositConfirmedVia = 'manual'; }
  existing.status = stage;
  await existing.save();
  return res.json({ success: true, message: `Request moved to ${stage}.`, stage });
}

// PUT /api/management/moves/:id/deposit - resolve a held deposit: refund the
// $2000 refundable portion back (via real Stripe refund if there's a real
// charge on file), or forfeit it, with a reason. The $200 admin fee is never
// touched either way - it isn't part of depositStatus at all.
async function manageDeposit(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const { action, note } = req.body || {};
  if (!['refund', 'forfeit'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Invalid action.' });
  }
  if (action === 'forfeit' && !String(note || '').trim()) {
    return res.status(400).json({ success: false, message: 'A reason is required to forfeit a deposit.' });
  }
  const existing = await Move.findById(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Move request not found.' });
  if (existing.depositStatus !== 'held') {
    return res.status(400).json({ success: false, message: 'This request has no held deposit to resolve.' });
  }

  let stripeRefunded = false;
  if (action === 'refund' && existing.stripePaymentIntentId) {
    try {
      await stripeService.refundDeposit({ paymentIntentId: existing.stripePaymentIntentId, amount: REFUNDABLE_DEPOSIT });
      stripeRefunded = true;
    } catch (err) {
      console.warn('[stripe] refund failed:', err.message);
      return res.status(502).json({ success: false, message: 'Could not process the refund with Stripe. Please try again or check the Stripe dashboard.' });
    }
  }

  existing.depositStatus = action === 'refund' ? 'refunded' : 'forfeited';
  existing.depositResolvedAt = new Date();
  existing.depositNote = String(note || '').trim();
  await existing.save();
  return res.json({ success: true, depositStatus: existing.depositStatus, stripeRefunded });
}

module.exports = {
  create, listMine, cancel, createCheckoutSession,
  listForManagement, updateStage, manageDeposit,
  ADMIN_FEE, REFUNDABLE_DEPOSIT, TOTAL_DEPOSIT,
};
