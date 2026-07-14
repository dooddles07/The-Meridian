const mongoose = require('mongoose');

// Defect / maintenance reports — real backend (mirrors move.model.js's shape;
// no deposit/slot logic, a defect is just a tracked request). The attached
// photo is stored inline as a base64 data URL (same approach resources use for
// uploaded files); express.json's 15mb limit in app.js covers it, and a capped
// (~1.5MB) image stays well under Mongo's 16MB document ceiling.
const schema = new mongoose.Schema({
  reference:         { type: String, required: true, index: true }, // DFT-XXXXXX
  description:       { type: String, required: true },
  category:          { type: String, default: 'General' },
  secondaryCategory: { type: String, default: '' },
  location:          { type: String, default: '' },
  urgency:           { type: String, enum: ['Routine', 'Urgent', 'Emergency'], default: 'Routine' },
  photo:             { type: String, default: '' }, // base64 data URL, optional
  status:            { type: String, enum: ['Reported', 'Acknowledged', 'In Progress', 'Resolved', 'Closed'], default: 'Reported' },
  contact_id:        { type: String, required: true, index: true },
  resident_name:     { type: String, default: '' },
  resident_email:    { type: String, default: '' },
  resident_unit:     { type: String, default: '' },
  createdAt:         { type: Date, default: Date.now },
});

schema.index({ createdAt: -1 }); // management list is always sorted newest-first

module.exports = mongoose.models.Defect || mongoose.model('Defect', schema);
