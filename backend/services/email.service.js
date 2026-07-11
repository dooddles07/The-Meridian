// Thin Resend REST client — one place for the API key + sender so callers never
// touch HTTP directly.

const axios = require('axios');

const BASE = 'https://api.resend.com';
const KEY  = process.env.RESEND_API_KEY || '';
// Resend's sandbox sender works with zero setup but can only deliver to the
// account owner's own inbox until a real domain is verified — fine for now,
// documented in .env.example.
const FROM = process.env.RESEND_FROM || 'The Lumina <onboarding@resend.dev>';

const isConfigured = () => Boolean(KEY);

async function sendEmail({ to, subject, html }) {
  const { data } = await axios.post(
    `${BASE}/emails`,
    { from: FROM, to, subject, html },
    { headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, timeout: 12000 },
  );
  return data;
}

// Shared send path: logs (dev-friendly no-op) when unconfigured, never throws
// on failure - every caller fires these without awaiting, so a booking/reset
// action's success is never coupled to whether the email actually went out.
async function _safeSend(to, subject, html) {
  if (!isConfigured()) {
    console.log(`[email] RESEND_API_KEY not set — would send "${subject}" to ${to}`);
    return null;
  }
  try {
    return await sendEmail({ to, subject, html });
  } catch (e) {
    console.warn('[email] send failed:', e.response?.data?.message || e.message);
    return null;
  }
}

function _wrap(bodyHtml) {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
    <h2 style="color:#312e81">The Lumina</h2>
    ${bodyHtml}
  </div>`;
}

function _fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Singapore' });
}

async function sendPasswordResetEmail({ to, name, resetUrl }) {
  const html = _wrap(`
    <p>Hi ${name || 'there'},</p>
    <p>We received a request to reset your resident portal password. This link expires in 30 minutes and can only be used once.</p>
    <p><a href="${resetUrl}" style="display:inline-block;padding:10px 20px;background:#312e81;color:#fff;border-radius:8px;text-decoration:none">Reset your password</a></p>
    <p style="color:#5a514a;font-size:0.85em">If you didn't request this, you can safely ignore this email — your password won't change.</p>
  `);
  return _safeSend(to, 'Reset your Lumina password', html);
}

// Deposit-required facility, just booked - not confirmed until paid.
async function sendBookingPendingEmail({ to, name, facilityName, date, slot, depositAmount, depositDueAt }) {
  const dueTxt = depositDueAt
    ? new Date(depositDueAt).toLocaleString('en-GB', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Singapore' })
    : '';
  const html = _wrap(`
    <p>Hi ${name || 'there'},</p>
    <p>Your <b>${facilityName}</b> booking for <b>${_fmtDate(date)}</b>, ${slot}, is saved and needs a <b>SGD ${Number(depositAmount || 0).toFixed(2)}</b> deposit to be confirmed.</p>
    <p style="color:#b45309"><b>⚠ Pay within 24 hours${dueTxt ? ` (by ${dueTxt})` : ''}</b> or this booking will be automatically cancelled and the slot released.</p>
    <p>Go to the Payments tab in your resident portal to pay now.</p>
  `);
  return _safeSend(to, `Deposit needed - ${facilityName} booking`, html);
}

// Booking is confirmed - either created directly (no deposit required) or the
// deposit was just paid/marked paid.
async function sendBookingConfirmedEmail({ to, name, facilityName, date, slot }) {
  const html = _wrap(`
    <p>Hi ${name || 'there'},</p>
    <p>Your <b>${facilityName}</b> booking is <b>confirmed</b>.</p>
    <p>📅 ${_fmtDate(date)}<br>🕐 ${slot}</p>
    <p>See you there!</p>
  `);
  return _safeSend(to, `Booking confirmed - ${facilityName}`, html);
}

async function sendBookingUpdatedEmail({ to, name, facilityName, date, slot }) {
  const html = _wrap(`
    <p>Hi ${name || 'there'},</p>
    <p>Your <b>${facilityName}</b> booking has been updated to:</p>
    <p>📅 ${_fmtDate(date)}<br>🕐 ${slot}</p>
  `);
  return _safeSend(to, `Booking updated - ${facilityName}`, html);
}

// reason: 'resident' (self-cancelled), 'management' (staff cancelled), or
// 'deposit_expired' (24h payment window passed - see the backend's sweep).
async function sendBookingCancelledEmail({ to, name, facilityName, date, slot, reason }) {
  const reasonTxt = reason === 'deposit_expired'
    ? 'the 24-hour deposit payment window passed without payment'
    : reason === 'management'
    ? 'building management cancelled it'
    : 'it was cancelled';
  const html = _wrap(`
    <p>Hi ${name || 'there'},</p>
    <p>Your <b>${facilityName}</b> booking for <b>${_fmtDate(date)}</b>, ${slot}, has been <b>cancelled</b> because ${reasonTxt}.</p>
    <p>You're welcome to make a new booking any time from the Facility Booking tab.</p>
  `);
  return _safeSend(to, `Booking cancelled - ${facilityName}`, html);
}

module.exports = {
  isConfigured, sendEmail, sendPasswordResetEmail,
  sendBookingPendingEmail, sendBookingConfirmedEmail, sendBookingUpdatedEmail, sendBookingCancelledEmail,
};
