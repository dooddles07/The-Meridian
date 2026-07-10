const ghl          = require('../services/ghl.service');
const { getPipeline } = require('../config/pipelines');

// GET /api/opportunities?contact_id=xxx&email=&pipeline=guest
// Returns opportunities for a contact, optionally filtered to a pipeline key.
// Resolves the contact by email when provided (more reliable than the session id).
async function getOpportunities(req, res) {
  const { pipeline: pipelineKey, email } = req.query;
  if (!ghl.isConfigured()) return res.status(503).json({ success: false, message: 'GHL not configured.' });

  // Prefer the session contact_id (set at login by ensureContact — the same contact
  // bookings write under). Email is a READ-ONLY secondary lookup; never upsert on a
  // read (that can spawn/return a different duplicate contact and hide the records).
  const sessionId = req.query.contact_id || null;
  const emailId   = email ? await ghl.findContactIdByEmail(email).catch(() => null) : null;
  const contact_id = sessionId || emailId;
  if (!contact_id) return res.status(400).json({ success: false, message: 'contact_id or email required.' });

  // Match opps owned by either the session id or the email-resolved id.
  const validIds = new Set([sessionId, emailId].filter(Boolean).map(String));

  const pipeline = pipelineKey ? getPipeline(pipelineKey) : null;
  if (pipelineKey && !pipeline) {
    return res.status(400).json({ success: false, message: `Unknown pipeline key: ${pipelineKey}` });
  }

  const stageNames = pipeline
    ? Object.fromEntries(Object.entries(pipeline.stages).map(([k, v]) => [v, k]))
    : {};

  const params = { contact_id, location_id: ghl.LOCATION, limit: 100 };
  if (pipeline) params.pipeline_id = pipeline.id;

  try {
    const data  = await ghl.ghlGet('/opportunities/search', { params });
    const items = (data.opportunities || [])
      // GHL's /opportunities/search does not reliably honour the contact_id param
      // and may return every opportunity in the pipeline — which would leak one
      // resident's records (e.g. guests) into another's. Enforce the scope here.
      .filter(o => validIds.has(String(o.contactId || (o.contact && o.contact.id) || '')))
      .map(o => {
        const customFields = (o.customFields || []).filter(f => f.fieldValueString);
        // Guest opportunities are named after the resident contact by default.
        // Surface the visitor name from custom fields instead so the card
        // header shows who the guest is, not who the host is.
        let name = o.name;
        if (pipelineKey === 'guest') {
          const visitorField = customFields.find(f =>
            /visitor.?name|guest.?name/i.test(f.label || '')
          );
          if (visitorField?.fieldValueString) name = visitorField.fieldValueString;
        }
        let stage = stageNames[o.pipelineStageId] || o.status || 'Unknown';
        // Deposit-required bookings are never plain "Requested" — until paid they sit
        // at "Deposit Pending". Move always; facility only for deposit facilities.
        if (pipelineKey === 'move' && stage === 'Requested') stage = 'Deposit Pending';
        if (pipelineKey === 'facility' && stage === 'Requested' && /verandah|bbq|barbeque|barbecue|pool|swimming/i.test(name || '')) {
          stage = 'Deposit Pending';
        }
        return {
          id:           o.id,
          name,
          stage,
          pipelineId:   o.pipelineId,
          createdAt:    o.createdAt,
          customFields,
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json({ success: true, items, total: items.length });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL request failed.';
    console.error('[opportunities] fetch failed:', msg);
    return res.status(502).json({ success: false, message: msg });
  }
}

module.exports = { getOpportunities };
