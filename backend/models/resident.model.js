const mongoose = require('mongoose');

// Persisted resident accounts. Seeded from MERIDIAN_RESIDENTS on boot; their GHL
// contact is auto-created/updated (upserted) on login and on management actions.
const residentSchema = new mongoose.Schema({
  email:          { type: String, required: true, unique: true, lowercase: true, trim: true },
  unit:           { type: String, default: '' },
  name:           { type: String, default: '' },
  residentType:   { type: String, default: 'Resident' },
  phone:          { type: String, default: '' },
  ghl_contact_id: { type: String, default: '' },
  active:         { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.models.Resident || mongoose.model('Resident', residentSchema);
