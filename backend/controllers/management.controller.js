const mongoose  = require('mongoose');
const ghl        = require('../services/ghl.service');
const residents  = require('../services/residents.service');
const { getPipeline } = require('../config/pipelines');
const Defect     = require('../models/defect.model');

const dbReady = () => mongoose.connection.readyState === 1;

const UNIT_FIELD_ID     = '6PZk0sj00b6l58c7jS7U';
const MGMT_GUEST_WEBHOOK = process.env.MERIDIAN_WEBHOOK_GUEST_MGMT || '';
const REF_RE = /GST-\d{8}-\d{4}/;

// GET /api/management/contacts/search?q=...  — resident typeahead for the host picker.
async function searchContacts(req, res) {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ success: true, contacts: [] });
  if (!ghl.isConfigured()) return res.status(503).json({ success: false, message: 'GHL not configured.' });
  try {
    const data = await ghl.ghlGet('/contacts/', { params: { locationId: ghl.LOCATION, query: q } });
    const contacts = (data.contacts || []).slice(0, 8).map(c => ({
      id:    c.id,
      name:  `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email || '(no name)',
      email: c.email || '',
      unit:  (c.customFields || []).find(f => f.id === UNIT_FIELD_ID)?.value || '',
    }));
    return res.json({ success: true, contacts });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL request failed.';
    return res.status(502).json({ success: false, message: `Search failed: ${msg}` });
  }
}

// POST /api/management/guest — management registers a guest on a resident's behalf.
async function registerGuest(req, res) {
  const {
    host_contact_id, host_name, host_unit, host_email,
    visitor_type, visitor_name, visitor_ic, visitor_vehicle,
    visit_date, visit_time, link_facility, notes,
  } = req.body || {};

  if ((!host_contact_id && !host_email) || !visitor_name || !visit_date) {
    return res.status(400).json({ success: false, message: 'Resident, visitor name, and visit date are required.' });
  }
  if (!MGMT_GUEST_WEBHOOK) {
    return res.status(503).json({ success: false, message: 'Management guest registration is not configured on the server yet.' });
  }

  const reference = `GST-${(visit_date || '').replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
  const qr_url = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=12&data=${encodeURIComponent(reference)}`;

  // Canonical guest opportunity name the workflow uses — same format as the resident
  // path so the guardhouse parses "<REF> — <Visitor> (#<unit>)" and sees the facility.
  const unitTag     = host_unit ? ` (#${String(host_unit).replace(/^#/, '')})` : '';
  const facilityTag = link_facility ? ` · ${link_facility}` : '';
  const opp_name    = `${reference} — ${visitor_name}${unitTag}${facilityTag}`;

  // Auto-render the resident (host) into GHL: ensure the contact exists and is
  // up to date by email, so the account is created in GHL if it wasn't already.
  let hostId = host_contact_id;
  if (host_email) {
    try {
      const parts = String(host_name || '').split(/\s+/).filter(Boolean);
      const c = await ghl.upsertContact({
        email:     host_email,
        firstName: parts[0] || host_email,
        lastName:  parts.slice(1).join(' '),
        customFields: host_unit ? [{ id: UNIT_FIELD_ID, field_value: String(host_unit).replace(/^#/, '') }] : [],
      });
      if (c && c.id) hostId = c.id;
    } catch (e) {
      console.warn('[mgmt-guest] host upsert failed:', e.response?.data?.message || e.message);
    }
  }

  try {
    await ghl.postWebhook(MGMT_GUEST_WEBHOOK, {
      event:           'guest_registration_management',
      registered_by:   'management',
      reference,
      host_contact_id: hostId,
      host_name:       host_name || '',
      host_unit:       host_unit || '',
      host_email:      host_email || '',
      visitor_type:    visitor_type || 'Social Guest',
      visitor_name,
      visitor_ic:      visitor_ic || '',
      visitor_vehicle: visitor_vehicle || '',
      visit_date,
      visit_time:      visit_time || '',
      link_facility:   link_facility || '',
      opp_name,
      notes:           notes || '',
      qr_url,
    });
    console.log(`[mgmt-guest] ${visitor_name} (${reference}) for unit #${host_unit} by management`);
    return res.json({ success: true, message: 'Visitor registered.', reference, qr_url });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL request failed.';
    console.error('[mgmt-guest] webhook failed:', msg);
    return res.status(502).json({ success: false, message: `Registration failed: ${msg}` });
  }
}

// Parse a guest-pipeline opportunity into a structured row. Guest data lives in a
// mix of the opportunity name ("<REF> — <Visitor> (#<unit>)"), custom fields, and
// the linked host contact — so we pull from all three defensively.
function parseGuestOpp(o, stageNames) {
  const cfs    = o.customFields || [];
  const cfVal  = (re) => { const f = cfs.find(c => re.test(c.label || '')); return f ? (f.fieldValueString || f.value || '') : ''; };
  const allVal = cfs.map(c => c.fieldValueString || c.value || '').filter(Boolean);
  const name   = o.name || '';

  let reference = (REF_RE.exec(name) || [])[0] || '';
  if (!reference) for (const v of allVal) { const m = REF_RE.exec(v); if (m) { reference = m[0]; break; } }

  const m    = name.match(/—\s*(.+?)\s*\(#?([^)]+)\)\s*$/);
  const host = (o.contact && (o.contact.name || `${o.contact.firstName || ''} ${o.contact.lastName || ''}`.trim())) || '';
  let visitor = cfVal(/visitor.?name|guest.?name|full.?name/i) || (m ? m[1].trim() : '');
  if (!visitor && name && name !== host && !REF_RE.test(name)) visitor = name;
  let unit = cfVal(/unit|apartment|block/i) || (m ? m[2].trim() : '');

  const phone = cfVal(/phone|mobile|contact.?number/i) || (o.contact && o.contact.phone) || '';
  let visitDate = cfVal(/visit.?date|date.?of.?visit|arrival/i) || '';
  if (!visitDate && reference) { const dm = reference.match(/-(\d{4})(\d{2})(\d{2})-/); if (dm) visitDate = `${dm[1]}-${dm[2]}-${dm[3]}`; }

  return {
    oppId:     o.id,
    contactId: (o.contact && o.contact.id) || o.contactId || '',
    reference,
    visitor:   visitor || '(guest)',
    host:      host || '—',
    unit:      String(unit || '').replace(/^#/, ''),
    phone,
    visitDate,
    stage:     stageNames[o.pipelineStageId] || o.status || 'Registered',
    createdAt: o.createdAt,
  };
}

// GET /api/management/guests — every registered guest across all residents,
// from the Guest Registrations pipeline. Management-only.
async function listGuests(req, res) {
  if (!ghl.isConfigured()) return res.status(503).json({ success: false, message: 'GHL not configured.' });
  const guest      = getPipeline('guest');
  const stageNames = Object.fromEntries(Object.entries(guest.stages).map(([k, v]) => [v, k]));
  try {
    const data  = await ghl.ghlGet('/opportunities/search', {
      params: { location_id: ghl.LOCATION, pipeline_id: guest.id, limit: 100 },
    });
    const items = (data.opportunities || [])
      .map(o => parseGuestOpp(o, stageNames))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json({ success: true, items, total: items.length, stages: Object.keys(guest.stages) });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL request failed.';
    console.error('[mgmt-guests] list failed:', msg);
    return res.status(502).json({ success: false, message: msg });
  }
}

// PUT /api/management/guests/:id/stage  body: { stage } — move a guest opportunity
// to a new stage (Registered, Checked In, Checked Out, Departed, Closed).
async function updateGuestStage(req, res) {
  const { id } = req.params;
  const { stage } = req.body || {};
  if (!id)    return res.status(400).json({ success: false, message: 'Opportunity id is required.' });
  if (!stage) return res.status(400).json({ success: false, message: 'Stage is required.' });
  if (!ghl.isConfigured()) return res.status(503).json({ success: false, message: 'GHL not configured.' });

  const guest   = getPipeline('guest');
  const stageId = guest.stages[stage];
  if (!stageId) return res.status(400).json({ success: false, message: `Unknown stage: ${stage}` });

  try {
    await ghl.ghlPut(`/opportunities/${id}`, { pipelineId: guest.id, pipelineStageId: stageId }, { version: '2021-07-28' });
    console.log(`[mgmt-guests] opportunity ${id} moved to "${stage}"`);
    return res.json({ success: true, message: `Guest moved to ${stage}.`, stage });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL error.';
    console.error('[mgmt-guests] stage update failed:', msg);
    return res.status(err.response?.status || 502).json({ success: false, message: msg });
  }
}

// Generic parse of an opportunity into a management row (Reference · Contact · Unit · Date · Stage).
function parseOpp(o, stageNames) {
  const cfs    = o.customFields || [];
  const cfVal  = (re) => { const f = cfs.find(c => re.test(c.label || '')); return f ? (f.fieldValueString || f.value || '') : ''; };
  const name    = o.name || '';
  const contact = (o.contact && (o.contact.name || `${o.contact.firstName || ''} ${o.contact.lastName || ''}`.trim())) || '';
  // Support "(#unit)" / "— #unit" at the end, and "(#unit)" mid-name (e.g. move names
  // are "Move-In — Name (#unit) · <date>", where the unit isn't the last token).
  const um      = name.match(/\(#?([^)]+)\)\s*(?:\[.*\])?\s*$/) || name.match(/—\s*#([^\s\]—]+)\s*$/) || name.match(/\(#([^)]+)\)/);
  const unit    = cfVal(/unit|apartment|block/i) || (um ? um[1].trim() : '');
  // Strip leading [Urgency] tag from display — it has its own column on defects.
  const reference = name.replace(/^\[(?:emergency|urgent|routine)\]\s*/i, '') || o.id;
  return {
    oppId:     o.id,
    contactId: (o.contact && o.contact.id) || o.contactId || '',
    reference,
    contact:   contact || '—',
    unit:      String(unit || '').replace(/^#/, ''),
    stage:     stageNames[o.pipelineStageId] || o.status || '',
    urgency:   (name.match(/\[(emergency|urgent|routine)\]/i) || [])[1]
               || cfs.map(f => String(f.fieldValueString || f.value || '')).find(v => /^(emergency|urgent|routine)$/i.test(v))
               || '',
    createdAt: o.createdAt,
  };
}

// GET /api/management/opportunities?pipeline=defect — all opportunities in a pipeline.
async function listOpportunities(req, res) {
  const key      = String(req.query.pipeline || '').trim();
  const pipeline = key && getPipeline(key);
  if (!pipeline) return res.status(400).json({ success: false, message: `Unknown pipeline: ${key}` });
  if (!ghl.isConfigured()) return res.status(503).json({ success: false, message: 'GHL not configured.' });
  const stageNames = Object.fromEntries(Object.entries(pipeline.stages).map(([k, v]) => [v, k]));
  try {
    const data  = await ghl.ghlGet('/opportunities/search', {
      params: { location_id: ghl.LOCATION, pipeline_id: pipeline.id, limit: 100 },
    });
    const URGENCY_RANK = { emergency: 0, urgent: 1, routine: 2 };
    const urgencyRank  = u => URGENCY_RANK[(u || '').toLowerCase().match(/emergency|urgent|routine/)?.[0]] ?? 3;
    let items = (data.opportunities || [])
      .map(o => parseOpp(o, stageNames))
      .sort((a, b) => {
        // Defects: primary sort by urgency (Emergency → Urgent → Routine), secondary by date.
        if (key === 'defect') {
          const ud = urgencyRank(a.urgency) - urgencyRank(b.urgency);
          if (ud !== 0) return ud;
        }
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

    // Merge stored photos for defect items (matched by contact_id + nearest submission time).
    if (key === 'defect' && dbReady()) {
      const contactIds = [...new Set(items.map(i => i.contactId).filter(Boolean))];
      if (contactIds.length) {
        const records = await Defect.find({ contact_id: { $in: contactIds } }).sort({ created_at: -1 });
        const used = new Set();
        items = items.map(item => {
          const match = records.find(r =>
            !used.has(r._id.toString()) &&
            r.contact_id === item.contactId &&
            Math.abs(new Date(item.createdAt) - new Date(r.created_at)) < 10 * 60 * 1000
          );
          if (match) used.add(match._id.toString());
          return match && match.defect_file ? { ...item, photo: match.defect_file } : item;
        });
      }
    }

    return res.json({ success: true, items, total: items.length, stages: Object.keys(pipeline.stages) });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL request failed.';
    console.error(`[mgmt-opps:${key}] list failed:`, msg);
    return res.status(502).json({ success: false, message: msg });
  }
}

// Maps a pipeline stage to the contact tag that fires its "Status Change" workflow
// (which emails the resident). The portal moves the stage directly; this tag is
// what triggers the email — without it a management stage change is silent.
const STAGE_TAGS = {
  move: {
    'Confirmed':        'move-confirmed',
    'Completed':        'move-completed',
    'Deposit Refunded': 'move-deposit-refunded',
  },
  guest: {
    'Checked In':  'guest-checked-in',
    'Checked Out': 'guest-checked-out',
    'Departed':    'guest-departed',
    'Closed':      'guest-closed',
  },
  defect: {
    'Acknowledged': 'defect-acknowledged',
    'In Progress':  'defect-in-progress',
    'Resolved':     'defect-resolved',
    'Closed':       'defect-closed',
  },
  parcel: {
    'Notified':                'parcel-notified',
    'Collected':               'parcel-collected',
    'Uncollected / Returned':  'parcel-returned',
  },
  feedback: {
    'Under Review': 'feedback-under-review',
    'Resolved':     'feedback-resolved',
    'Closed':       'feedback-closed',
  },
};

// PUT /api/management/opportunities/:id/stage  body: { pipeline, stage }
async function updateOpportunityStage(req, res) {
  const { id } = req.params;
  const { pipeline: key, stage } = req.body || {};
  const pipeline = key && getPipeline(key);
  if (!id || !stage || !pipeline) {
    return res.status(400).json({ success: false, message: 'id, pipeline, and stage are required.' });
  }
  if (!ghl.isConfigured()) return res.status(503).json({ success: false, message: 'GHL not configured.' });
  const stageId = pipeline.stages[stage];
  if (!stageId) return res.status(400).json({ success: false, message: `Unknown stage: ${stage}` });
  try {
    await ghl.ghlPut(`/opportunities/${id}`, { pipelineId: pipeline.id, pipelineStageId: stageId }, { version: '2021-07-28' });
    console.log(`[mgmt-opps:${key}] opportunity ${id} → ${stage}`);

    // Tag the contact so the matching Status Change workflow emails the resident.
    // Non-fatal — a tagging failure must never fail the stage move itself.
    const tag = (STAGE_TAGS[key] || {})[stage];
    if (tag) {
      try {
        const data      = await ghl.ghlGet(`/opportunities/${id}`);
        const opp       = data.opportunity || data;
        const contactId = opp.contactId || (opp.contact && opp.contact.id) || '';
        if (contactId) await ghl.ghlPost(`/contacts/${contactId}/tags`, { tags: [tag] });
      } catch (e) {
        console.warn(`[mgmt-opps:${key}] status tag add failed (non-fatal):`, e.response?.data?.message || e.message);
      }
    }
    return res.json({ success: true, message: `Moved to ${stage}.`, stage });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL error.';
    console.error(`[mgmt-opps:${key}] stage update failed:`, msg);
    return res.status(err.response?.status || 502).json({ success: false, message: msg });
  }
}

// GET /api/management/residents — all resident accounts (the source of truth for
// who can log in), with their linked GHL contact id. Management-only.
async function listResidents(req, res) {
  try {
    const rows = await residents.listResidents();
    const list = (rows || []).map(r => ({
      name:      r.name || r.email || '(no name)',
      unit:      String(r.unit || '').replace(/^#/, ''),
      email:     r.email || '',
      phone:     r.phone || '',
      type:      r.residentType || 'Resident',
      ghlLinked: !!r.ghl_contact_id,
    })).sort((a, b) => a.unit.localeCompare(b.unit));
    return res.json({ success: true, residents: list, total: list.length });
  } catch (err) {
    const msg = err.message || 'Failed to load residents.';
    console.error('[mgmt-residents] list failed:', msg);
    return res.status(502).json({ success: false, message: msg });
  }
}

module.exports = { searchContacts, registerGuest, listGuests, updateGuestStage, listOpportunities, updateOpportunityStage, listResidents };
