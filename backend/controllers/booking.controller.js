const mongoose = require('mongoose');
const ghl = require('../services/ghl.service');
const { getPipeline } = require('../config/pipelines');
const Booking = require('../models/booking.model');

// Bookings are persisted in MongoDB (the resident-facing source of truth). Guard
// every DB call — Mongo is non-fatal, so a booking action never fails just because
// the DB is briefly unavailable (GHL still gets the appointment/opportunity).
const mongoReady = () => mongoose.connection && mongoose.connection.readyState === 1;

// Map a persisted Booking document → the row shape both portals' frontends expect.
function bookingDocToRow(d) {
  return {
    id:           d.ghlAppointmentId || String(d._id),
    facilityKey:  d.facilityKey,
    facility:     d.facilityName || d.facilityKey,
    facilityName: d.facilityName || d.facilityKey,
    emoji:        d.emoji || '',
    resident:     d.residentName || 'Resident',
    unit:         d.unit || '',
    pax:          d.pax || 1,
    date:         d.date,
    slot:         d.slot,
    notes:        d.notes || '',
    status:       d.status || 'Confirmed',
    stage:        d.status || 'Confirmed',
    oppId:        d.ghlOppId || '',
    contactId:    d.contactId || '',
  };
}

// Overlay the live GHL facility-pipeline stage onto Mongo booking rows, so a stage
// move made in management (which updates the GHL opportunity) reflects in both
// portals. Best-effort: on any GHL failure the rows keep their stored Mongo status.
// A row already marked "Cancelled" stays Cancelled (its slot/appointment is gone).
async function overlayGhlStage(rows) {
  if (!rows.length || !ghl.isConfigured()) return rows;
  const fp = getPipeline('facility');
  const stageNames = Object.fromEntries(Object.entries(fp.stages).map(([k, v]) => [v, k]));
  const contactIds = [...new Set(rows.map(r => r.contactId).filter(Boolean))];
  const oppsByContact = new Map();
  try {
    const params = { location_id: ghl.LOCATION, pipeline_id: fp.id, limit: 100 };
    if (contactIds.length === 1) params.contact_id = contactIds[0];
    const data = await ghl.ghlGet('/opportunities/search', { params });
    (data.opportunities || []).forEach(o => {
      const cid = (o.contact && o.contact.id) || o.contactId || '';
      if (!cid) return;
      const arr = oppsByContact.get(cid) || [];
      arr.push({ oppId: o.id, name: o.name || '', createdAt: o.createdAt, stageId: o.pipelineStageId, stage: stageNames[o.pipelineStageId] || o.status || '' });
      oppsByContact.set(cid, arr);
    });
  } catch (e) {
    console.warn('[bookings] stage overlay failed (keeping stored status):', e.response?.data?.message || e.message);
    return rows;
  }
  // A deposit-facility booking is only genuinely "Confirmed" once its deposit is on
  // record. The GHL "Facility Booking — New" workflow can create/leave the opportunity
  // at "Confirmed" before any payment, which would wrongly drop the booking into
  // Payment History instead of "Pending Deposit". So for deposit facilities we hold
  // the row at "Deposit Pending" until a paid Payment is found for its opportunity.
  const paidRefs = new Set();
  if (rows.some(r => DEPOSIT_FACILITIES.has(r.facilityKey)) && mongoReady()) {
    try {
      const Payment = require('../models/payment.model');
      const pays = await Payment.find({ contact_id: { $in: contactIds }, status: 'paid' })
        .select('opportunity_id reference').lean();
      pays.forEach(p => {
        if (p.opportunity_id) paidRefs.add(String(p.opportunity_id));
        if (p.reference)      paidRefs.add(String(p.reference).toUpperCase());
      });
    } catch (e) {
      console.warn('[bookings] payment lookup failed (treating deposits as unpaid):', e.message);
    }
  }
  // Payment references embed the opportunity id tail (DEP-<tail>[-FEE]); also match the
  // raw opportunity_id, so both resident-paid and webhook-confirmed payments are found.
  const depositPaid = (oppId) => {
    if (!oppId) return false;
    if (paidRefs.has(String(oppId))) return true;
    const tail = String(oppId).slice(-6).toUpperCase();
    for (const ref of paidRefs) if (ref.includes(tail)) return true;
    return false;
  };

  const usedByContact = new Map();
  const assign = (r, opp) => {
    const used = usedByContact.get(r.contactId) || new Set();
    used.add(opp.oppId); usedByContact.set(r.contactId, used);
    r.oppId = opp.oppId;
    let stage = opp.stage;
    // Don't show an unpaid deposit booking as Confirmed/Completed — keep it pending
    // so the resident still sees the "Pay Deposit" card.
    if (DEPOSIT_FACILITIES.has(r.facilityKey) && ['Confirmed', 'Completed'].includes(stage) && !depositPaid(opp.oppId)) {
      stage = 'Deposit Pending';
    }
    if (r.status !== 'Cancelled') r.status = stage;
    r.stage = r.status;
  };
  // Phase 1 — strict: exact facility+date match ensures newer bookings aren't
  // displaced by older ones that share the same facility.
  for (const r of rows) {
    if (!r.contactId || !r.date) continue;
    const fac   = r.facility.toLowerCase();
    const used  = usedByContact.get(r.contactId) || new Set();
    const cands = (oppsByContact.get(r.contactId) || []).filter(o => !used.has(o.oppId));
    const strict = cands.filter(o => { const n = (o.name || '').toLowerCase(); return n.includes(fac) && n.includes(r.date); });
    const opp = strict.find(o => !['Confirmed','Completed','No-Show','Cancelled'].includes(o.stage)) || strict[0];
    if (opp) assign(r, opp);
  }
  // Phase 2 — loose: remaining unmatched rows fall back to facility-or-date match.
  for (const r of rows) {
    if (r.oppId) continue;
    const used  = usedByContact.get(r.contactId) || new Set();
    const cands = (oppsByContact.get(r.contactId) || []).filter(o => !used.has(o.oppId));
    const opp   = pickOpp(cands, { facility: r.facility, date: r.date });
    if (opp) assign(r, opp);
  }
  return rows;
}

// Calendar IDs per facility — hardcoded defaults, overridable via Railway env vars.
const CALENDARS = {
  pool:       process.env.MERIDIAN_CAL_POOL       || 'demo-cal-pool',
  tennis:     process.env.MERIDIAN_CAL_TENNIS     || 'demo-cal-tennis',
  squash:     process.env.MERIDIAN_CAL_SQUASH     || 'demo-cal-squash',
  basketball: process.env.MERIDIAN_CAL_BASKETBALL || 'demo-cal-basketball',
  gym:        process.env.MERIDIAN_CAL_GYM        || 'demo-cal-gym',
  fitness:    process.env.MERIDIAN_CAL_FITNESS    || 'demo-cal-fitness',
  bbq:        process.env.MERIDIAN_CAL_BBQ        || 'demo-cal-bbq',
  verandah:   process.env.MERIDIAN_CAL_VERANDAH   || 'demo-cal-verandah',
  lift:       process.env.MERIDIAN_CAL_LIFT       || 'demo-cal-lift',
};

// Contact custom-field IDs (verified from GHL) the booking writes back so the
// Facility Bookings workflow + opportunity have clean, structured data.
const FIELD = {
  ghlAppointmentId: 'demo-field-appointment-id',
  bookingPax:       'demo-field-booking-pax',
  guestCount:       'demo-field-guest-count',
  bookingDate:      'demo-field-booking-date',
};

// Facilities that require a refundable deposit before confirmation.
const DEPOSIT_FACILITIES = new Set(['verandah', 'bbq', 'pool']);

