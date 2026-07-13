const mongoose = require('mongoose');
const crypto   = require('crypto');
const Guest    = require('../models/guest.model');
const Booking  = require('../models/booking.model');
const residents = require('../services/residents.service');

const dbReady = () => mongoose.connection.readyState === 1;

const VISITOR_TYPES = ['Social Guest', 'Contractor', 'Delivery', 'Mover', 'Other'];
const STAGES        = ['Registered', 'Checked In', 'Checked Out', 'Departed', 'Closed'];
const LEGAL_TRANSITIONS = {
  'Registered':  ['Checked In', 'Closed'],
  'Checked In':  ['Checked Out', 'Closed'],
  'Checked Out': ['Departed', 'Closed'],
  'Departed':    ['Closed'],
  'Closed':      [],
};
const ACTION_STAGE = { checkin: 'Checked In', checkout: 'Checked Out', depart: 'Departed' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// SGT calendar date - matches facilities.js/move.controller.js's identical helper.
function todaySGT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}

function applyStageTimestamp(doc, stage) {
  if (stage === 'Checked In')  doc.checkedInAt  = new Date();
  if (stage === 'Checked Out') doc.checkedOutAt = new Date();
  if (stage === 'Departed')    doc.departedAt   = new Date();
}

// 4-digit random suffix on the visit date - retries on the (rare) collision
// instead of trusting Math.random() to never repeat within the same day.
async function createUniqueGuest(data) {
  const datePart = String(data.visitDate || todaySGT()).replace(/-/g, '');
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = `GST-${datePart}-${crypto.randomInt(1000, 10000)}`;
    try {
      return await Guest.create({ ...data, reference });
    } catch (err) {
      if (err && err.code === 11000 && attempt < 4) continue;
      throw err;
    }
  }
}

// POST /api/guest - resident self-registration.
async function create(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const { visitor_type, visitor_name, visitor_email, visitor_phone, visit_date, duration, linked_booking_id } = req.body || {};

  if (!VISITOR_TYPES.includes(visitor_type)) return res.status(400).json({ success: false, message: 'Please select a valid visitor type.' });
  const name = String(visitor_name || '').trim();
  if (!name) return res.status(400).json({ success: false, message: 'Visitor name is required.' });
  const email = String(visitor_email || '').trim();
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ success: false, message: 'A valid visitor email is required.' });
  if (!visit_date || visit_date < todaySGT()) return res.status(400).json({ success: false, message: 'Visit date must be today or later.' });

  // Re-check server-side, same as the client gate - a resident could otherwise
  // POST straight past a not-yet-Confirmed booking.
  let linkedFacility = '', linkedDate = '';
  if (linked_booking_id) {
    const booking = await Booking.findOne({ _id: linked_booking_id, contact_id: req.resident.contact_id }).lean();
    if (!booking) return res.status(400).json({ success: false, message: 'Linked booking not found.' });
    if (booking.status !== 'Confirmed') {
      return res.status(400).json({ success: false, message: 'Please wait for the linked booking to be confirmed before registering guests for it.' });
    }
    // Enforce the facility's own headcount (booking.pax, set against the
    // facility's maxPax at booking time) - otherwise "Guest Rules" (max 4 pool
    // guests, etc.) is just text with nothing behind it. Cancelled passes don't
    // count against the cap.
    const linkedCount = await Guest.countDocuments({ linkedBookingId: linked_booking_id, stage: { $ne: 'Closed' } });
    const cap = booking.pax || 1;
    if (linkedCount >= cap) {
      return res.status(400).json({ success: false, message: `This booking's guest limit (${cap}) has already been reached.` });
    }
    linkedFacility = booking.facilityName; linkedDate = booking.date;
  }

  const doc = await createUniqueGuest({
    visitorName: name, visitorEmail: email, visitorPhone: String(visitor_phone || '').trim(),
    visitorType: visitor_type, visitDate: visit_date, duration: duration || 'Single Visit (Day)',
    linkedBookingId: linked_booking_id || '', linkedFacility, linkedDate,
    contact_id: req.resident.contact_id, host_name: req.resident.name, host_email: req.resident.email, host_unit: req.resident.unit,
    createdVia: 'resident', stage: 'Registered',
  });
  return res.json({ success: true, reference: doc.reference, guestId: String(doc._id) });
}

// GET /api/guest/mine - shaped to match the generic opportunity list the
// resident portal's renderRecords() already knows how to display (name carries
// "REF - Visitor (#unit)" so the existing QR-detection regex keeps working).
async function listMine(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const items = await Guest.find({ contact_id: req.resident.contact_id }).sort({ createdAt: -1 }).lean();
  return res.json({
    success: true,
    items: items.map(g => ({
      id: String(g._id),
      name: `${g.reference} - ${g.visitorName} (#${g.host_unit})`,
      stage: g.stage,
      createdAt: g.createdAt,
      customFields: [
        { label: 'Visitor Type', fieldValueString: g.visitorType },
        { label: 'Email',        fieldValueString: g.visitorEmail },
        ...(g.visitorPhone ? [{ label: 'Phone', fieldValueString: g.visitorPhone }] : []),
        { label: 'Duration',     fieldValueString: g.duration },
        ...(g.linkedFacility ? [{ label: 'Linked Booking', fieldValueString: `${g.linkedFacility} - ${g.linkedDate}` }] : []),
      ],
    })),
  });
}

