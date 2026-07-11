const mongoose = require('mongoose');

// Persisted resident accounts. Seeded from LUMINA_RESIDENTS on boot.
const residentSchema = new mongoose.Schema({
  email:          { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:       { type: String, default: '' },
  unit:           { type: String, default: '' },
  name:           { type: String, default: '' },
  // 'Resident' is kept as a legacy/fallback value only - new signups always
  // choose Owner or Tenant (see auth.controller.js's residentSignup), which
  // is what resource visibility segmentation (owners-only/tenants-only docs)
  // filters on.
  residentType:   { type: String, enum: ['Owner', 'Tenant', 'Resident'], default: 'Resident' },
  phone:          { type: String, default: '' },
  active:         { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.models.Resident || mongoose.model('Resident', residentSchema);
