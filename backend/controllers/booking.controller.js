const mongoose  = require('mongoose');
const Booking   = require('../models/booking.model');
const facilities = require('../config/facilities');

const dbReady = () => mongoose.connection.readyState === 1;

const EDITABLE_STATUSES = ['Deposit Pending', 'Confirmed'];
const ALL_STAGES        = ['Deposit Pending', 'Confirmed', 'Completed', 'No-Show', 'Cancelled'];

// Legal next stages per current stage - Completed/No-Show/Cancelled are
// terminal (no outgoing transitions). Kept in sync by hand with the identical
// map in management.controller.js (no shared module between browser/server
// here), which uses it only to grey out illegal options in the UI - this is
// the copy that actually gets enforced.
const LEGAL_TRANSITIONS = {
  'Deposit Pending': ['Confirmed', 'Cancelled'],
  'Confirmed':       ['Completed', 'No-Show', 'Cancelled'],
  'Completed':       [],
  'No-Show':         [],
  'Cancelled':       [],
};

const DEPOSIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && aEnd > bStart; }

// No cron/worker in this app, so both sweeps below are lazy: called at the top
// of every read/write path that decides slot availability or lists bookings,
// so neither a stale hold nor a stuck-Confirmed booking outlives the request
// that would have exposed it.
async function expireStaleDeposits() {
  await Booking.updateMany(
    { status: 'Deposit Pending', depositDueAt: { $lt: new Date() } },
    { $set: { status: 'Cancelled', cancelReason: 'deposit_expired' } },
  );
}

// A Confirmed booking whose slot has actually ended becomes Completed on its
// own - otherwise every single booking ever made would need a management
// click, and a deposit could never reach the refund/forfeit step at all.
async function completePastBookings() {
  const today = facilities.todaySGT();
  const nowMins = facilities.nowSGTMins();
  await Booking.updateMany(
    { status: 'Confirmed', $or: [
      { date: { $lt: today } },
      { date: today, slotEndMin: { $lte: nowMins } },
    ] },
    { $set: { status: 'Completed' } },
  );
}

async function runSweeps() {
  await expireStaleDeposits();
  await completePastBookings();
}

// Shared validation for create/update - returns { facility } on success or
// writes an error response and returns null.
function validateBookingInput(req, res, { excludeId } = {}) {
  const { facilityKey, date, slot, pax } = req.body || {};
  const facility = facilities.facByKey(facilityKey);
  if (!facility) { res.status(400).json({ success: false, message: 'Unknown facility.' }); return null; }

  const today = facilities.todaySGT();
  if (!date || date < today) { res.status(400).json({ success: false, message: 'Please choose a valid date.' }); return null; }
  if (facility.maxAdvanceDays) {
    const maxDate = facilities.addDaysSGT(today, facility.maxAdvanceDays);
    if (date > maxDate) { res.status(400).json({ success: false, message: `${facility.name} can only be booked up to ${facility.maxAdvanceDays} days in advance.` }); return null; }
  }

  const legalSlots = facilities.timeSlots(facility);
  if (!legalSlots.includes(slot)) { res.status(400).json({ success: false, message: 'Invalid time slot.' }); return null; }
  const slotStartMin = facilities.parseSlotStart(slot);
  const slotEndMin    = facilities.parseSlotEnd(slot);
  if (date === today && slotStartMin <= facilities.nowSGTMins()) {
    res.status(400).json({ success: false, message: 'That time slot has already passed.' }); return null;
  }

  const paxNum = parseInt(pax, 10);
  if (isNaN(paxNum) || paxNum < 1 || paxNum > facility.maxPax) {
    res.status(400).json({ success: false, message: `Pax must be between 1 and ${facility.maxPax}.` }); return null;
  }

  return { facility, date, slot, slotStartMin, slotEndMin, pax: paxNum };
}

// Any non-Cancelled booking occupies its slot - Deposit Pending still holds the
// slot the same as Confirmed does (no payment-timeout/release logic exists, so
// letting an unpaid pending booking block others would let it be silently
// bumped by a second resident, which is worse).
async function hasConflict(facilityKey, date, slotStartMin, slotEndMin, excludeId) {
  const query = { facilityKey, date, status: { $ne: 'Cancelled' } };
  if (excludeId) query._id = { $ne: excludeId };
  const candidates = await Booking.find(query).lean();
  return candidates.some(b => overlaps(slotStartMin, slotEndMin, b.slotStartMin, b.slotEndMin));
}

