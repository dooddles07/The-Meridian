const mongoose  = require('mongoose');
const ghl        = require('../services/ghl.service');
const Defect     = require('../models/defect.model');

const dbReady = () => mongoose.connection.readyState === 1;

const DEFECT_WEBHOOK = process.env.MERIDIAN_WEBHOOK_DEFECT || '';

// POST /api/defect — resident submits a defect report.
async function submitDefect(req, res) {
  const {
    description, location, category, secondaryCategory, urgency, defect_file,
    resident_name, resident_email, resident_unit, resident_contact_id,
  } = req.body || {};

  if (!description) {
    return res.status(400).json({ success: false, message: 'A description of the issue is required.' });
  }
  if (!DEFECT_WEBHOOK) {
    return res.status(503).json({ success: false, message: 'Defect reporting is not configured on the server yet.' });
  }

  const catDisplay = secondaryCategory ? `${category} + ${secondaryCategory}` : category;
  // Canonical opportunity name the workflow uses.
  const unitTag  = resident_unit ? ` (#${String(resident_unit).replace(/^#/, '')})` : '';
  const opp_name = `[${urgency || 'Routine'}] ${catDisplay || 'Defect'} — ${location || 'Unit'}${unitTag}`;

  try {
    await ghl.postWebhook(DEFECT_WEBHOOK, {
      event:        'defect_report',
      description,
      location:     location || '',
      category:     category || '',
      secondaryCategory: secondaryCategory || '',
      urgency:      urgency  || 'Routine',
      defect_file:  defect_file || '',
      opp_name,
      resident_name:       resident_name || '',
      resident_email:      resident_email || '',
      resident_unit:       resident_unit || '',
      resident_contact_id: resident_contact_id || '',
    });

    // Persist the full submission to Mongo (resident-facing source of truth across
    // devices + both portals) — also lets management show the photo alongside the opp.
    if (dbReady() && (resident_contact_id || resident_email)) {
      Defect.create({
        contact_id:  resident_contact_id || '',
        email:       (resident_email || '').toLowerCase(),
        unit:        resident_unit || '',
        category:    catDisplay,
        urgency:     urgency || 'Routine',
        location:    location || '',
        description,
        defect_file: defect_file || '',
      }).catch(e => console.warn('[defect] DB save failed:', e.message));
    }

    console.log(`[defect] Report submitted by #${resident_unit} — ${catDisplay} / ${urgency}`);
    return res.json({ success: true, message: 'Defect report submitted.' });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL request failed.';
    console.error('[defect] webhook failed:', msg);
    return res.status(502).json({ success: false, message: `Submission failed: ${msg}` });
  }
}

// GET /api/defect/mine — the logged-in resident's own defect submissions (full text),
// newest first. Identity comes from the signed token (middleware overwrites query).
// Recovers the full description/details that the GHL opp name omits.
async function listMine(req, res) {
  const contact_id = String(req.query.contact_id || '').trim();
  const email      = String(req.query.email || '').trim().toLowerCase();
  if (!dbReady()) return res.json({ success: true, items: [] });
  const or = [];
  if (contact_id) or.push({ contact_id });
  if (email)      or.push({ email });
  if (!or.length) return res.json({ success: true, items: [] });
  try {
    const rows = await Defect.find({ $or: or }).sort({ created_at: -1 }).limit(100).lean();
    return res.json({ success: true, items: rows.map(r => ({
      desc: r.description, category: r.category, location: r.location, urgency: r.urgency, ts: r.created_at,
    })) });
  } catch (e) {
    console.warn('[defect] mine failed:', e.message);
    return res.json({ success: true, items: [] });
  }
}

module.exports = { submitDefect, listMine };
