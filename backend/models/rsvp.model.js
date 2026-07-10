const mongoose = require('mongoose');

const rsvpSchema = new mongoose.Schema({
  announcement_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  contact_id:      { type: String, required: true },
  resident_name:   { type: String, default: '' },
  resident_unit:   { type: String, default: '' },
  response:        { type: String, enum: ['yes', 'no'], required: true },
  attendee_count:  { type: Number, default: 1, min: 1 },
}, { timestamps: true });

// One response per resident per announcement — upserted on resubmit.
rsvpSchema.index({ announcement_id: 1, contact_id: 1 }, { unique: true });

module.exports = mongoose.models.RsvpResponse || mongoose.model('RsvpResponse', rsvpSchema);