// GHL Inbound Webhook that triggers the Facility Bookings workflow.
const FACILITY_WEBHOOK = process.env.MERIDIAN_WEBHOOK_FACILITY || '';

// Parse "9:15 AM" → total minutes.
function parseTime(str) {
  const [time, ap] = str.trim().split(' ');
  const [h, m]     = time.split(':').map(Number);
  const hours = ap === 'PM' && h !== 12 ? h + 12 : ap === 'AM' && h === 12 ? 0 : h;
  return { hours, minutes: m };
}

// "2026-06-05" + "9:15 AM – 10:15 AM" → SGT ISO strings.
function toISO(date, slot) {
  const [startStr, endStr] = slot.split(' – ');
  const fmt = ({ hours, minutes }) =>
    `${date}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00+08:00`;
  return { startTime: fmt(parseTime(startStr)), endTime: fmt(parseTime(endStr)) };
}

// Epoch ms → minutes-of-day in Singapore time (e.g. 15:45 → 945).
function sgtMinutes(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const h = Number(parts.find(p => p.type === 'hour').value);
  const m = Number(parts.find(p => p.type === 'minute').value);
  return h * 60 + m;
}

// Fetch confirmed appointments for a calendar on a given SGT date and return their
// busy time ranges (epoch ms). GHL is the shared source of truth, so this blocks
// double-booking across ALL residents. Used by the availability endpoint and the
// authoritative overlap guard in createBooking.
async function getBusyRanges(calendarId, date, excludeId = '') {
  const startMs = new Date(`${date}T00:00:00+08:00`).getTime();
  const endMs   = new Date(`${date}T23:59:59+08:00`).getTime();
  const data = await ghl.ghlGet('/calendars/events', {
    version: '2021-04-15',
    params:  { locationId: ghl.LOCATION, calendarId, startTime: startMs, endTime: endMs },
  });
  const events = data.events || (Array.isArray(data) ? data : []);
  return events
    .filter(e => String(e.appointmentStatus || e.status || '').toLowerCase() !== 'cancelled')
    // When editing, exclude the booking's own appointment so its current slot
    // isn't reported as busy against itself.
    .filter(e => !excludeId || String(e.id) !== String(excludeId))
    .map(e => ({ startMs: new Date(e.startTime).getTime(), endMs: new Date(e.endTime).getTime() }))
    .filter(r => Number.isFinite(r.startMs) && Number.isFinite(r.endMs));
}

// Community events (Announcements with blocked_facilities) can reserve a facility
// for a time window. Return those windows for a facility on an SGT date as
// minute-of-day ranges, so the availability endpoint can disable them exactly like
// booked slots. Mirrors the authoritative event guard in createBooking. Sourced
// from Mongo, so it applies independently of GHL availability.
async function getEventBlockRanges(facilityKey, date) {
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) return [];
  const Announcement = require('../models/announcement.model');
  const dayStartMs = new Date(`${date}T00:00:00+08:00`).getTime();
  const dayEndMs   = dayStartMs + 24 * 60 * 60 * 1000; // next SGT midnight (exclusive)
  // Overlap with the requested day: event starts before day ends AND ends after day starts.
  const events = await Announcement.find({
    active:             true,
    blocked_facilities: facilityKey,
    eventAt:            { $lt: new Date(dayEndMs)   },
    eventEndAt:         { $gt: new Date(dayStartMs) },
  }).select('eventAt eventEndAt').lean();
  return events.map(e => {
    const startMs = Math.max(new Date(e.eventAt).getTime(),    dayStartMs);
    const endMs   = Math.min(new Date(e.eventEndAt).getTime(), dayEndMs);
    if (!(startMs < endMs)) return null;
    return { start: sgtMinutes(startMs), end: endMs >= dayEndMs ? 1440 : sgtMinutes(endMs) };
  }).filter(Boolean);
}

// Resolve a GHL contact id for THIS location from the backend account data.
// Residents authenticate against the backend account list (auth.model.js) — they
// may not exist in GHL at all, or may carry a stale/placeholder ghl_contact_id.
// So we upsert by email to guarantee a valid contact for this location before
// booking, rather than trusting whatever contact_id the portal session sends.
// GHL appointments require a valid contactId, so this is what makes a resident
// bookable without being pre-existing in the GHL contact list.
async function resolveContactId({ contact_id, member_email, member_name, member_unit }) {
  // Identity is keyed by EMAIL — never the (possibly stale) stored/session contact_id.
  // The GHL contact is created lazily here on first action and is the SAME contact the
  // resident portal resolves on read, so bookings always show up for every resident.
  if (member_email) {
    try {
      const parts     = String(member_name || '').trim().split(/\s+/).filter(Boolean);
      const firstName = parts.shift() || 'Resident';
      const lastName  = parts.join(' ');
      const body = {
        locationId: ghl.LOCATION,
        email:      member_email,
        firstName,
        ...(lastName    ? { lastName }                                              : {}),
        ...(member_unit ? { address1: `#${String(member_unit).replace(/^#/, '')}` } : {}),
      };
      const data = await ghl.ghlPost('/contacts/upsert', body, { version: '2021-07-28' });
      const id   = data.contact?.id || data.id || null;
      if (id) {
        console.log(`[booking] resolved GHL contact ${id} via upsert (${member_email})`);
        return id;
      }
    } catch (e) {
      console.warn('[booking] contact upsert failed:', e.response?.data?.message || e.message);
    }
  }
  // Fall back to the session contact id the portal carried (set at login).
  return contact_id || null;
}

// GHL appointments require an assignedUserId (the staff/team member who owns the
// slot) — a resident is a contact, not a GHL user, so it can't be the assignee.
// Resolve the calendar's configured team member instead. An env override
// (MERIDIAN_BOOKING_USER) wins; otherwise we read the calendar once and cache
// its first team member. The resident is still tied to the booking via contactId
// and the appointment title.
const _calUserCache = {};
async function resolveAssignedUserId(calendarId) {
  if (process.env.MERIDIAN_BOOKING_USER) return process.env.MERIDIAN_BOOKING_USER;
  if (_calUserCache[calendarId]) return _calUserCache[calendarId];
  try {
    const data    = await ghl.ghlGet(`/calendars/${calendarId}`, { version: '2021-04-15' });
    const cal     = data.calendar || data;
    const members = cal.teamMembers || cal.teamMemberIds || [];
    const id      = members[0]?.userId || (typeof members[0] === 'string' ? members[0] : null);
    if (id) { _calUserCache[calendarId] = id; return id; }
  } catch (e) {
    console.warn('[booking] could not resolve calendar team member:', e.response?.data?.message || e.message);
  }
  return null;
}

