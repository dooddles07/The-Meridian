const mongoose = require('mongoose');
const ghl = require('../services/ghl.service');
const Feedback = require('../models/feedback.model');

const dbReady = () => mongoose.connection.readyState === 1;

// GHL Inbound Webhook that triggers the "Feedback — New" workflow, which owns
// opportunity creation. Creating the opp directly here skipped the workflow, so no
// acknowledgement email or management notice ever fired.
const FEEDBACK_WEBHOOK = process.env.LUMINA_WEBHOOK_FEEDBACK || '';

// POST /api/feedback — resident submits feedback, a complaint, or a suggestion.
async function submitFeedback(req, res) {
  const {
    type, category, description, incident_date, incident_time,
    resident_name, resident_email, resident_unit, resident_contact_id,
  } = req.body || {};

  if (!description) {
    return res.status(400).json({ success: false, message: 'A description is required.' });
  }
  if (!FEEDBACK_WEBHOOK) {
    return res.status(503).json({ success: false, message: 'Feedback is not configured on the server yet.' });
  }

  // Type-prefixed reference: Complaint → CMP, Feedback → FBK, Suggestion → SUG.
  const t      = type || 'Feedback';
  const prefix = { Complaint: 'CMP', Feedback: 'FBK', Suggestion: 'SUG' }[t] || 'FBK';
  const today  = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }).replace(/-/g, '');
  const reference = `${prefix}-${today}-${Math.floor(1000 + Math.random() * 9000)}`;

  // Canonical opportunity name the workflow uses.
  const unitTag  = resident_unit ? ` (#${String(resident_unit).replace(/^#/, '')})` : '';
  const opp_name = `${reference} — ${t}${category ? ' · ' + category : ''}${unitTag}`;

  try {
    await ghl.postWebhook(FEEDBACK_WEBHOOK, {
      event:               'feedback',
      reference,
      type:                t,
      category:            category || '',
      description,
      incident_date:       incident_date || '',
      incident_time:       incident_time || '',
      opp_name,
      resident_name:       resident_name || '',
      resident_email:      resident_email || '',
      resident_unit:       resident_unit || '',
      resident_contact_id: resident_contact_id || '',
    });
    console.log(`[feedback] ${t} (${reference}) by #${resident_unit} — ${category}`);

    // Persist the full submission to Mongo (resident-facing source of truth across
    // devices + both portals). Non-fatal.
    if (dbReady() && (resident_contact_id || resident_email)) {
      Feedback.create({
        contact_id:    resident_contact_id || '',
        email:         (resident_email || '').toLowerCase(),
        unit:          resident_unit || '',
        reference,
        type:          t,
        category:      category || '',
        description,
        incident_date: incident_date || '',
        incident_time: incident_time || '',
      }).catch(e => console.warn('[feedback] DB save failed:', e.message));
    }

    return res.json({ success: true, message: 'Feedback submitted.', reference });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL request failed.';
    console.error('[feedback] webhook failed:', msg);
    return res.status(502).json({ success: false, message: `Submission failed: ${msg}` });
  }
}

// GET /api/feedback/mine — the logged-in resident's own submissions (full detail),
// newest first. Identity from the signed token (middleware sets query).
async function listMine(req, res) {
  const contact_id = String(req.query.contact_id || '').trim();
  const email      = String(req.query.email || '').trim().toLowerCase();
  if (!dbReady()) return res.json({ success: true, items: [] });
  const or = [];
  if (contact_id) or.push({ contact_id });
  if (email)      or.push({ email });
  if (!or.length) return res.json({ success: true, items: [] });
  try {
    const rows = await Feedback.find({ $or: or }).sort({ created_at: -1 }).limit(100).lean();
    return res.json({ success: true, items: rows.map(r => ({
      type: r.type, category: r.category, desc: r.description,
      incident_date: r.incident_date, incident_time: r.incident_time, ts: r.created_at,
    })) });
  } catch (e) {
    console.warn('[feedback] mine failed:', e.message);
    return res.json({ success: true, items: [] });
  }
}

module.exports = { submitFeedback, listMine };
