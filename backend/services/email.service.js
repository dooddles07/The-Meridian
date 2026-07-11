// Thin Resend REST client — one place for the API key + sender so callers never
// touch HTTP directly.

const axios = require('axios');

const BASE = 'https://api.resend.com';
const KEY  = process.env.RESEND_API_KEY || '';
// Resend's sandbox sender works with zero setup but can only deliver to the
// account owner's own inbox until a real domain is verified — fine for now,
// documented in .env.example.
const FROM = process.env.RESEND_FROM || 'The Lumina <onboarding@resend.dev>';
// Used for CTA links in emails — falls back to the real deployed URL so links
// still work even if the env var isn't set on a given environment.
const APP_URL = (process.env.PUBLIC_APP_URL || 'https://the-lumina-production.up.railway.app').replace(/\/$/, '');

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

// ── Shared visual language ───────────────────────────────────────────────
// Table-based, fully inline-styled markup (no <style> block, no @font-face)
// so the layout and brand colors survive Gmail, Outlook desktop, and Apple
// Mail without relying on CSS support those clients strip or ignore. Safe
// font stacks stand in for the web app's Cormorant Garamond / Tenor Sans —
// custom web fonts aren't reliable in email clients, so a serif stack carries
// the same warm, editorial feel for headings and a plain sans stack for body
// copy. `color-scheme: light` keeps clients from auto-dark-inverting the
// brand's cream/indigo palette into something we didn't design.
const INDIGO   = '#312e81';
const INDIGO_L = '#c7c4f0';
const CREAM    = '#f4f1ea';
const INK      = '#2b2620';
const MUTED    = '#8a8275';
const BORDER   = '#e4dfd4';
const SERIF    = "Georgia, 'Times New Roman', serif";
const SANS     = "Helvetica, Arial, sans-serif";

function _button(label, href) {
  return `<a href="${href}" style="display:inline-block;margin-top:8px;padding:13px 30px;background:${INDIGO};color:#ffffff;font-family:${SANS};font-size:14px;font-weight:bold;text-decoration:none;border-radius:8px;">${label}</a>`;
}

// Amber alert box for time-sensitive/attention-needed content (deposit due,
// expired, etc.) — color is always paired with the ⚠ glyph and explicit
// wording, never relied on alone, per the usual color-not-only guidance.
function _alert(html) {
  return `<div style="margin:20px 0;padding:14px 18px;background:#fff7e8;border:1px solid #f0d9a8;border-radius:8px;color:#8a5a10;font-family:${SANS};font-size:14px;line-height:1.5;">${html}</div>`;
}

