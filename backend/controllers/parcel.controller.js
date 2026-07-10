const mongoose = require('mongoose');
const ghl = require('../services/ghl.service');
const { getPipeline } = require('../config/pipelines');
const Parcel = require('../models/parcel.model');

const dbReady = () => mongoose.connection.readyState === 1;

// GHL Inbound Webhook that triggers the Parcel Tracking workflow (optional — for
// email/automation). The opportunity itself is created here via the API so it
// always exists, independent of any workflow being configured.
const PARCEL_WEBHOOK = process.env.LUMINA_WEBHOOK_PARCEL || '';

// POST /api/parcel — resident notifies the guardhouse of a parcel they're expecting,
// by its reference. Creates a Parcel Tracking opportunity (so it shows in My Parcels,
// management, and is findable by the guardhouse). The guardhouse then receives/holds
// it until the resident collects (or it's returned after 7 days).
async function notifyParcel(req, res) {
  const {
    parcel_reference, courier, description, authorized_collector,
    resident_name, resident_email, resident_unit, resident_contact_id,
  } = req.body || {};

  if (!parcel_reference) {
    return res.status(400).json({ success: false, message: 'A parcel reference is required.' });
  }
  if (!PARCEL_WEBHOOK) {
    return res.status(503).json({ success: false, message: 'Parcel notifications are not configured on the server yet.' });
  }
  if (!ghl.isConfigured()) {
    return res.status(503).json({ success: false, message: 'GHL is not configured on the server.' });
  }

  try {
    // Dedupe: if this reference is already in the pipeline, don't fire the webhook
    // a second time — the GHL workflow would create a duplicate opportunity.
    const parcel = getPipeline('parcel');
    const found  = await ghl.ghlGet('/opportunities/search', {
      params: { location_id: ghl.LOCATION, q: parcel_reference, pipeline_id: parcel.id },
    });
    const ref = parcel_reference.toLowerCase();
    const dup = (found.opportunities || []).find(o => (o.name || '').toLowerCase().includes(ref));
    if (dup) {
      console.log(`[parcel] ${parcel_reference} already logged (${dup.id}) — not duplicating`);
      return res.json({ success: true, message: 'This parcel is already logged with the guardhouse.', reference: parcel_reference, duplicate: true });
    }

    // Canonical opportunity name the workflow uses. The guardhouse parcel lookup
    // parses this exact format: "<REF> — <Resident> (#<unit>) [Auth: <collector>]"
    // — unit from "(#…)" at the end, collector from "[Auth: …]" (only when present).
    const unitTag  = resident_unit ? ` (#${String(resident_unit).replace(/^#/, '')})` : '';
    const authTag  = authorized_collector ? ` [Auth: ${authorized_collector}]` : '';
    const opp_name = `${parcel_reference} — ${resident_name || 'Resident'}${unitTag}${authTag}`;

    // Fire the GHL workflow webhook — the workflow owns opportunity creation and
    // contact linking. Server-side we only gate on the dedup check above.
    await ghl.postWebhook(PARCEL_WEBHOOK, {
      event:                'parcel_registered',
      parcel_reference,
      courier:              courier || '',
      description:          description || '',
      authorized_collector: authorized_collector || '',
      opp_name,
      resident_name:        resident_name || '',
      resident_email:       resident_email || '',
      resident_unit:        resident_unit || '',
      resident_contact_id:  resident_contact_id || '',
    });
    console.log(`[parcel] webhook fired for ${parcel_reference}${courier ? ' via ' + courier : ''}${authorized_collector ? ' auth:' + authorized_collector : ''} for #${resident_unit}`);

    // Persist the full submission to Mongo (resident-facing source of truth across
    // devices + both portals). Non-fatal.
    if (dbReady() && (resident_contact_id || resident_email)) {
      Parcel.create({
        contact_id:           resident_contact_id || '',
        email:                (resident_email || '').toLowerCase(),
        unit:                 resident_unit || '',
        parcel_reference,
        courier:              courier || '',
        description:          description || '',
        authorized_collector: authorized_collector || '',
      }).catch(e => console.warn('[parcel] DB save failed:', e.message));
    }

    return res.json({ success: true, message: 'Guardhouse notified.', reference: parcel_reference });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL request failed.';
    console.error('[parcel] webhook failed:', msg);
    return res.status(502).json({ success: false, message: `Notification failed: ${msg}` });
  }
}

// GET /api/parcel/mine — the logged-in resident's own parcel notifications (full
// detail), newest first. Identity from the signed token (middleware sets query).
async function listMine(req, res) {
  const contact_id = String(req.query.contact_id || '').trim();
  const email      = String(req.query.email || '').trim().toLowerCase();
  if (!dbReady()) return res.json({ success: true, items: [] });
  const or = [];
  if (contact_id) or.push({ contact_id });
  if (email)      or.push({ email });
  if (!or.length) return res.json({ success: true, items: [] });
  try {
    const rows = await Parcel.find({ $or: or }).sort({ created_at: -1 }).limit(100).lean();
    return res.json({ success: true, items: rows.map(r => ({
      ref: r.parcel_reference, courier: r.courier, desc: r.description, collector: r.authorized_collector, ts: r.created_at,
    })) });
  } catch (e) {
    console.warn('[parcel] mine failed:', e.message);
    return res.json({ success: true, items: [] });
  }
}

module.exports = { notifyParcel, listMine };