// DELETE /api/guest/:id - resident cancels their own pass, only while it's
// still Registered (nothing to "cancel" once the visitor has actually arrived).
async function cancel(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const existing = await Guest.findOne({ _id: req.params.id, contact_id: req.resident.contact_id });
  if (!existing) return res.status(404).json({ success: false, message: 'Guest pass not found.' });
  if (existing.stage !== 'Registered') {
    return res.status(400).json({ success: false, message: 'This guest pass can no longer be cancelled.' });
  }
  existing.stage = 'Closed';
  await existing.save();
  return res.json({ success: true });
}

// GET /api/management/contacts/search?q= - resident (host) typeahead for the
// management guest desk.
async function searchContacts(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const contacts = await residents.searchResidents(req.query.q, 8);
  return res.json({ success: true, contacts });
}

// POST /api/management/guest - front desk registers on a resident's behalf.
async function createByManagement(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const {
    host_contact_id, host_name, host_email, host_unit,
    visitor_type, visitor_name, visitor_ic, visitor_vehicle,
    visit_date, visit_time, link_facility, notes,
  } = req.body || {};

  const contactId = String(host_contact_id || '').trim();
  if (!contactId) return res.status(400).json({ success: false, message: 'Please search and select the resident (host) first.' });
  const name = String(visitor_name || '').trim();
  if (!name || !visit_date) return res.status(400).json({ success: false, message: 'Visitor name and visit date are required.' });

  const doc = await createUniqueGuest({
    visitorName: name, visitorType: VISITOR_TYPES.includes(visitor_type) ? visitor_type : 'Other',
    visitDate: visit_date, visitTime: String(visit_time || ''), duration: 'Single Visit (Day)',
    visitorIc: String(visitor_ic || '').trim(), visitorVehicle: String(visitor_vehicle || '').trim(),
    notes: String(notes || '').trim(), linkedFacility: link_facility || '', linkedDate: visit_date,
    contact_id: contactId, host_name: host_name || '', host_email: host_email || '', host_unit: host_unit || '',
    createdVia: 'management', stage: 'Registered',
  });
  return res.json({ success: true, reference: doc.reference, guestId: String(doc._id) });
}

// GET /api/management/guests
async function listForManagement(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const items = await Guest.find({}).sort({ createdAt: -1 }).lean();
  return res.json({
    success: true,
    items: items.map(g => ({
      oppId: String(g._id), visitor: g.visitorName, host: g.host_name, unit: g.host_unit,
      phone: g.visitorPhone, stage: g.stage, visitDate: g.visitDate, createdAt: g.createdAt,
    })),
    stages: STAGES,
  });
}

// PUT /api/management/guests/:id/stage
async function updateStage(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const { stage } = req.body || {};
  if (!STAGES.includes(stage)) return res.status(400).json({ success: false, message: 'Invalid stage.' });
  const existing = await Guest.findById(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Guest not found.' });
  if (stage !== existing.stage && !(LEGAL_TRANSITIONS[existing.stage] || []).includes(stage)) {
    return res.status(400).json({ success: false, message: `Cannot move a ${existing.stage} guest to ${stage}.` });
  }
  applyStageTimestamp(existing, stage);
  existing.stage = stage;
  await existing.save();
  return res.json({ success: true, message: `Guest moved to ${stage}.`, stage });
}

// GET /api/guardhouse/lookup?reference=
async function guardLookup(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const reference = String(req.query.reference || '').trim();
  if (!reference) return res.json({ success: true, found: false });
  const g = await Guest.findOne({ reference });
  if (!g) return res.json({ success: true, found: false });
  return res.json({
    success: true, found: true, reference: g.reference, visitor: g.visitorName,
    hostUnit: g.host_unit, hostContactId: g.contact_id, opportunityId: String(g._id),
    visitDate: g.visitDate, stage: g.stage,
  });
}

// POST /api/guardhouse/checkin - matched by reference/guest id, never by host
// contact alone (a resident with two open passes must not risk the wrong one
// flipping stage).
async function guardCheckin(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const { reference, opportunity_id, action } = req.body || {};
  const stage = ACTION_STAGE[action];
  if (!stage) return res.status(400).json({ success: false, message: 'Invalid action.' });

  const ref   = String(reference || '').trim();
  const oppId = String(opportunity_id || '').trim();
  if (!ref && !oppId) return res.status(400).json({ success: false, message: 'A reference or guest id is required.' });

  const query = oppId && mongoose.isValidObjectId(oppId) ? { _id: oppId } : { reference: ref };
  const existing = await Guest.findOne(query);
  if (!existing) return res.status(404).json({ success: false, message: 'Guest pass not found.' });
  if (!(LEGAL_TRANSITIONS[existing.stage] || []).includes(stage)) {
    return res.status(400).json({ success: false, message: `Cannot ${action} a ${existing.stage} guest.` });
  }
  applyStageTimestamp(existing, stage);
  existing.stage = stage;
  await existing.save();
  return res.json({ success: true, stage: existing.stage });
}

module.exports = {
  create, listMine, cancel, searchContacts, createByManagement, listForManagement, updateStage,
  guardLookup, guardCheckin,
};
