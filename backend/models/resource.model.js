const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true },
  category:    { type: String, default: 'General' },
  visibility:  { type: String, enum: ['residents', 'management'], default: 'residents' },
  file_data:   { type: String, default: '' }, // base64 data URL
  file_name:   { type: String, default: '' },
  file_type:   { type: String, default: '' },
  file_size:   { type: Number, default: 0 },
  uploaded_by: { type: String, default: '' },
  createdAt:   { type: Date, default: Date.now },
});

module.exports = mongoose.models.Resource || mongoose.model('Resource', schema);