// GET /api/booking/availability?facilityKey=&date=&exclude=
async function availability(req, res) {
  if (!dbReady()) return res.json({ success: true, busy: [] }); // fail open, matches the frontend's own comment
  await runSweeps();
  const { facilityKey, date, exclude } = req.query || {};
  const facility = facilities.facByKey(facilityKey);
  if (!facility || !date) return res.json({ success: true, busy: [] });
  const query = { facilityKey, date, status: { $ne: 'Cancelled' } };
  if (exclude) query._id = { $ne: exclude };
  const items = await Booking.find(query).lean();
  return res.json({ success: true, busy: items.map(b => ({ start: b.slotStartMin, end: b.slotEndMin })) });
}

// GET /api/booking/mine
async function listMine(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  await runSweeps();
  const contactId = req.resident.contact_id;
  const items = await Booking.find({ contact_id: contactId }).sort({ date: 1 }).lean();
  return res.json({
    success: true,
    items: items.map(b => ({
      id: String(b._id), oppId: String(b._id),
      facilityKey: b.facilityKey, facilityName: b.facilityName, facility: b.facilityName, emoji: b.emoji,
      date: b.date, slot: b.slot, pax: b.pax, notes: b.notes,
      status: b.status, stage: b.status,
      depositDueAt: b.depositDueAt || null, cancelReason: b.cancelReason || '',
      depositStatus: b.depositStatus || 'none', depositResolvedAt: b.depositResolvedAt || null, depositNote: b.depositNote || '',
    })),
  });
}

// POST /api/booking
async function create(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  await runSweeps();
  const valid = validateBookingInput(req, res);
  if (!valid) return;
  const { facility, date, slot, slotStartMin, slotEndMin, pax } = valid;

  if (facility.maxBlocksPerDay) {
    // Venue-level cap (e.g. Verandah: max 2 event blocks/day across ALL residents,
    // not per-resident - it's a shared space, not a personal quota).
    const sameDayCount = await Booking.countDocuments({ facilityKey: facility.key, date, status: { $ne: 'Cancelled' } });
    if (sameDayCount >= facility.maxBlocksPerDay) {
      return res.status(409).json({ success: false, message: `Maximum ${facility.maxBlocksPerDay} block${facility.maxBlocksPerDay > 1 ? 's' : ''} of ${facility.name} may be booked per day.` });
    }
  }

  if (await hasConflict(facility.key, date, slotStartMin, slotEndMin)) {
    return res.status(409).json({ success: false, message: 'That time slot was just booked by someone else. Please choose another.' });
  }

  const depositDueAt = facility.deposit ? new Date(Date.now() + DEPOSIT_WINDOW_MS) : null;
  const doc = await Booking.create({
    facilityKey: facility.key, facilityName: facility.name, emoji: facility.emoji,
    date, slot, slotStartMin, slotEndMin, pax, notes: (req.body.notes || '').trim(),
    status: facility.deposit ? 'Deposit Pending' : 'Confirmed', depositDueAt,
    contact_id: req.resident.contact_id, resident_name: req.resident.name,
    resident_email: req.resident.email, resident_unit: req.resident.unit,
  });
  return res.json({ success: true, appointmentId: String(doc._id), depositDueAt });
}

// PUT /api/booking/:id
async function update(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  await runSweeps();
  const existing = await Booking.findOne({ _id: req.params.id, contact_id: req.resident.contact_id });
  if (!existing) return res.status(404).json({ success: false, message: 'Booking not found.' });
  if (!EDITABLE_STATUSES.includes(existing.status)) {
    return res.status(400).json({ success: false, message: 'This booking can no longer be edited.' });
  }

  const valid = validateBookingInput(req, res, { excludeId: existing._id });
  if (!valid) return;
  const { facility, date, slot, slotStartMin, slotEndMin, pax } = valid;

  if (await hasConflict(facility.key, date, slotStartMin, slotEndMin, existing._id)) {
    return res.status(409).json({ success: false, message: 'That time slot was just booked by someone else. Please choose another.' });
  }

  existing.date = date; existing.slot = slot; existing.slotStartMin = slotStartMin; existing.slotEndMin = slotEndMin;
  existing.pax  = pax;  existing.notes = (req.body.notes || '').trim();
  await existing.save();
  return res.json({ success: true });
}