// POST /api/booking
async function createBooking(req, res) {
  const {
    facilityKey, facilityName, emoji,
    date, slot, pax, notes,
    contact_id, member_name, member_email, member_unit,
  } = req.body || {};

  console.log(`[booking] → createBooking: facility=${facilityKey} date=${date} email=${member_email || '(none)'}`);

  if (!facilityKey || !date || !slot) {
    return res.status(400).json({ success: false, message: 'facilityKey, date, and slot are required.' });
  }

  const calendarId = CALENDARS[facilityKey];
  if (!calendarId) {
    console.warn(`[booking] unknown facilityKey: ${facilityKey}`);
    return res.status(400).json({ success: false, message: `Unknown facility key: ${facilityKey}` });
  }

  if (!ghl.isConfigured()) {
    return res.status(503).json({ success: false, message: 'GHL API key not configured on the server.' });
  }

  let times;
  try { times = toISO(date, slot); }
  catch { return res.status(400).json({ success: false, message: 'Invalid date or slot format.' }); }

  // Authoritative double-booking guard — reject if the requested range overlaps an
  // existing appointment on this calendar/date. Protects against stale UIs and two
  // residents booking the same slot at once. Two ranges overlap when each starts
  // before the other ends.
  try {
    const reqStart = new Date(times.startTime).getTime();
    const reqEnd   = new Date(times.endTime).getTime();
    const clash = (await getBusyRanges(calendarId, date)).find(r => reqStart < r.endMs && reqEnd > r.startMs);
    if (clash) {
      return res.status(409).json({ success: false, message: 'That time slot has already been booked. Please choose another.' });
    }
  } catch (e) {
    // GHL unreachable here would also fail the create below; proceed and let that surface.
    console.warn('[booking] overlap check failed (proceeding):', e.response?.data?.message || e.message);
  }

  // Block if a community event has reserved this facility for the requested window.
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      const Announcement = require('../models/announcement.model');
      const reqStart = new Date(times.startTime);
      const reqEnd   = new Date(times.endTime);
      const block = await Announcement.findOne({
        active:             true,
        blocked_facilities: facilityKey,
        eventAt:            { $lt: reqEnd   },
        eventEndAt:         { $gt: reqStart },
      }).lean();
      if (block) {
        const NAMES = { pool: 'Swimming Pool', tennis: 'Tennis Court', squash: 'Squash Court', basketball: 'Basketball Court', gym: 'Gymnasium', fitness: 'Fitness Studio', bbq: 'BBQ Pit', verandah: 'Verandah', lift: 'Service Lift' };
        return res.status(409).json({
          success: false,
          message: `The ${NAMES[facilityKey] || facilityKey} is reserved for "${block.title}" during this time. Please choose a different time.`,
        });
      }
    }
  } catch (e) {
    console.warn('[booking] event block check failed (proceeding):', e.message);
  }

  // Always resolve a fresh, valid GHL contact for this location from the backend
  // account data — never trust the (possibly stale) contact_id the portal sends.
  const resolvedContactId = await resolveContactId({ contact_id, member_email, member_name, member_unit });

  // Calendar appointments require an assigned team member (GHL user).
  const assignedUserId = await resolveAssignedUserId(calendarId);
  console.log(`[booking] assignedUserId=${assignedUserId || 'NULL'} calendarId=${calendarId}`);
  if (!assignedUserId) {
    return res.status(400).json({
      success: false,
      message: 'No team member is assigned to this facility calendar. Set MERIDIAN_BOOKING_USER or add a team member to the calendar in GHL.',
    });
  }

  const unitLabel  = member_unit ? ` (#${member_unit})` : '';
  const slotStart  = (slot || '').split(' – ')[0].trim();
  // Appointment title keeps resident name so management calendar/portal parses correctly.
  const title      = `${facilityName || facilityKey} — ${member_name || 'Resident'}${unitLabel}`;
  // Opportunity name carries booking details for the resident payment card.
  const oppName    = `${facilityName || facilityKey} — ${date} ${slotStart}${unitLabel} · ${pax || 1} pax`;
  const noteLines = [
    `Pax: ${pax || 1}`,
    notes        ? `Notes: ${notes}`               : null,
    member_email ? `Email: ${member_email}`         : null,
  ].filter(Boolean).join('\n');

  const payload = {
    calendarId,
    locationId:        ghl.LOCATION,
    startTime:         times.startTime,
    endTime:           times.endTime,
    title,
    appointmentStatus: 'confirmed',
    address:           'The Meridian, Singapore',
    // The portal generates its own slots client-side (15-min start intervals,
    // facility-specific open/close hours) which do NOT match the GHL calendar's
    // configured slot interval/duration/availability window. Without these flags
    // GHL validates the requested time against its own free slots and rejects it
    // with "The slot you have selected is no longer available." The portal is the
    // source of truth for availability here, so we instruct GHL to honor the exact
    // times we send rather than its own slot grid.
    ignoreFreeSlotValidation: true,
    ignoreDateRange:          true,
    assignedUserId,
    ...(resolvedContactId ? { contactId: resolvedContactId } : {}),
    ...(noteLines         ? { notes: noteLines }              : {}),
  };

  try {
    // Calendar appointments use the 2021-04-15 API version.
    const data = await ghl.ghlPost('/calendars/events/appointments', payload, { version: '2021-04-15' });

    const appointmentId = data.id || data.appointment?.id || null;

    if (!appointmentId) {
      // GHL returned HTTP 2xx but the response carries no appointment id — the slot
      // or calendar config was rejected silently rather than with a 4xx status.
      const reason = data.message || data.msg || data.error || 'GHL did not return an appointment ID.';
      console.error('[booking] GHL silent rejection. Payload:', JSON.stringify(data).slice(0, 500));
      const e = new Error(String(reason));
      e.response = { status: 422, data };
      throw e;
    }

    console.log(`[booking] Created GHL appointment ${appointmentId} for ${facilityKey} on ${date}`);

    // Persist the booking in MongoDB — the resident-facing source of truth (shared
    // across devices + both portals, unlike the old per-browser localStorage).
    // Non-fatal: the GHL appointment already exists, so a DB hiccup must not fail it.
    if (mongoReady()) {
      try {
        await Booking.create({
          contactId:        resolvedContactId || contact_id || '',
          email:            (member_email || '').toLowerCase(),
          unit:             member_unit || '',
          residentName:     member_name || '',
          facilityKey,
          facilityName:     facilityName || facilityKey,
          emoji:            emoji || '',
          date, slot,
          pax:              pax || 1,
          notes:            notes || '',
          status:           DEPOSIT_FACILITIES.has(facilityKey) ? 'Deposit Pending' : 'Confirmed',
          ghlAppointmentId: appointmentId,
        });
        console.log(`[booking] saved to Mongo (appt ${appointmentId})`);
      } catch (e) {
        console.warn('[booking] Mongo save failed (non-fatal):', e.message);
      }
    } else {
      console.warn('[booking] Mongo not connected — booking NOT persisted to DB.');
    }

    // Write structured booking data back to the contact so the Facility Bookings
    // workflow can populate the opportunity cleanly. Awaited so it completes
    // before the webhook fires, but non-fatal — a failure here must never fail
    // the booking itself.
    if (resolvedContactId) {
      try {
        await ghl.ghlPut(`/contacts/${resolvedContactId}`, {
          customFields: [
            { id: FIELD.ghlAppointmentId, field_value: appointmentId || '' },
            { id: FIELD.bookingPax,       field_value: String(pax || 1) },
            { id: FIELD.guestCount,       field_value: String(pax || 1) },
            { id: FIELD.bookingDate,      field_value: date },
          ],
        });
      } catch (e) {
        console.warn('[booking] contact field write failed (non-fatal):', e.response?.data?.message || e.message);
      }
    }

    // The "Facility Booking — New" workflow OWNS opportunity creation (a single
    // Create-or-Update with duplicates OFF → exactly ONE card per booking). The
    // backend no longer creates the opp here — doing both produced two cards at
    // Deposit Pending. We pass the canonical opp name so the workflow names the
    // card consistently (the resident portal parses date/slot/pax from it).
    const needsDeposit = DEPOSIT_FACILITIES.has(facilityKey);

    // Fire the GHL inbound webhook that drives the Facility Bookings workflow
    // (opportunity creation + notifications + emails). Awaited so failures surface;
    // still non-fatal so the booking/appointment stays intact.
    let pipelineConnected = false;
    if (FACILITY_WEBHOOK) {
      try {
        await ghl.postWebhook(FACILITY_WEBHOOK, {
          event: 'facility_booking', facility_key: facilityKey, facility_name: facilityName || facilityKey,
          date, slot, start_time: times.startTime, end_time: times.endTime,
          pax: pax || 1, notes: notes || '', requires_deposit: needsDeposit,
          opp_name: oppName,
          appointment_id: appointmentId || '', calendar_id: calendarId,
          contact_id: resolvedContactId || '', member_name: member_name || '',
          member_email: member_email || '', member_unit: member_unit || '',
        });
        pipelineConnected = true;
      } catch (e) {
        console.warn('[booking] webhook failed (non-fatal):', e.response?.data?.message || e.message);
      }
    } else {
      console.warn('[booking] MERIDIAN_WEBHOOK_FACILITY not set — booking NOT connected to the pipeline.');
    }

    return res.json({ success: true, message: 'Booking confirmed.', appointmentId, calendarId, pipelineConnected });

  } catch (err) {
    const status  = err.response?.status;
    const message = err.response?.data?.message || err.message || 'GHL API error.';
    console.error(`[booking] GHL error ${status}:`, message);
    return res.status(status || 502).json({ success: false, message: `Booking failed: ${message}` });
  }
}

