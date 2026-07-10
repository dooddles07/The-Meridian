const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
  title:    { type: String, required: true, trim: true },
  body:     { type: String, required: true, trim: true },
  category: { type: String, default: 'General' },
  eventAt:    { type: Date },
  eventEndAt: { type: Date }, // used by the Maintenance category as the window's end date/time
  pinned:             { type: Boolean, default: false },
  rsvp_enabled:       { type: Boolean, default: false },
  blocked_facilities: [{ type: String }],
  event_venue: { type: String, default: '' }, // custom "Other" venue text for events
  active:       { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.models.Announcement || mongoose.model('Announcement', announcementSchema);
