const mongoose = require('mongoose');
const ghl = require('../services/ghl.service');
const { getPipeline } = require('../config/pipelines');
const GuardLog = require('../models/guardlog.model');

const dbReady = () => mongoose.connection.readyState === 1;

// GET /api/guardhouse/lookup?reference=GST-... — resolve a guest pass by its
// reference. Searches the Guest Registrations pipeline (the workflow names each
// opportunity "<REF> — <Visitor> (#<unit>)"). Visit date is parsed from the
// reference itself (GST-YYYYMMDD-####).
async function lookup(req, res) {
  const reference = String(req.query.reference || req.query.ref || '').trim();
  if (!reference) return res.status(400).json({ success: false, message: 'Reference is required.' });
  if (!ghl.isConfigured()) return res.status(503).json({ success: false, message: 'GHL is not configured on the server.' });

  const guest = getPipeline('guest');
  try {
    const data = await ghl.ghlGet('/opportunities/search', {
      params: { location_id: ghl.LOCATION, q: reference, pipeline_id: guest.id },
    });
    const opps = data.opportunities || [];
    const opp  = opps.find(o => (o.name || '').startsWith(reference)) || null;
    if (!opp) return res.json({ success: true, found: false });

    // Parse "<REF> — <Visitor> (#<unit>)"
    const m        = (opp.name || '').match(/—\s*(.+?)\s*\(#([^)]+)\)/);
    const visitor  = m ? m[1].trim() : '';
    const hostUnit = m ? m[2].trim() : '';

    // Visit date embedded in the reference: GST-YYYYMMDD-####
    const dm        = reference.match(/-(\d{4})(\d{2})(\d{2})-/);
    const visitDate = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : '';

    // Current stage name (reverse-map the stage ID).
    const stageName = Object.keys(guest.stages).find(n => guest.stages[n] === opp.pipelineStageId) || '';

    return res.json({
      success: true,
      found:   true,
      reference,
      visitor,
      hostUnit,
      hostContactId: (opp.contact && opp.contact.id) || opp.contactId || '',
      opportunityId: opp.id,
      visitDate,
      stage:   stageName,
      status:  opp.status || '',
    });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL request failed.';
    console.error('[guardhouse] lookup failed:', msg);
    return res.status(502).json({ success: false, message: `Lookup failed: ${msg}` });
  }
}

// Tag applied to the host contact (drives any GHL email/automation).
// action: 'checkin' → guest-checked-in, 'checkout' → guest-checked-out, 'depart' → guest-departed
const ACTION_TAG = {
  checkin:  'guest-checked-in',
  checkout: 'guest-checked-out',
  depart:   'guest-departed',
};
// POST /api/guardhouse/checkin  body: { contact_id, action }
// Tags the host contact; the "Guest Registrations — Status Change" workflow reacts
// to the tag, moves the guest opportunity's stage, and emails the host.
async function checkin(req, res) {
  const { contact_id, action } = req.body || {};
  const tag = ACTION_TAG[action] || 'guest-checked-in';

  if (!ghl.isConfigured()) {
    return res.status(503).json({ success: false, message: 'GHL is not configured on the server.' });
  }
  if (!contact_id) {
    return res.status(400).json({ success: false, message: 'contact_id is required.' });
  }

  try {
    await ghl.ghlPost(`/contacts/${contact_id}/tags`, { tags: [tag] });
    console.log(`[guardhouse] tagged ${contact_id} → ${tag} (workflow moves the stage)`);
    return res.json({ success: true, tag });
  } catch (e) {
    const msg = e.response?.data?.message || e.message || 'GHL error.';
    console.error('[guardhouse] tag failed:', msg);
    return res.status(502).json({ success: false, message: 'Could not update the guest pass. Please try again.' });
  }
}

// Parcel checker — a guardhouse action tags the host contact; the "Parcel — Status
// Change" workflow reacts to the tag, moves the opportunity stage, and emails the resident.
const PARCEL_STATUS_TAG = {
  received:    'parcel-notified',   // received & holding → notify resident it's ready
  hold:        'parcel-notified',   // legacy alias
  collected:   'parcel-collected',  // picked up by the resident
  uncollected: 'parcel-returned',   // not collected → returned to sender
};

// Find a parcel-pipeline opportunity by reference — the most recent match, so the
// same parcel resolves consistently even if duplicates exist.
async function findParcelOpp(reference) {
  const parcel = getPipeline('parcel');
  const data   = await ghl.ghlGet('/opportunities/search', {
    params: { location_id: ghl.LOCATION, q: reference, pipeline_id: parcel.id },
  });
  const ref  = reference.toLowerCase();
  const opps = (data.opportunities || [])
    .filter(o => (o.name || '').toLowerCase().includes(ref)
      || (o.customFields || []).some(f => String(f.fieldValueString || f.value || '').toLowerCase().includes(ref)))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return opps[0] || null;
}

// GET /api/guardhouse/parcel?reference= — resolve a parcel by reference.
async function parcelLookup(req, res) {
  const reference = String(req.query.reference || req.query.ref || '').trim();
  if (!reference) return res.status(400).json({ success: false, message: 'A parcel reference is required.' });
  if (!ghl.isConfigured()) return res.status(503).json({ success: false, message: 'GHL is not configured on the server.' });

  const parcel     = getPipeline('parcel');
  const stageNames = Object.fromEntries(Object.entries(parcel.stages).map(([k, v]) => [v, k]));
  try {
    const opp = await findParcelOpp(reference);
    if (!opp) return res.json({ success: true, found: false });
    const resident    = (opp.contact && (opp.contact.name || `${opp.contact.firstName || ''} ${opp.contact.lastName || ''}`.trim())) || '';
    const um          = (opp.name || '').match(/\(#?([^)]+)\)\s*(?:\[Auth:[^\]]*\])?\s*$/);
    const authMatch   = (opp.name || '').match(/\[Auth:\s*([^\]]+)\]/);
    return res.json({
      success:              true,
      found:                true,
      reference,
      opportunityId:        opp.id,
      resident:             resident || '—',
      unit:                 um ? um[1].trim().replace(/^#/, '') : '',
      stage:                stageNames[opp.pipelineStageId] || opp.status || 'Received',
      authorizedCollector:  authMatch ? authMatch[1].trim() : '',
    });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL request failed.';
    console.error('[guardhouse] parcel lookup failed:', msg);
    return res.status(502).json({ success: false, message: `Lookup failed: ${msg}` });
  }
}

// POST /api/guardhouse/parcel/status  body: { opportunity_id?, reference?, status }
// status: 'hold' | 'collected' | 'uncollected'
// Tags the host contact; the workflow owns the stage move (no direct write here).
async function parcelStatus(req, res) {
  const { opportunity_id, reference, status } = req.body || {};
  const tag = PARCEL_STATUS_TAG[status];
  if (!tag) return res.status(400).json({ success: false, message: 'Invalid status.' });
  if (!ghl.isConfigured()) return res.status(503).json({ success: false, message: 'GHL is not configured on the server.' });

  // Resolve the parcel's host contact (explicit opp id first, else by reference).
  let contactId = '';
  try {
    if (opportunity_id) {
      const data = await ghl.ghlGet(`/opportunities/${opportunity_id}`);
      const opp  = data.opportunity || data;
      contactId  = opp.contactId || (opp.contact && opp.contact.id) || '';
    }
    if (!contactId && reference) {
      const opp = await findParcelOpp(String(reference).trim());
      contactId = opp ? ((opp.contact && opp.contact.id) || opp.contactId || '') : '';
    }
  } catch (e) {
    console.warn('[guardhouse] parcel contact lookup failed:', e.response?.data?.message || e.message);
  }
  if (!contactId) return res.status(404).json({ success: false, message: 'Parcel not found for that reference.' });

  try {
    await ghl.ghlPost(`/contacts/${contactId}/tags`, { tags: [tag] });
    console.log(`[guardhouse] parcel "${reference || opportunity_id}" → tagged ${tag} (workflow moves the stage)`);
    return res.json({ success: true, tag });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL error.';
    console.error('[guardhouse] parcel tag failed:', msg);
    return res.status(502).json({ success: false, message: 'Could not update the parcel. Please try again.' });
  }
}

// Shared activity log — a "today" feed that resets naturally at SGT midnight
// (older rows stay in the DB as an audit trail).
function sgtDayStart() {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  return new Date(`${day}T00:00:00+08:00`);
}
const fmtLog = (e) => ({
  id:   String(e._id), cat: e.cat, key: e.key, type: e.type,
  label: e.label, name: e.name, meta: e.meta,
  time: new Date(e.updatedAt).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Singapore',
  }),
});

// GET /api/guardhouse/log — today's shared entries (newest first), seen by every station.
async function listLog(req, res) {
  if (!dbReady()) return res.json({ success: true, entries: [] });
  try {
    const rows = await GuardLog.find({ updatedAt: { $gte: sgtDayStart() } })
      .sort({ updatedAt: -1 }).limit(300).lean();
    return res.json({ success: true, entries: rows.map(fmtLog) });
  } catch (e) {
    console.warn('[guardhouse] log list failed:', e.message);
    return res.json({ success: true, entries: [] });
  }
}

// POST /api/guardhouse/log — record an action. Entries with a `key` upsert (so a
// parcel's status change updates its single row); keyless entries always insert.
async function addLog(req, res) {
  if (!dbReady()) return res.json({ success: true });
  const { cat, key, type, label, name, meta } = req.body || {};
  const fields = { cat: cat || 'guest', type: type || '', label: label || '', name: name || '', meta: meta || '' };
  try {
    if (key) {
      await GuardLog.findOneAndUpdate({ key }, { $set: { ...fields, key } }, { upsert: true, new: true });
    } else {
      await GuardLog.create(fields);
    }
    return res.json({ success: true });
  } catch (e) {
    console.warn('[guardhouse] log add failed:', e.message);
    return res.status(502).json({ success: false, message: 'Could not record the log entry.' });
  }
}

// DELETE /api/guardhouse/log?scope=parcel|guest — clear today's entries of a category.
async function clearLog(req, res) {
  if (!dbReady()) return res.json({ success: true });
  const scope = String(req.query.scope || '').trim();
  const catFilter = scope === 'parcel' ? { cat: 'parcel' } : { cat: { $ne: 'parcel' } };
  try {
    await GuardLog.deleteMany({ ...catFilter, updatedAt: { $gte: sgtDayStart() } });
    return res.json({ success: true });
  } catch (e) {
    console.warn('[guardhouse] log clear failed:', e.message);
    return res.status(502).json({ success: false, message: 'Could not clear the log.' });
  }
}

module.exports = { lookup, checkin, parcelLookup, parcelStatus, listLog, addLog, clearLog };