// GET /api/booking/availability?facilityKey=&date= — busy slot ranges (SGT minutes)
// for a facility on a date, so the portal can disable already-booked slots.
async function getAvailability(req, res) {
  const { facilityKey, date, exclude } = req.query || {};
  if (!facilityKey || !date) {
    return res.status(400).json({ success: false, message: 'facilityKey and date are required.' });
  }
  const calendarId = CALENDARS[facilityKey];
  if (!calendarId) {
    return res.status(400).json({ success: false, message: `Unknown facility key: ${facilityKey}` });
  }
  // Community-event blocks come from Mongo and apply even when GHL is unavailable.
  let eventBusy = [];
  try { eventBusy = await getEventBlockRanges(facilityKey, date); }
  catch (e) { console.warn('[booking] event-block availability failed:', e.message); }

  // Fail OPEN on GHL (return only event blocks) if GHL is down/unconfigured — the
  // portal stays usable and the authoritative guard in createBooking still prevents
  // double-booking.
  if (!ghl.isConfigured()) return res.json({ success: true, busy: eventBusy });
  try {
    // `exclude` = the appointment id being edited, so its own slot stays selectable.
    const busy = (await getBusyRanges(calendarId, date, exclude || ''))
      .map(r => ({ start: sgtMinutes(r.startMs), end: sgtMinutes(r.endMs) }));
    return res.json({ success: true, busy: busy.concat(eventBusy) });
  } catch (err) {
    console.warn('[booking] availability fetch failed:', err.response?.data?.message || err.message);
    return res.json({ success: true, busy: eventBusy });
  }
}

// Friendly facility labels for the management bookings list (also the set of
// calendars treated as "facilities" — excludes the 'lift' calendar, which is the
// Move panel's domain).
const FACILITY_NAMES = {
  pool: 'Swimming Pool', tennis: 'Tennis Court', squash: 'Squash Court',
  basketball: 'Basketball Court', gym: 'Gymnasium', fitness: 'Fitness Room',
  bbq: 'BBQ Pit', verandah: 'The Verandah',
};

// "9:45 AM" style SGT time from epoch ms.
function fmtSgtTime(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ms));
}

