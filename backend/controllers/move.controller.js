const mongoose = require('mongoose');
const ghl = require('../services/ghl.service');
const Move = require('../models/move.model');

const dbReady = () => mongoose.connection.readyState === 1;

// GHL Inbound Webhook that triggers the "Move-In/Move-Out — New" workflow, which
// owns opportunity creation (single Create-or-Update, duplicates off) — creating
// the opp here too would produce duplicate cards.
const MOVE_WEBHOOK = process.env.MERIDIAN_WEBHOOK_MOVE || '';

// POST /api/move — submit a move-in/move-out request for the logged-in resident.
async function submitMove(req, res) {
  const { move_type, move_date, move_time, notes, contact_id, name, email, unit } = req.body || {};

  if (!move_type || !move_date || !move_time) {
    return res.status(400).json({ success: false, message: 'Move type, date, and time are required.' });
  }
  if (!MOVE_WEBHOOK) {
    return res.status(503).json({ success: false, message: 'Move requests are not configured on the server yet.' });
  }

  const unitTag = unit ? ` (#${String(unit).replace(/^#/, '')})` : '';
  // Canonical opportunity name the workflow uses.
  const oppName = `${move_type} — ${name || 'Resident'}${unitTag} · ${move_date} ${move_time}`;

  try {
    await ghl.postWebhook(MOVE_WEBHOOK, {
      event:      'move_booking',
      move_type, move_date, move_time,
      notes:      notes || '',
      opp_name:   oppName,
      name:       name || '',
      email:      email || '',
      unit:       unit || '',
      contact_id: contact_id || '',
    });
    console.log(`[move] ${move_type} for #${unit} on ${move_date} ${move_time} (contact ${contact_id})`);

    // Persist the full submission to Mongo (resident-facing source of truth across
    // devices + both portals). Non-fatal.
    if (dbReady() && (contact_id || email)) {
      Move.create({
        contact_id: contact_id || '',
        email:      (email || '').toLowerCase(),
        unit:       unit || '',
        move_type, move_date, move_time,
        notes:      notes || '',
      }).catch(e => console.warn('[move] DB save failed:', e.message));
    }

    return res.json({ success: true, message: 'Move booking submitted. Management will confirm within 2 working days.' });
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'GHL request failed.';
    console.error('[move] webhook failed:', msg);
    return res.status(502).json({ success: false, message: `Submission failed: ${msg}` });
  }
}

// GET /api/move/mine — the logged-in resident's own move requests (full detail),
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
    const rows = await Move.find({ $or: or }).sort({ created_at: -1 }).limit(100).lean();
    return res.json({ success: true, items: rows.map(r => ({
      move_type: r.move_type, move_date: r.move_date, move_time: r.move_time, notes: r.notes, ts: r.created_at,
    })) });
  } catch (e) {
    console.warn('[move] mine failed:', e.message);
    return res.json({ success: true, items: [] });
  }
}

module.exports = { submitMove, listMine };
