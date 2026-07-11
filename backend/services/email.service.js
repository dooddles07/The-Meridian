// Thin Resend REST client — one place for the API key + sender so callers never
// touch HTTP directly. Follows the same shape as ghl.service.js.

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

// Degrades gracefully when unconfigured: logs the link instead of throwing, so
// local dev works without a real Resend key (mirrors ghl.service.js's isConfigured
// gate elsewhere in this codebase).
async function sendPasswordResetEmail({ to, name, resetUrl }) {
  if (!isConfigured()) {
    console.log(`[email] RESEND_API_KEY not set — reset link (dev only): ${resetUrl}`);
    return null;
  }
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
      <h2 style="color:#312e81">The Lumina</h2>
      <p>Hi ${name || 'there'},</p>
      <p>We received a request to reset your resident portal password. This link expires in 30 minutes and can only be used once.</p>
      <p><a href="${resetUrl}" style="display:inline-block;padding:10px 20px;background:#312e81;color:#fff;border-radius:8px;text-decoration:none">Reset your password</a></p>
      <p style="color:#5a514a;font-size:0.85em">If you didn't request this, you can safely ignore this email — your password won't change.</p>
    </div>`;
  try {
    return await sendEmail({ to, subject: 'Reset your Lumina password', html });
  } catch (e) {
    console.warn('[email] send failed:', e.response?.data?.message || e.message);
    return null;
  }
}

module.exports = { isConfigured, sendEmail, sendPasswordResetEmail };