// Parse a GHL calendar event → structured booking row. Appointment titles are
// "<Facility> — <Resident> (#<unit>)" and notes carry "Pax: N" (see createBooking).
function parseBookingEvent(e, facilityKey) {
  const startMs = new Date(e.startTime).getTime();
  const endMs   = new Date(e.endTime).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const title    = e.title || '';
  const tail     = title.includes('—') ? title.split('—').slice(1).join('—').trim() : title.trim();
  const um       = tail.match(/\(#?([^)]+)\)\s*$/);
  const unit     = um ? um[1].trim() : '';
  const resident = tail.replace(/\s*\(#?[^)]+\)\s*$/, '').trim() || 'Resident';
  const pm       = String(e.notes || '').match(/Pax:\s*(\d+)/i);
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(startMs));
  return {
    id:        e.id,
    facilityKey,
    facility:  FACILITY_NAMES[facilityKey] || facilityKey,
    resident, unit,
    pax:       pm ? Number(pm[1]) : null,
    date,
    start:     fmtSgtTime(startMs),
    end:       fmtSgtTime(endMs),
    slot:      `${fmtSgtTime(startMs)} – ${fmtSgtTime(endMs)}`,
    startMs, endMs,
    // Pipeline stage (the real, management-controlled status) and the linked GHL
    // opportunity id are filled in by getAllBookings. The calendar appointment's
    // own status is NOT used — it's always "confirmed" and not the booking lifecycle.
    // Default to Confirmed; the overlay below corrects unmatched deposit bookings.
    stage:     'Confirmed',
    stageId:   null,
    oppId:     null,
    contactId: (e.contact && e.contact.id) || e.contactId || '',
  };
}

// Reconstruct a booking row from a Facility Bookings opportunity whose calendar
// appointment was DELETED on cancellation (so it no longer appears as a calendar
// event). The opp name is the canonical "<Facility> — <YYYY-MM-DD> <start> (#unit) ·
// N pax" set in createBooking. Best-effort; returns null if the date can't be parsed.
function oppToBookingRow(opp, contactId) {
  const name  = String(opp.name || '');
  const dateM = name.match(/(\d{4}-\d{2}-\d{2})/);
  if (!dateM) return null;
  const date        = dateM[1];
  const facName     = (name.split('—')[0] || '').trim();
  const facilityKey = Object.keys(FACILITY_NAMES).find(k => FACILITY_NAMES[k] === facName) || '';
  const timeM       = name.replace(/\s+/g, ' ').match(/(\d{1,2}:\d{2}) ?([AP]M)/i);
  const slotStart   = timeM ? `${timeM[1]} ${timeM[2].toUpperCase()}` : '';
  const unitM       = name.match(/\(#?([^)]+)\)/);
  const paxM        = name.match(/(\d+)\s*pax/i);
  let startMs;
  try {
    const t = slotStart ? parseTime(slotStart) : { hours: 0, minutes: 0 };
    startMs = new Date(`${date}T${String(t.hours).padStart(2, '0')}:${String(t.minutes).padStart(2, '0')}:00+08:00`).getTime();
  } catch { startMs = new Date(`${date}T00:00:00+08:00`).getTime(); }
  if (!Number.isFinite(startMs)) return null;
  return {
    id:        opp.oppId,
    facilityKey,
    facility:  facName || facilityKey,
    resident:  opp.contactName || 'Resident',
    unit:      unitM ? unitM[1].trim() : '',
    pax:       paxM ? Number(paxM[1]) : null,
    date,
    start:     slotStart,
    end:       '',
    slot:      slotStart || '—',
    startMs,
    endMs:     startMs,
    stage:     'Cancelled',
    stageId:   opp.stageId,
    oppId:     opp.oppId,
    contactId,
  };
}

// Pick the best facility-pipeline opportunity for a booking from a contact's
// candidates: prefer one whose name references this booking's facility or date,
// else the most recently created.
function pickOpp(candidates, booking) {
  if (!candidates || !candidates.length) return null;
  const fac = booking.facility.toLowerCase();
  const DONE = new Set(['Confirmed', 'Completed', 'No-Show', 'Cancelled']);
  const prefer = o => !DONE.has(o.stage);
  // Strict match: opp name contains BOTH the facility and the booking date.
  // This prevents an older booking from consuming a newer opp that matches only
  // by facility name (greedy date-sorted assignment would otherwise steal the opp).
  if (booking.date) {
    const strict = candidates.filter(o => {
      const n = (o.name || '').toLowerCase();
      return n.includes(fac) && n.includes(booking.date);
    });
    if (strict.length) return strict.find(prefer) || strict[0];
  }
  // Loose fallback: facility OR date (original behaviour for opps without a date in their name).
  const matched = candidates.filter(o => {
    const n = (o.name || '').toLowerCase();
    return n.includes(fac) || (booking.date && n.includes(booking.date));
  });
  return matched.length ? (matched.find(prefer) || matched[0]) : null;
}

// Find an opportunity GHL's appointment workflow just auto-created for this
// contact+facility (so we re-stage it instead of creating a duplicate). "Fresh"
// = created in the last few minutes, so we never hijack an older real booking.
async function findFreshFacilityOpp({ fp, contactId, facilityKey, facilityName }) {
  if (!contactId) return null;
  const FRESH_MS = 5 * 60 * 1000;
  const facMatch = [facilityKey, facilityName].filter(Boolean).map(s => String(s).toLowerCase());
  try {
    const data = await ghl.ghlGet('/opportunities/search', {
      params: { location_id: ghl.LOCATION, pipeline_id: fp.id, contact_id: contactId, limit: 100 },
    });
    // Keywords that belong to OTHER deposit facilities — opps containing these must
    // not be adopted for this booking (prevents cross-facility opp hijacking).
    const OTHER_FAC_KEYWORDS = [
      ...(['verandah'].filter(k => !facMatch.includes(k))),
      ...(['bbq', 'barbeque', 'barbecue'].filter(k => !facMatch.some(f => f.includes('bbq') || f.includes('barbeque')))),
      ...(['pool', 'swimming'].filter(k => !facMatch.some(f => f.includes('pool') || f.includes('swimming')))),
    ];
    const candidates = (data.opportunities || [])
      .filter(o => String((o.contact && o.contact.id) || o.contactId || '') === String(contactId))
      .filter(o => {
        if (!o.createdAt || (Date.now() - new Date(o.createdAt).getTime()) >= FRESH_MS) return false;
        const n = String(o.name || '').toLowerCase();
        // Reject opps that clearly belong to a different deposit facility.
        return !OTHER_FAC_KEYWORDS.some(k => n.includes(k));
      })
      .sort((a, b) => {
        // Named matches for this facility come first; fallback to most-recent.
        const an = facMatch.some(f => String(a.name || '').toLowerCase().includes(f));
        const bn = facMatch.some(f => String(b.name || '').toLowerCase().includes(f));
        if (an !== bn) return an ? -1 : 1;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
    return candidates[0] || null;
  } catch (e) {
    console.warn('[booking] fresh-opp search failed:', e.response?.data?.message || e.message);
    return null;
  }
}

// Resolve the live GHL pipeline + stage id for a stage name (pipelines.js ids can
// drift). Cached per process. Falls back to null so callers use the configured id.
let _liveStageCache = {};
async function resolveLiveFacilityStage(fp, stageName) {
  const ck = `${fp.id}_${stageName}`;
  if (_liveStageCache[ck]) return _liveStageCache[ck];
  try {
    const pData = await ghl.ghlGet('/opportunities/pipelines', { params: { locationId: ghl.LOCATION } });
    const pl = (pData.pipelines || []).find(p => p.id === fp.id) || (pData.pipelines || []).find(p => p.name === fp.name);
    const st = pl && (pl.stages || []).find(s => s.name === stageName);
    if (pl && st) { _liveStageCache[ck] = { pipelineId: pl.id, stageId: st.id }; return _liveStageCache[ck]; }
  } catch (e) {
    console.warn('[booking] live stage resolve failed:', e.response?.data?.message || e.message);
  }
  return null;
}

// Adopt the GHL auto-created opportunity if present (re-stage + rename), else
// create one ourselves. Guarantees exactly one opportunity per booking.
async function adoptOrCreateFacilityOpp({ fp, stageId, oppName, facilityKey, facilityName, contactId, targetStage }) {
  // Authoritative stage id from live GHL (the configured one may be stale, which
  // would otherwise leave the booking stuck at whatever stage the workflow set).
  const live = await resolveLiveFacilityStage(fp, targetStage);
  const plId = live ? live.pipelineId : fp.id;
  const stId = live ? live.stageId : stageId;

  // Give GHL's workflow a moment to materialise its opp, then look once more.
  let existing = await findFreshFacilityOpp({ fp, contactId, facilityKey, facilityName });
  if (!existing) {
    await new Promise(r => setTimeout(r, 1200));
    existing = await findFreshFacilityOpp({ fp, contactId, facilityKey, facilityName });
  }
  if (existing) {
    try {
      await ghl.ghlPut(`/opportunities/${existing.id}`, {
        pipelineId: plId, pipelineStageId: stId, name: oppName,
      }, { version: '2021-07-28' });
      console.log(`[booking] adopted GHL opp ${existing.id} → "${targetStage}" (${stId}) for ${facilityKey}`);
      return existing.id;
    } catch (e) {
      console.warn('[booking] adopt opp failed, will create:', e.response?.data?.message || e.message);
    }
  }
  // No auto-created opp found — create one ourselves.
  const oppBody = (pl, st) => ({
    pipelineId: pl, locationId: ghl.LOCATION, pipelineStageId: st,
    name: oppName, status: 'open', ...(contactId ? { contactId } : {}),
  });
  try {
    const created = await ghl.ghlPost('/opportunities/', oppBody(plId, stId), { version: '2021-07-28' });
    const newId = created.opportunity?.id || created.id || null;
    console.log(`[booking] opportunity created — ${facilityKey} at "${targetStage}" id=${newId} contact=${contactId || 'none'}`);
    return newId || true;
  } catch (e) {
    const raw = e.response?.data?.message;
    const rawStr = Array.isArray(raw) ? raw.join(' ') : String(raw || '');
    if (rawStr.toLowerCase().includes('duplicate')) return true;
    console.warn(`[booking] opp create failed (status ${e.response?.status}): ${rawStr} — trying live pipeline IDs`);

    // Auto-heal: stageId in pipelines.js may be stale. Fetch live GHL pipeline and retry.
    try {
      const pData  = await ghl.ghlGet('/opportunities/pipelines', { params: { locationId: ghl.LOCATION } });
      const livePl = (pData.pipelines || []).find(p => p.id === fp.id) ||
                     (pData.pipelines || []).find(p => p.name === fp.name);
      if (!livePl) {
        console.warn(`[booking] pipeline not found in GHL — id=${fp.id} name="${fp.name}"`);
        return false;
      }
      const liveStage = (livePl.stages || []).find(s => s.name === targetStage);
      if (!liveStage) {
        console.warn(`[booking] stage "${targetStage}" not found in live pipeline "${livePl.name}"`);
        return false;
      }
      if (liveStage.id !== stageId) {
        console.warn(`[booking] stale stageId detected — UPDATE pipelines.js: "${targetStage}" → "${liveStage.id}"`);
      }
      const created2 = await ghl.ghlPost('/opportunities/', oppBody(livePl.id, liveStage.id), { version: '2021-07-28' });
      const newId2 = created2.opportunity?.id || created2.id || null;
      console.log(`[booking] opp created with live IDs — ${facilityKey} "${targetStage}" id=${newId2}`);
      return newId2 || true;
    } catch (retryErr) {
      console.warn('[booking] opp create retry also failed:', retryErr.response?.data?.message || retryErr.message);
      return false;
    }
  }
}

// Core: gather facility bookings (calendar appointments) and overlay each with its
// real pipeline stage + linked opportunity id. Optionally scope to one contact.
// Returns { items, stages }. The appointment carries the schedule; the opportunity
// carries the lifecycle stage (Requested → Confirmed → …) that management controls.
async function collectBookings({ fwdDays = 90, backDays = 1, contactId = '' } = {}) {
  const startMs = Date.now() - Math.min(Math.max(backDays, 1), 365) * 24 * 60 * 60 * 1000;
  const endMs   = Date.now() + Math.min(Math.max(fwdDays, 1), 365) * 24 * 60 * 60 * 1000;
  const keys    = Object.keys(FACILITY_NAMES).filter(k => CALENDARS[k]);
  const facility = getPipeline('facility');

  const perCal = await Promise.all(keys.map(async (key) => {
    try {
      const data = await ghl.ghlGet('/calendars/events', {
        version: '2021-04-15',
        params:  { locationId: ghl.LOCATION, calendarId: CALENDARS[key], startTime: startMs, endTime: endMs },
      });
      const events = data.events || (Array.isArray(data) ? data : []);
      return events
        .filter(e => String(e.appointmentStatus || '').toLowerCase() !== 'cancelled')
        .map(e => parseBookingEvent(e, key));
    } catch (e) {
      console.warn(`[bookings] fetch failed for ${key}:`, e.response?.data?.message || e.message);
      return [];
    }
  }));
  let items = perCal.flat().filter(Boolean).sort((a, b) => a.startMs - b.startMs);
  if (contactId) items = items.filter(b => b.contactId === contactId);

  // Overlay the real pipeline stage by matching each resident's contact to their
  // Facility Bookings opportunities.
  const stageNames    = Object.fromEntries(Object.entries(facility.stages).map(([k, v]) => [v, k]));
  const oppsByContact = new Map();
  try {
    const params = { location_id: ghl.LOCATION, pipeline_id: facility.id, limit: 100 };
    if (contactId) params.contact_id = contactId;
    const data = await ghl.ghlGet('/opportunities/search', { params });
    (data.opportunities || []).forEach(o => {
      const cid = (o.contact && o.contact.id) || o.contactId || '';
      if (!cid) return;
      const arr = oppsByContact.get(cid) || [];
      arr.push({
        oppId:       o.id,
        name:        o.name || '',
        contactName: (o.contact && o.contact.name) || '',
        createdAt:   o.createdAt,
        stageId:     o.pipelineStageId,
        stage:       stageNames[o.pipelineStageId] || o.status || 'Requested',
      });
      oppsByContact.set(cid, arr);
    });
  } catch (e) {
    console.warn('[bookings] opportunity overlay failed:', e.response?.data?.message || e.message);
  }

  // Two-phase assignment: exact facility+date matches first, then loose fallback.
  // Prevents older bookings from consuming a new opp that shares only the facility name.
  const usedByContact = new Map();
  const assignBk = (bk, opp) => {
    bk.stage = opp.stage; bk.stageId = opp.stageId; bk.oppId = opp.oppId;
    const used = usedByContact.get(bk.contactId) || new Set();
    used.add(opp.oppId); usedByContact.set(bk.contactId, used);
  };
  const DONE_SET = new Set(['Confirmed','Completed','No-Show','Cancelled']);
  for (const bk of items) {
    if (!bk.contactId || !bk.date) continue;
    const fac   = bk.facility.toLowerCase();
    const used  = usedByContact.get(bk.contactId) || new Set();
    const cands = (oppsByContact.get(bk.contactId) || []).filter(o => !used.has(o.oppId));
    const strict = cands.filter(o => { const n = (o.name || '').toLowerCase(); return n.includes(fac) && n.includes(bk.date); });
    const opp = strict.find(o => !DONE_SET.has(o.stage)) || strict[0];
    if (opp) assignBk(bk, opp);
  }
  for (const bk of items) {
    if (bk.oppId) continue;
    const used  = usedByContact.get(bk.contactId) || new Set();
    const cands = (oppsByContact.get(bk.contactId) || []).filter(o => !used.has(o.oppId));
    const opp   = pickOpp(cands, bk);
    if (opp) assignBk(bk, opp);
    if (!bk.oppId) {
      bk.stage = DEPOSIT_FACILITIES.has(bk.facilityKey) ? 'Deposit Pending' : 'Confirmed';
    }
  }

  // Cancelled bookings have had their calendar appointment DELETED (to free the slot),
  // so they no longer appear as calendar events. Re-surface them from their Cancelled
  // opportunity (rebuilt from the opp name) so the management table still lists them as
  // Cancelled. Only for the management view (no contactId) — the resident portal keeps
  // its own cancelled bookings locally. Scoped to the same date window; "Cancelled" is
  // the only stage whose appointment we delete, so other stages still have their event.
  if (!contactId) {
    const usedOppIds = new Set();
    usedByContact.forEach(set => set.forEach(oid => usedOppIds.add(oid)));
    for (const [cid, opps] of oppsByContact) {
      for (const o of opps) {
        if (o.stage !== 'Cancelled' || usedOppIds.has(o.oppId)) continue;
        const row = oppToBookingRow(o, cid);
        if (row && row.startMs >= startMs && row.startMs <= endMs) items.push(row);
      }
    }
    items.sort((a, b) => a.startMs - b.startMs);
  }

  return { items, stages: Object.keys(facility.stages) };
}

// GET /api/management/bookings — every resident's facility booking with its live
// pipeline stage. Management-only (mounted behind requireManagement).
// Mongo is the source of truth (so cancelled bookings stay listed even though their
// calendar appointment was deleted); the GHL calendar is the fallback if Mongo is down.
async function getAllBookings(req, res) {
  const stages = Object.keys(getPipeline('facility').stages);
  if (mongoReady()) {
    try {
      const docs = await Booking.find({}).sort({ date: 1 }).lean();
      const items = await overlayGhlStage(docs.map(bookingDocToRow));
      return res.json({ success: true, items, total: items.length, stages });
    } catch (e) {
      console.warn('[bookings] list from Mongo failed, falling back to GHL:', e.message);
    }
  }
  if (!ghl.isConfigured()) return res.status(503).json({ success: false, message: 'Bookings store unavailable.' });
  try {
    const { items } = await collectBookings({ fwdDays: parseInt(req.query.days, 10) || 90 });
    return res.json({ success: true, items, total: items.length, stages });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL request failed.';
    console.error('[bookings] list failed:', msg);
    return res.status(502).json({ success: false, message: msg });
  }
}

// GET /api/booking/mine?contact_id=&email=[&quick=1] — the resident's own bookings with
// their live pipeline stage. quick=1 skips the email→contactId GHL lookup and uses a
// tight date window; used by the confirmation-polling loop to avoid 502s from large
// GHL requests on every retry.
async function getMyBookings(req, res) {
  const quick = req.query.quick === '1';
  const email = String(req.query.email || '').trim().toLowerCase();
  const stages = Object.keys(getPipeline('facility').stages);
  // Identity from the request (the middleware injects the token's values). Resolve a
  // contactId for the GHL stage overlay; bookings themselves are matched on contactId
  // OR email, so the resident sees them even before a contactId is known.
  let contactId = String(req.query.contact_id || '').trim()
    || (!quick && email && ghl.isConfigured() ? await ghl.findContactIdByEmail(email) : '')
    || '';

  // Mongo is the source of truth.
  if (mongoReady()) {
    try {
      const or = [];
      if (contactId) or.push({ contactId });
      if (email)     or.push({ email });
      if (!or.length) return res.json({ success: true, items: [], statuses: {}, stages });
      const docs  = await Booking.find({ $or: or }).sort({ date: 1 }).lean();
      const items = await overlayGhlStage(docs.map(bookingDocToRow));
      const statuses = {};
      items.forEach(b => { statuses[b.id] = b.status; });
      return res.json({ success: true, items, statuses, stages });
    } catch (e) {
      console.warn('[bookings] mine from Mongo failed, falling back to GHL:', e.message);
    }
  }

  // Fallback: GHL calendar (legacy behaviour).
  if (!ghl.isConfigured() || !contactId) return res.json({ success: true, items: [], statuses: {}, stages });
  try {
    const { items } = await collectBookings({
      contactId,
      backDays: quick ? 7  : 120,
      fwdDays:  quick ? 30 : 180,
    });
    const statuses = {};
    items.forEach(b => { statuses[b.id] = b.stage; });
    return res.json({ success: true, items, statuses, stages });
  } catch (err) {
    console.warn('[bookings] mine fetch failed:', err.response?.data?.message || err.message);
    return res.json({ success: true, items: [], statuses: {}, stages });
  }
}

// Maps a facility stage to the contact tag that fires the "Facility Booking —
// Status Change" workflow (which sends the resident the matching email). The
// portal moves the stage directly; this tag is what triggers the email — without
// it, a management stage change in the portal would be silent to the resident.
const STAGE_TAG = {
  'Confirmed': 'booking-confirmed',
  'Completed': 'booking-completed',
  'No-Show':   'booking-no-show',
  'Cancelled': 'booking-cancelled',
};

// PUT /api/management/bookings/:id/stage  body: { stage } — move a Facility Bookings
// opportunity to a new pipeline stage (Deposit Pending, Confirmed, Completed,
// No-Show, Cancelled). Management-only.
async function updateBookingStage(req, res) {
  const { id } = req.params;
  const { stage } = req.body || {};
  if (!id)    return res.status(400).json({ success: false, message: 'Opportunity id is required.' });
  if (!stage) return res.status(400).json({ success: false, message: 'Stage is required.' });
  if (!ghl.isConfigured()) return res.status(503).json({ success: false, message: 'GHL not configured.' });

  const facility = getPipeline('facility');
  const stageId  = facility.stages[stage];
  if (!stageId) return res.status(400).json({ success: false, message: `Unknown stage: ${stage}` });

  try {
    await ghl.ghlPut(`/opportunities/${id}`, { pipelineId: facility.id, pipelineStageId: stageId }, { version: '2021-07-28' });
    console.log(`[bookings] opportunity ${id} moved to "${stage}"`);

    // Tag the contact so the Status Change workflow sends the resident the matching
    // email. Non-fatal — a tagging failure must never fail the stage move itself.
    const tag = STAGE_TAG[stage];
    if (tag) {
      try {
        const data      = await ghl.ghlGet(`/opportunities/${id}`);
        const opp       = data.opportunity || data;
        const contactId = opp.contactId || (opp.contact && opp.contact.id) || '';
        if (contactId) await ghl.ghlPost(`/contacts/${contactId}/tags`, { tags: [tag] });
      } catch (e) {
        console.warn('[bookings] status tag add failed (non-fatal):', e.response?.data?.message || e.message);
      }
    }
    return res.json({ success: true, message: `Booking moved to ${stage}.`, stage });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL error.';
    console.error('[bookings] stage update failed:', msg);
    return res.status(err.response?.status || 502).json({ success: false, message: msg });
  }
}

// Booking stages that are finished — not editable by the resident.
const LOCKED_STAGES = new Set(['Completed', 'No-Show', 'Cancelled']);

// PUT /api/booking/:id — edit an existing booking (date / slot / pax / notes).
// Updates the GHL calendar appointment so the management view reflects the change.
// Same facility only; rejects edits to finished bookings and to taken slots.
async function updateBooking(req, res) {
  const { id } = req.params;
  const {
    facilityKey, facilityName, date, slot, pax, notes,
    member_name, member_email, member_unit,
  } = req.body || {};

  if (!id) return res.status(400).json({ success: false, message: 'Booking id is required.' });
  if (!facilityKey || !date || !slot) {
    return res.status(400).json({ success: false, message: 'facilityKey, date, and slot are required.' });
  }
  const calendarId = CALENDARS[facilityKey];
  if (!calendarId) return res.status(400).json({ success: false, message: `Unknown facility key: ${facilityKey}` });
  if (!ghl.isConfigured()) return res.status(503).json({ success: false, message: 'GHL not configured.' });

  let times;
  try { times = toISO(date, slot); }
  catch { return res.status(400).json({ success: false, message: 'Invalid date or slot format.' }); }

  // Refuse to edit a finished booking (Completed / No-Show / Cancelled).
  try {
    const facility   = getPipeline('facility');
    const stageNames = Object.fromEntries(Object.entries(facility.stages).map(([k, v]) => [v, k]));
    const contactId  = await ghl.findContactIdByEmail(member_email);
    if (contactId) {
      const data = await ghl.ghlGet('/opportunities/search', {
        params: { location_id: ghl.LOCATION, pipeline_id: facility.id, contact_id: contactId, limit: 100 },
      });
      const locked = (data.opportunities || []).some(o => {
        const st = stageNames[o.pipelineStageId] || o.status;
        return LOCKED_STAGES.has(st) && (o.name || '').toLowerCase().includes((facilityName || '').toLowerCase());
      });
      if (locked) {
        return res.status(409).json({ success: false, message: 'This booking is already finished and can no longer be edited.' });
      }
    }
  } catch (e) {
    console.warn('[booking] edit stage check failed (proceeding):', e.response?.data?.message || e.message);
  }

  // Overlap guard, excluding this booking's own appointment.
  try {
    const reqStart = new Date(times.startTime).getTime();
    const reqEnd   = new Date(times.endTime).getTime();
    const clash = (await getBusyRanges(calendarId, date, id)).find(r => reqStart < r.endMs && reqEnd > r.startMs);
    if (clash) {
      return res.status(409).json({ success: false, message: 'That time slot has already been booked. Please choose another.' });
    }
  } catch (e) {
    console.warn('[booking] update overlap check failed (proceeding):', e.response?.data?.message || e.message);
  }

  const unitLabel  = member_unit ? ` (#${member_unit})` : '';
  const slotStart  = (slot || '').split(' – ')[0].trim();
  const title      = `${facilityName || facilityKey} — ${member_name || 'Resident'}${unitLabel}`;
  const noteLines = [
    `Pax: ${pax || 1}`,
    notes        ? `Notes: ${notes}`       : null,
    member_email ? `Email: ${member_email}` : null,
  ].filter(Boolean).join('\n');

  try {
    await ghl.ghlPut(`/calendars/events/appointments/${id}`, {
      calendarId,
      startTime: times.startTime,
      endTime:   times.endTime,
      title,
      ...(noteLines ? { notes: noteLines } : {}),
    }, { version: '2021-04-15' });
    console.log(`[booking] updated appointment ${id} → ${facilityKey} ${date} ${slot}`);

    // Mirror the edit to the Mongo source of truth (non-fatal).
    if (mongoReady()) {
      try { await Booking.findOneAndUpdate({ ghlAppointmentId: id }, { date, slot, pax: pax || 1, notes: notes || '' }); }
      catch (e) { console.warn('[booking] Mongo update failed (non-fatal):', e.message); }
    }

    // Refresh the contact's booking custom fields (non-fatal).
    const contactId = await ghl.findContactIdByEmail(member_email);
    if (contactId) {
      ghl.ghlPut(`/contacts/${contactId}`, {
        customFields: [
          { id: FIELD.bookingPax,  field_value: String(pax || 1) },
          { id: FIELD.guestCount,  field_value: String(pax || 1) },
          { id: FIELD.bookingDate, field_value: date },
        ],
      }).catch(e => console.warn('[booking] contact field update failed (non-fatal):', e.response?.data?.message || e.message));
    }

    return res.json({ success: true, message: 'Booking updated.' });
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.message || err.message || 'GHL error.';
    console.error(`[booking] update failed ${status}:`, msg);
    return res.status(status || 502).json({ success: false, message: `Update failed: ${msg}` });
  }
}

// DELETE /api/booking/:id — cancel a GHL calendar appointment.
// Move the resident's matching Facility Bookings opportunity to "Cancelled" so the
// pipeline mirrors the cancellation (and the Status-Change workflow emails them).
// Identity is the SIGNED contact_id — the opp is resolved from the resident's own
// opportunities, so a forged opp_id hint that isn't theirs is ignored (no IDOR).
// Fully non-fatal: a pipeline hiccup here must never throw. Returns true if the
// opportunity is at "Cancelled" (moved now or already there), false otherwise.
async function moveBookingOppToCancelled({ contactId, facilityName, date, oppHint }) {
  if (!contactId) { console.warn('[booking] cancel: no contact_id — skipping pipeline move'); return false; }
  const fp = getPipeline('facility');
  try {
    const data = await ghl.ghlGet('/opportunities/search', {
      params: { location_id: ghl.LOCATION, pipeline_id: fp.id, contact_id: contactId, limit: 100 },
    });
    const stageNames = Object.fromEntries(Object.entries(fp.stages).map(([k, v]) => [v, k]));
    const candidates = (data.opportunities || [])
      .filter(o => String((o.contact && o.contact.id) || o.contactId || '') === String(contactId))
      .map(o => ({
        oppId: o.id, name: o.name || '', createdAt: o.createdAt,
        stageId: o.pipelineStageId, stage: stageNames[o.pipelineStageId] || o.status || '',
      }));

    // Use the client's opp hint only if it genuinely belongs to this resident;
    // otherwise match by facility/date (pickOpp needs a non-empty facility to be safe).
    let target = oppHint && candidates.find(o => o.oppId === oppHint);
    if (!target && facilityName) target = pickOpp(candidates, { facility: facilityName, date: date || '' });
    if (!target) { console.warn('[booking] cancel: no matching opportunity to move to Cancelled'); return false; }
    if (target.stage === 'Cancelled') return true;

    const live = await resolveLiveFacilityStage(fp, 'Cancelled');
    const plId = live ? live.pipelineId : fp.id;
    const stId = live ? live.stageId   : fp.stages['Cancelled'];
    await ghl.ghlPut(`/opportunities/${target.oppId}`, { pipelineId: plId, pipelineStageId: stId }, { version: '2021-07-28' });
    console.log(`[booking] opportunity ${target.oppId} moved to "Cancelled"`);

    // Tag the contact so the "Status Change" workflow sends the cancellation email.
    const tag = STAGE_TAG['Cancelled'];
    if (tag) {
      try { await ghl.ghlPost(`/contacts/${contactId}/tags`, { tags: [tag] }); }
      catch (e) { console.warn('[booking] cancel tag add failed (non-fatal):', e.response?.data?.message || e.message); }
    }
    return true;
  } catch (e) {
    console.warn('[booking] move-to-Cancelled failed (non-fatal):', e.response?.data?.message || e.message);
    return false;
  }
}

async function cancelBooking(req, res) {
  const { id } = req.params;
  if (!id) return res.status(400).json({ success: false, message: 'Appointment ID required.' });

  // Identity is the verified token (injected by requireResident), never the request.
  const contactId    = (req.resident && req.resident.contact_id) || req.query.contact_id || '';
  const facilityName = req.query.facility || req.query.facilityName || '';
  const date         = req.query.date || '';
  const oppHint      = req.query.opp_id || '';

  // 1) Mark the Mongo booking "Cancelled" — the source of truth for BOTH portals.
  //    The row is KEPT (not deleted) so it stays visible as Cancelled in My Bookings
  //    and in the management table even though its calendar appointment is removed.
  let mongoCancelled = false;
  if (mongoReady()) {
    try {
      const or = [{ ghlAppointmentId: id }];
      if (oppHint) or.push({ ghlOppId: oppHint });
      const r = await Booking.updateMany({ $or: or }, { status: 'Cancelled' });
      mongoCancelled = (r.modifiedCount || r.nModified || 0) > 0;
      console.log(`[booking] Mongo marked Cancelled (appt ${id}): ${mongoCancelled}`);
    } catch (e) {
      console.warn('[booking] Mongo cancel failed (non-fatal):', e.message);
    }
  }

  // 2) Move the pipeline opportunity to "Cancelled" so GHL mirrors it (and the
  //    Status-Change workflow emails the resident). Non-fatal.
  const oppMoved = await moveBookingOppToCancelled({ contactId, facilityName, date, oppHint });

  // 3) Delete the calendar appointment so the slot frees up. GHL's delete endpoint is
  //    /calendars/events/{id} (the /appointments segment is only for create/get/update);
  //    fall back to the appointments path. Non-fatal.
  let apptCancelled = false;
  if (ghl.isConfigured()) {
    for (const path of [`/calendars/events/${id}`, `/calendars/events/appointments/${id}`]) {
      try {
        await ghl.ghlDelete(path, { version: '2021-04-15' });
        console.log(`[booking] Cancelled GHL appointment ${id} via ${path}`);
        apptCancelled = true;
        break;
      } catch (err) {
        console.warn(`[booking] appt delete via ${path} failed (${err.response?.status}):`, err.response?.data?.message || err.message);
      }
    }
  }

  // Success as long as the cancellation was recorded somewhere. If nothing took, report
  // 502 — but NEVER a 401/403 (the portal treats any 401 on /api/ as its own session
  // expiring and would force-log-the-resident-out).
  if (!mongoCancelled && !oppMoved && !apptCancelled) {
    return res.status(502).json({ success: false, message: 'Could not cancel the booking. Please try again.' });
  }
  return res.json({ success: true, message: 'Booking cancelled.', mongoCancelled, oppMoved, apptCancelled });
}

// GET /api/booking/opp-stage?opp_id=xxx — fetch a single opportunity's current stage
// directly from GHL (not the search index, which can lag after a workflow updates it).
async function getOppStage(req, res) {
  const { opp_id } = req.query;
  if (!opp_id) return res.status(400).json({ success: false, message: 'opp_id required.' });
  if (!ghl.isConfigured()) return res.status(503).json({ success: false, message: 'GHL not configured.' });
  try {
    const data = await ghl.ghlGet(`/opportunities/${opp_id}`);
    const opp  = data.opportunity || data;
    // Build a combined stageId→name map across all deposit pipelines.
    const allStages = { ...getPipeline('facility').stages, ...getPipeline('move').stages };
    const stageNames = Object.fromEntries(Object.entries(allStages).map(([k, v]) => [v, k]));
    const stage = stageNames[opp.pipelineStageId] || opp.status || 'Unknown';
    return res.json({ success: true, stage });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL error.';
    return res.status(err.response?.status || 502).json({ success: false, message: msg });
  }
}

module.exports = { createBooking, updateBooking, cancelBooking, getAvailability, getAllBookings, getMyBookings, updateBookingStage, getOppStage };
