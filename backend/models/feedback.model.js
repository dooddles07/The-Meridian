const mongoose = require('mongoose');

// Feedback / complaints / suggestions — real backend (mirrors defect.model.js).
// incident_date/time are only meaningful for a Complaint; left blank otherwise.
const schema = new mongoose.Schema({
  reference:      { type: String, required: true, index: true }, // CMP-/FBK-/SUG-XXXXXX
  type:           { type: String, enum: ['Complaint', 'Feedback', 'Suggestion'], default: 'Complaint' },
  category:       { type: String, default: 'General' },
  description:    { type: String, required: true },
  incident_date:  { type: String, default: '' }, // YYYY-MM-DD (Complaint only)
  incident_time:  { type: String, default: '' }, // display string
  photo:          { type: String, default: '' }, // optional evidence, base64 data URL
  status:         { type: String, enum: ['Submitted', 'Under Review', 'Resolved', 'Closed'], default: 'Submitted' },
  // Management's reply, shown back to the resident on their submission card.
  response:       { type: String, default: '' },
  respondedAt:    { type: Date, default: null },
  contact_id:     { type: String, required: true, index: true },
  resident_name:  { type: String, default: '' },
  resident_email: { type: String, default: '' },
  resident_unit:  { type: String, default: '' },
  createdAt:      { type: Date, default: Date.now },
});

schema.index({ createdAt: -1 }); // management list is always sorted newest-first

module.exports = mongoose.models.Feedback || mongoose.model('Feedback', schema);