// DELETE /api/booking/:id
async function cancel(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const existing = await Booking.findOne({ _id: req.params.id, contact_id: req.resident.contact_id });
  if (!existing) return res.status(404).json({ success: false, message: 'Booking not found.' });
  if (!(LEGAL_TRANSITIONS[existing.status] || []).includes('Cancelled')) {
    return res.status(400).json({ success: false, message: 'This booking has already ended and cannot be cancelled.' });
  }
  existing.status = 'Cancelled';
  await existing.save();
  return res.json({ success: true });
}

// PATCH /api/booking/:id/confirm-deposit - resident taps "I've Completed Payment".
// Only flips Deposit Pending -> Confirmed; anything else is a no-op error, since
// there's no real payment gateway callback to verify against.
async function confirmDeposit(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  await runSweeps();
  const existing = await Booking.findOne({ _id: req.params.id, contact_id: req.resident.contact_id });
  if (!existing) return res.status(404).json({ success: false, message: 'Booking not found.' });
  // Idempotent: a facility with multiple fee line items (e.g. Verandah's booking
  // fee + refundable deposit) confirms each fee separately against the same
  // booking, so the second call arriving after it's already Confirmed is a
  // success no-op, not an error.
  if (existing.status === 'Deposit Pending') {
    existing.status = 'Confirmed';
    existing.depositStatus = 'held'; // money is now actually collected
    await existing.save();
  } else if (existing.cancelReason === 'deposit_expired') {
    return res.status(400).json({ success: false, message: 'The 24-hour deposit window for this booking has passed and it was automatically cancelled. Please make a new booking.' });
  } else if (existing.status !== 'Confirmed') {
    return res.status(400).json({ success: false, message: 'This booking is not awaiting a deposit.' });
  }
  return res.json({ success: true });
}

// GET /api/management/bookings
async function listForManagement(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  await runSweeps();
  const items = await Booking.find({}).sort({ date: 1 }).lean();
  return res.json({
    success: true,
    items: items.map(b => ({
      oppId: String(b._id), facility: b.facilityName, facilityKey: b.facilityKey,
      resident: b.resident_name, unit: b.resident_unit, date: b.date, slot: b.slot, pax: b.pax, stage: b.status,
      depositDueAt: b.depositDueAt || null, cancelReason: b.cancelReason || '',
      depositStatus: b.depositStatus || 'none', depositResolvedAt: b.depositResolvedAt || null, depositNote: b.depositNote || '',
    })),
    stages: ALL_STAGES,
  });
}

// PUT /api/management/bookings/:id/stage
async function updateStage(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const { stage } = req.body || {};
  if (!ALL_STAGES.includes(stage)) return res.status(400).json({ success: false, message: 'Invalid stage.' });
  const existing = await Booking.findById(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Booking not found.' });
  if (stage !== existing.status && !(LEGAL_TRANSITIONS[existing.status] || []).includes(stage)) {
    return res.status(400).json({ success: false, message: `Cannot move a ${existing.status} booking to ${stage}.` });
  }
  // Covers management confirming a deposit manually (e.g. "Mark as Paid") rather
  // than the resident's own confirm-deposit call - either path collects the
  // money, so either path must start the deposit's held/refund/forfeit lifecycle.
  if (stage === 'Confirmed' && existing.depositStatus === 'none') {
    const facility = facilities.facByKey(existing.facilityKey);
    if (facility && facility.deposit) existing.depositStatus = 'held';
  }
  existing.status = stage;
  await existing.save();
  return res.json({ success: true, message: `Booking moved to ${stage}.`, stage });
}

// PUT /api/management/bookings/:id/deposit - resolve a held deposit after the
// event: refund it back, or forfeit it (e.g. facility damage), with a reason.
async function manageDeposit(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const { action, note } = req.body || {};
  if (!['refund', 'forfeit'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Invalid action.' });
  }
  if (action === 'forfeit' && !String(note || '').trim()) {
    return res.status(400).json({ success: false, message: 'A reason is required to forfeit a deposit.' });
  }
  const existing = await Booking.findById(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Booking not found.' });
  if (existing.depositStatus !== 'held') {
    return res.status(400).json({ success: false, message: 'This booking has no held deposit to resolve.' });
  }
  existing.depositStatus = action === 'refund' ? 'refunded' : 'forfeited';
  existing.depositResolvedAt = new Date();
  existing.depositNote = String(note || '').trim();
  await existing.save();
  return res.json({ success: true, depositStatus: existing.depositStatus });
}

module.exports = { availability, listMine, create, update, cancel, confirmDeposit, listForManagement, updateStage, manageDeposit };
