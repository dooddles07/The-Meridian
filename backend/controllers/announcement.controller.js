const Announcement = require('../models/announcement.model');
const { isDbReady: dbReady } = require('../utils/db');
const fmt = (a) => ({
  id:        String(a._id),
  title:     a.title,
  body:      a.body,
  category:  a.category || 'General',
  eventAt:    a.eventAt || null,
  eventEndAt: a.eventEndAt || null,
  pinned:             !!a.pinned,
  rsvp_enabled:       !!a.rsvp_enabled,
  blocked_facilities: a.blocked_facilities || [],
  event_venue:        a.event_venue || '',
  createdAt:          a.createdAt,
});

// GET /api/announcements — active announcements for residents (pinned first).
async function listPublic(req, res) {
  if (!dbReady()) return res.json({ success: true, announcements: [] });
  try {
    const rows = await Announcement.find({ active: true }).sort({ pinned: -1, createdAt: -1 }).limit(100).lean();
    return res.json({ success: true, announcements: rows.map(fmt) });
  } catch (err) {
    console.error('[announcements] list failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// GET /api/management/announcements — same list for the management panel.
const listAll = listPublic;

// POST /api/management/announcements — publish a new announcement.
async function create(req, res) {
  const { title, body, category, pinned, rsvp_enabled, blocked_facilities, event_venue, eventAt, eventEndAt } = req.body || {};
  if (!title || !body) return res.status(400).json({ success: false, message: 'Title and body are required.' });
  if (!dbReady())       return res.status(503).json({ success: false, message: 'Database not connected — cannot publish.' });
  let eventDate, eventEndDate;
  if (eventAt) {
    eventDate = new Date(eventAt);
    if (isNaN(eventDate.getTime())) return res.status(400).json({ success: false, message: 'Invalid event start date/time.' });
  }
  if (eventEndAt) {
    eventEndDate = new Date(eventEndAt);
    if (isNaN(eventEndDate.getTime())) return res.status(400).json({ success: false, message: 'Invalid event end date/time.' });
  }
  if (eventDate && eventEndDate && eventEndDate < eventDate) {
    return res.status(400).json({ success: false, message: 'End date/time must be after the start.' });
  }
  try {
    const isEvent = category === 'Event';
    const isMaintenance = category === 'Maintenance';
    const facilities = (isEvent || isMaintenance) && Array.isArray(blocked_facilities) ? blocked_facilities.filter(Boolean) : [];
    const venue = isEvent && event_venue ? String(event_venue).trim().slice(0, 200) : '';
    const a = await Announcement.create({ title: String(title).trim(), body: String(body).trim(), category: category || 'General', pinned: !!pinned, rsvp_enabled: !!(rsvp_enabled && isEvent), blocked_facilities: facilities, event_venue: venue, eventAt: eventDate, eventEndAt: eventEndDate });
    console.log(`[announcements] published "${a.title}"${a.pinned ? ' (pinned)' : ''}`);
    return res.json({ success: true, announcement: fmt(a) });
  } catch (err) {
    console.error('[announcements] create failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// DELETE /api/management/announcements/:id — remove an announcement.
async function remove(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  try {
    await Announcement.deleteOne({ _id: req.params.id });
    return res.json({ success: true });
  } catch (err) {
    console.error('[announcements] delete failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

// PATCH /api/management/announcements/:id — update pinned status.
async function patch(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const { pinned } = req.body || {};
  if (typeof pinned !== 'boolean') return res.status(400).json({ success: false, message: '`pinned` must be a boolean.' });
  try {
    const a = await Announcement.findByIdAndUpdate(req.params.id, { pinned }, { new: true }).lean();
    if (!a) return res.status(404).json({ success: false, message: 'Announcement not found.' });
    return res.json({ success: true, announcement: fmt(a) });
  } catch (err) {
    console.error('[announcements] patch failed:', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
}

module.exports = { listPublic, listAll, create, remove, patch };
