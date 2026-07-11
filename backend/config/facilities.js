// Server-side mirror of the facility catalogue in public/js/portal.controller.js
// (FACILITIES). The frontend copy also carries display-only text (capacity
// blurb, house-rule note, note placeholder) that has no bearing on validation,
// so it's intentionally left out here - this file exists purely so booking
// creation/edit/availability can be checked against real rules server-side
// instead of trusting whatever the client sends.
// depositAmount (USD) lives ONLY here - the frontend used to hardcode this
// same figure in 3 separate places (PAY_DEPOSITS/VERANDAH_FEES in
// portal.controller.js, DEPOSIT_AMOUNTS in management.controller.js), a real
// drift risk. Both now fetch GET /api/booking/facilities once at boot and
// overwrite their local copies with these values instead.
// refundableAmount: for facilities where part of depositAmount is a
// non-refundable fee (e.g. Verandah's $200 booking fee), this is the portion
// that can actually be refunded/forfeited later - refund/forfeit never
// touches the rest. Omitted (or equal to depositAmount) means the whole
// thing is refundable, same as before this field existed.
// variableDuration: true facilities let residents pick how many hours to book
// (exact multiples of `slot`, bounded by `close`) - see validateBookingInput
// in booking.controller.js. BBQ/Verandah stay a single fixed-length block.
const FACILITIES = [
  { key: 'pool',       name: 'Swimming Pool',    emoji: '🏊', deposit: true, depositAmount: 200, variableDuration: true, open: 7,  close: 23, slot: 1, maxPax: 5 },
  { key: 'tennis',     name: 'Tennis Court',     emoji: '🎾', variableDuration: true, open: 7,  close: 23, slot: 1, maxPax: 4 },
  { key: 'squash',     name: 'Squash Court',     emoji: '🥎', variableDuration: true, open: 7,  close: 23, slot: 1, maxPax: 4 },
  { key: 'basketball', name: 'Basketball Court', emoji: '🏀', variableDuration: true, open: 8,  close: 23, slot: 1, maxPax: 12 },
  { key: 'gym',        name: 'Gymnasium',        emoji: '🏋️', variableDuration: true, open: 6,  close: 23, slot: 1, maxPax: 1 },
  { key: 'fitness',    name: 'Fitness Room',     emoji: '🤸', variableDuration: true, open: 6,  close: 23, slot: 1, maxPax: 1 },
  { key: 'bbq',        name: 'BBQ Pit',          emoji: '🔥', deposit: true, depositAmount: 200, open: 10, close: 23, slot: 3, maxPax: 15 },
  { key: 'verandah',   name: 'The Verandah',     emoji: '🥂', deposit: true, depositAmount: 600, refundableAmount: 400, open: 7,  close: 23, slot: 4, slotStep: 240, maxPax: 40, maxAdvanceDays: 31, maxBlocksPerDay: 2 },
];

const facByKey = key => FACILITIES.find(f => f.key === key);

// Same slot-generation logic as the frontend's timeSlots() - kept in lockstep
// so a slot string the client shows as bookable is also one the server accepts.
function fmtMins(totalMins) {
  const h  = Math.floor(totalMins / 60) % 24;
  const m  = totalMins % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, '0')} ${ap}`;
}

function timeSlots(f) {
  const out      = [];
  const slotMins = f.slot * 60;
  const closeMin = f.close * 60;
  for (let m = f.open * 60; m + slotMins <= closeMin; m += (f.slotStep || 15)) {
    out.push(`${fmtMins(m)} - ${fmtMins(m + slotMins)}`);
  }
  return out;
}

function parseSlotPart(part) {
  const [time, ap] = part.trim().split(' ');
  const [h, m] = time.split(':').map(Number);
  const hours = ap === 'PM' && h !== 12 ? h + 12 : ap === 'AM' && h === 12 ? 0 : h;
  return hours * 60 + m;
}
function parseSlotStart(slotStr) { return parseSlotPart(slotStr.split(' - ')[0]); }
function parseSlotEnd(slotStr)   { return parseSlotPart(slotStr.split(' - ')[1]); }

// SGT calendar date / time-of-day, matching the frontend's Asia/Singapore-anchored logic.
function todaySGT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}
function nowSGTMins() {
  const t = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function addDaysSGT(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = { FACILITIES, facByKey, timeSlots, parseSlotStart, parseSlotEnd, todaySGT, nowSGTMins, addDaysSGT };
