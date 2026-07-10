const mongoose    = require('mongoose');
const RsvpResponse = require('../models/rsvp.model');
const Announcement = require('../models/announcement.model');

const dbReady = () => mongoose.connection.readyState === 1;

// POST /api/rsvp — resident submits or updates their RSVP (upsert).
async function submitRsvp(req, res) {
  const { announcement_id, contact_id, response, attendee_count, resident_name, resident_unit } = req.body || {};
  if (!announcement_id || !contact_id || !response) {
    return res.status(400).json({ success: false, message: 'announcement_id, contact_id, and response are required.' });
  }
  if (!['yes', 'no'].includes(response)) {
    return res.status(400).json({ success: false, message: 'response must be "yes" or "no".' });
  }
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  try {
    const ann = await Announcement.findById(announcement_id).lean();
    if (!ann)             return res.status(404).json({ success: false, message: 'Announcement not found.' });
    if (!ann.rsvp_enabled) return res.status(400).json({ success: false, message: 'This event is not accepting RSVPs.' });

    const count = response === 'yes' ? Math.max(1, parseInt(attendee_count) || 1) : 0;
    await RsvpResponse.findOneAndUpdate(
      { announcement_id, contact_id },
      { response, attendee_count: count, resident_name: String(resident_name || ''), resident_unit: String(resident_unit || '') },
      { upsert: true, new: true },
    );
    return res.json({ success: true, response, attendee_count: count });
  } catch (err) {
    console.error('[rsvp] submit failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// GET /api/rsvp/mine?contact_id= — resident's own RSVPs keyed by announcement_id.
async function myRsvps(req, res) {
  const { contact_id } = req.query;
  if (!contact_id || !dbReady()) return res.json({ success: true, rsvps: {} });
  try {
    const rows = await RsvpResponse.find({ contact_id }).lean();
    const rsvps = {};
    rows.forEach(r => { rsvps[String(r.announcement_id)] = { response: r.response, attendee_count: r.attendee_count }; });
    return res.json({ success: true, rsvps });
  } catch (err) {
    console.error('[rsvp] mine failed:', err.message);
    return res.json({ success: true, rsvps: {} });
  }
}

// GET /api/management/rsvp/:announcement_id — attendance summary + full response list.
async function rsvpSummary(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  try {
    const rows      = await RsvpResponse.find({ announcement_id: req.params.announcement_id }).lean();
    const attending = rows.filter(r => r.response === 'yes');
    const declined  = rows.filter(r => r.response === 'no');
    return res.json({
      success:         true,
      total_responses: rows.length,
      attending_count: attending.length,
      attending_total: attending.reduce((s, r) => s + (r.attendee_count || 1), 0),
      declined_count:  declined.length,
      responses: rows.map(r => ({
        resident_name:  r.resident_name,
        resident_unit:  r.resident_unit,
        response:       r.response,
        attendee_count: r.attendee_count,
        updatedAt:      r.updatedAt,
      })),
    });
  } catch (err) {
    console.error('[rsvp] summary failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

module.exports = { submitRsvp, myRsvps, rsvpSummary };
