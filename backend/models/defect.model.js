const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  contact_id:  { type: String, default: '', index: true },
  email:       { type: String, default: '', lowercase: true, trim: true, index: true },
  unit:        { type: String, default: '' },
  category:    { type: String, default: '' },
  urgency:     { type: String, default: 'Routine' },
  location:    { type: String, default: '' },
  description: { type: String, default: '' },
  defect_file: { type: String, default: '' }, // base64 JPEG data URL
  created_at:  { type: Date,   default: Date.now },
});

module.exports = mongoose.models.Defect || mongoose.model('Defect', schema);