function _detailBlock(rows) {
  const items = rows.map(([label, value]) => `
    <tr>
      <td style="padding:3px 0;font-family:${SANS};font-size:13px;color:${MUTED};white-space:nowrap;">${label}</td>
      <td style="padding:3px 0 3px 12px;font-family:${SANS};font-size:14px;color:${INK};font-weight:bold;">${value}</td>
    </tr>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0;">${items}</table>`;
}

// preheader = the short preview line inboxes show next to the subject —
// hidden on the page itself, but meaningful (not "view this email") once it
// shows up in someone's inbox list.
function _shell({ title, preheader, bodyHtml }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${CREAM};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${CREAM};">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${BORDER};">
<tr>
<td style="background:${INDIGO};padding:30px 32px;text-align:center;">
<div style="font-family:${SERIF};font-size:23px;letter-spacing:3px;color:#ffffff;">THE LUMINA</div>
<div style="font-family:${SANS};font-size:11px;letter-spacing:2px;color:${INDIGO_L};margin-top:6px;">RESIDENT PORTAL</div>
</td>
</tr>
<tr>
<td style="padding:36px 32px;font-family:${SANS};color:${INK};font-size:15px;line-height:1.65;">
${bodyHtml}
</td>
</tr>
<tr>
<td style="padding:22px 32px;background:${CREAM};border-top:1px solid ${BORDER};font-family:${SANS};font-size:12px;color:${MUTED};text-align:center;line-height:1.6;">
The Lumina · Resident Portal<br>
This is an automated message about your account — please don't reply directly to this email.
</td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function _fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Singapore' });
}

async function sendPasswordResetEmail({ to, name, resetUrl }) {
  const body = `
    <p style="margin:0 0 4px;font-family:${SERIF};font-size:20px;color:${INK};">Reset your password</p>
    <p style="margin:16px 0 0;">Hi ${name || 'there'},</p>
    <p style="margin:12px 0 0;">We received a request to reset the password on your resident portal account. Click the button below to choose a new one.</p>
    <div style="margin:22px 0 6px;">${_button('Reset your password', resetUrl)}</div>
    <p style="margin:18px 0 0;font-size:13px;color:${MUTED};">This link expires in 30 minutes and can only be used once. If you didn't request this, you can safely ignore this email — your password won't change.</p>
  `;
  const html = _shell({
    title: 'Reset your Lumina password',
    preheader: 'Use this link to set a new password — it expires in 30 minutes.',
    bodyHtml: body,
  });
  return _safeSend(to, 'Reset your Lumina password', html);
}

// Deposit-required facility, just booked - not confirmed until paid.
async function sendBookingPendingEmail({ to, name, facilityName, date, slot, depositAmount, depositDueAt }) {
  const dueTxt = depositDueAt
    ? new Date(depositDueAt).toLocaleString('en-GB', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Singapore' })
    : '';
  const body = `
    <p style="margin:0 0 4px;font-family:${SERIF};font-size:20px;color:${INK};">Your booking is almost confirmed</p>
    <p style="margin:16px 0 0;">Hi ${name || 'there'},</p>
    <p style="margin:12px 0 0;">We've saved your booking for <strong>${facilityName}</strong>. It just needs a deposit before it's confirmed.</p>
    ${_detailBlock([['Facility', facilityName], ['Date', _fmtDate(date)], ['Time', slot], ['Deposit', `SGD ${Number(depositAmount || 0).toFixed(2)}`]])}
    ${_alert(`⚠ <strong>Pay within 24 hours</strong>${dueTxt ? ` (by ${dueTxt})` : ''} or this booking will be automatically cancelled and the slot released to other residents.`)}
    <div style="margin:6px 0 0;">${_button('Pay your deposit', `${APP_URL}/portal.html`)}</div>
    <p style="margin:18px 0 0;font-size:13px;color:${MUTED};">You'll find the Payments tab in your resident portal.</p>
  `;
  const html = _shell({
    title: `Deposit needed - ${facilityName} booking`,
    preheader: `Pay your SGD ${Number(depositAmount || 0).toFixed(2)} deposit within 24 hours to confirm your ${facilityName} booking.`,
    bodyHtml: body,
  });
  return _safeSend(to, `Deposit needed - ${facilityName} booking`, html);
}

// Booking is confirmed - either created directly (no deposit required) or the
// deposit was just paid/marked paid.
async function sendBookingConfirmedEmail({ to, name, facilityName, date, slot }) {
  const body = `
    <p style="margin:0 0 4px;font-family:${SERIF};font-size:20px;color:${INK};">You're all set</p>
    <p style="margin:16px 0 0;">Hi ${name || 'there'},</p>
    <p style="margin:12px 0 0;">Your <strong>${facilityName}</strong> booking is confirmed. We'll see you there.</p>
    ${_detailBlock([['Facility', facilityName], ['Date', _fmtDate(date)], ['Time', slot]])}
    <div style="margin:6px 0 0;">${_button('View my bookings', `${APP_URL}/portal.html`)}</div>
  `;
  const html = _shell({
    title: `Booking confirmed - ${facilityName}`,
    preheader: `Your ${facilityName} booking on ${_fmtDate(date)} is confirmed.`,
    bodyHtml: body,
  });
  return _safeSend(to, `Booking confirmed - ${facilityName}`, html);
}

async function sendBookingUpdatedEmail({ to, name, facilityName, date, slot }) {
  const body = `
    <p style="margin:0 0 4px;font-family:${SERIF};font-size:20px;color:${INK};">Your booking has been updated</p>
    <p style="margin:16px 0 0;">Hi ${name || 'there'},</p>
    <p style="margin:12px 0 0;">Here are the new details for your <strong>${facilityName}</strong> booking:</p>
    ${_detailBlock([['Facility', facilityName], ['Date', _fmtDate(date)], ['Time', slot]])}
    <div style="margin:6px 0 0;">${_button('View my bookings', `${APP_URL}/portal.html`)}</div>
  `;
  const html = _shell({
    title: `Booking updated - ${facilityName}`,
    preheader: `Your ${facilityName} booking moved to ${_fmtDate(date)}, ${slot}.`,
    bodyHtml: body,
  });
  return _safeSend(to, `Booking updated - ${facilityName}`, html);
}

// reason: 'resident' (self-cancelled), 'management' (staff cancelled), or
// 'deposit_expired' (24h payment window passed - see the backend's sweep).
async function sendBookingCancelledEmail({ to, name, facilityName, date, slot, reason }) {
  const reasonTxt = reason === 'deposit_expired'
    ? 'the 24-hour deposit payment window passed without payment'
    : reason === 'management'
    ? 'building management cancelled it'
    : 'you cancelled it';
  const body = `
    <p style="margin:0 0 4px;font-family:${SERIF};font-size:20px;color:${INK};">Booking cancelled</p>
    <p style="margin:16px 0 0;">Hi ${name || 'there'},</p>
    <p style="margin:12px 0 0;">Your <strong>${facilityName}</strong> booking has been cancelled because ${reasonTxt}.</p>
    ${_detailBlock([['Facility', facilityName], ['Date', _fmtDate(date)], ['Time', slot]])}
    <p style="margin:18px 0 0;">You're welcome to make a new booking any time from the Facility Booking tab.</p>
    <div style="margin:10px 0 0;">${_button('Book another slot', `${APP_URL}/portal.html`)}</div>
  `;
  const html = _shell({
    title: `Booking cancelled - ${facilityName}`,
    preheader: `Your ${facilityName} booking on ${_fmtDate(date)} has been cancelled.`,
    bodyHtml: body,
  });
  return _safeSend(to, `Booking cancelled - ${facilityName}`, html);
}

module.exports = {
  isConfigured, sendEmail, sendPasswordResetEmail,
  sendBookingPendingEmail, sendBookingConfirmedEmail, sendBookingUpdatedEmail, sendBookingCancelledEmail,
};
