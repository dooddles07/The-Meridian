// services/ghl.service.js
// Shared GoHighLevel (LeadConnector) API client. One place for base URL, auth,
// and version headers so every controller talks to GHL the same way.

const axios  = require('axios');
const crypto = require('crypto');

const BASE     = process.env.GHL_API_BASE_URL || 'https://services.leadconnectorhq.com';
const KEY      = process.env.GHL_API_KEY || '';
const LOCATION = process.env.GHL_LOCATION_ID || '';   // no hardcoded tenant id (M-08)

if (KEY && !LOCATION) {
  console.warn('[ghl] GHL_API_KEY is set but GHL_LOCATION_ID is missing — GHL features stay disabled until it is set.');
}

// Most endpoints use 2021-07-28; calendar appointments use 2021-04-15.
const DEFAULT_VERSION = '2021-07-28';

// Require BOTH the key and the location so a half-configured deployment degrades
// gracefully (503 / empty) instead of making broken calls against a blank location.
const isConfigured = () => Boolean(KEY && LOCATION);

function headers(version) {
  return {
    Authorization:  `Bearer ${KEY}`,
    Version:        version || DEFAULT_VERSION,
    'Content-Type': 'application/json',
    Accept:         'application/json',
  };
}

async function ghlGet(path, { params, version } = {}) {
  const { data } = await axios.get(`${BASE}${path}`, { headers: headers(version), params, timeout: 12000 });
  return data;
}

async function ghlPost(path, body, { version } = {}) {
  const { data } = await axios.post(`${BASE}${path}`, body, { headers: headers(version), timeout: 12000 });
  return data;
}

async function ghlPut(path, body, { version } = {}) {
  const { data } = await axios.put(`${BASE}${path}`, body, { headers: headers(version), timeout: 12000 });
  return data;
}

async function ghlDelete(path, { version } = {}) {
  const { data } = await axios.delete(`${BASE}${path}`, { headers: headers(version), timeout: 12000 });
  return data;
}

// POST to an absolute GHL Inbound Webhook URL (no auth header — webhooks are
// triggered by URL). Used to fire workflows with structured data.
async function postWebhook(url, body) {
  if (!url) return null;
  // Attach an idempotency key + timestamp so duplicate/retried fires can be deduped
  // downstream (M-07). The key is derived from the event + a stable natural reference
  // (so the same logical event yields the same key); falls back to a random id.
  const payload = { ...body };
  if (!payload.idempotency_key) {
    const basis = payload.reference || payload.appointment_id || payload.parcel_reference || payload.opp_name || '';
    payload.idempotency_key = basis
      ? crypto.createHash('sha256').update(`${payload.event || ''}:${basis}`).digest('hex').slice(0, 32)
      : crypto.randomUUID();
  }
  if (!payload.sent_at) payload.sent_at = new Date().toISOString();
  const { data } = await axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  return data;
}

// Create or update a contact by email (GHL dedupes on email). Returns the
// contact object (with .id). Used to auto-render accounts into GHL.
async function upsertContact({ email, firstName, lastName, customFields } = {}) {
  const body = { locationId: LOCATION, email };
  if (firstName)    body.firstName    = firstName;
  if (lastName)     body.lastName     = lastName;
  if (customFields && customFields.length) body.customFields = customFields;
  const data = await ghlPost('/contacts/upsert', body);
  return data.contact || data;
}

// Resolve a contact's current GHL ID by email (self-healing — survives
// contact deletion/recreation). Returns the ID string, or null if not found
// or GHL is unavailable. Never throws.
async function findContactIdByEmail(email) {
  if (!email || !isConfigured()) return null;
  try {
    const data = await ghlGet('/contacts/', { params: { locationId: LOCATION, query: email } });
    const list = data.contacts || [];
    const match = list.find(c => (c.email || '').toLowerCase() === String(email).toLowerCase()) || list[0];
    return match ? match.id : null;
  } catch {
    return null;
  }
}

// Canonical contact id for an email — UPSERTS (idempotent, dedups by email) so it
// returns the exact same contact that bookings/defects/etc. write under. This is
// the single source of truth for resident identity: the GHL contact is created
// lazily here on first use (residents log in against backend accounts, not GHL).
// Use this for BOTH reads and writes so scoping never drifts to a stale/duplicate id.
async function resolveContactId(email, { firstName, lastName } = {}) {
  if (!email || !isConfigured()) return null;
  try {
    const c = await upsertContact({ email, firstName, lastName });
    if (c && c.id) return c.id;
  } catch { /* fall through to a direct lookup */ }
  // Upsert hiccuped — find the existing contact by email so reads/writes still agree.
  return findContactIdByEmail(email);
}

module.exports = { BASE, LOCATION, isConfigured, headers, ghlGet, ghlPost, ghlPut, ghlDelete, postWebhook, upsertContact, findContactIdByEmail, resolveContactId };
