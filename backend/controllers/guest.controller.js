const ghl = require('../services/ghl.service');
// GHL Inbound Webhook that triggers the Guest Registrations workflow.
const GUEST_WEBHOOK = process.env.LUMINA_WEBHOOK_GUEST || '';

// POST /api/guest — register a visitor against the logged-in resident (host).
async function registerGuest(req, res) {
  const {
    visitor_type, visitor_name, visitor_email, visitor_phone, visit_date, duration,
    host_name, host_email, host_unit, host_contact_id,
    linked_booking_id, linked_facility, linked_date,
  } = req.body || {};

  if (!visitor_type || !visitor_name || !visitor_email || !visit_date) {
    return res.status(400).json({ success: false, message: 'Visitor type, name, email, and visit date are required.' });
  }
  if (!GUEST_WEBHOOK) {
    return res.status(503).json({ success: false, message: 'Guest registration is not configured on the server yet.' });
  }

  // Unique guest reference code for every registration, e.g. GST-20260620-4821.
  const reference = `GST-${(visit_date || '').replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

  // QR encodes ONLY the reference — the guardhouse looks up the full registration
  // in GHL by this reference (single source of truth); the visit date is also
  // embedded in the reference (GST-YYYYMMDD-####) for date-gating.
  const qr_url = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=12&data=${encodeURIComponent(reference)}`;

  // Canonical guest opportunity name the workflow uses. Format the guardhouse
  // parses: "<REF> — <Visitor> (#<unit>)". When the guest is attending a facility
  // booking we append " · <Facility>" — the parser still reads visitor + unit, and
  // management/guardhouse can see where the guest is headed.
  const unitTag    = host_unit ? ` (#${String(host_unit).replace(/^#/, '')})` : '';
  const facilityTag = linked_facility ? ` · ${linked_facility}` : '';
  const opp_name   = `${reference} — ${visitor_name}${unitTag}${facilityTag}`;

  try {
    await ghl.postWebhook(GUEST_WEBHOOK, {
      event:          'guest_registration',
      reference,
      visitor_type,
      visitor_name,
      visitor_email,
      visitor_phone:  visitor_phone || '',
      visit_date,
      duration:       duration || 'Single Visit (Day)',
      host_name:       host_name || '',
      host_email:      host_email || '',
      host_unit:       host_unit || '',
      host_contact_id: host_contact_id || '',
      // Optional link to a confirmed facility booking the guest is attending (e.g.
      // a Verandah/BBQ event), so the guest card + guardhouse show where they're headed.
      linked_booking_id: linked_booking_id || '',
      linked_facility:   linked_facility   || '',
      linked_date:       linked_date        || '',
      opp_name,
      qr_url,
    });
    console.log(`[guest] Registered "${visitor_name}" (${reference}) for unit #${host_unit} on ${visit_date}`);
    return res.json({ success: true, message: 'Visitor registered.', reference });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL request failed.';
    console.error('[guest] webhook failed:', msg);
    return res.status(502).json({ success: false, message: `Registration failed: ${msg}` });
  }
}

module.exports = { registerGuest };
