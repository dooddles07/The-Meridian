const mongoose = require('mongoose');

// Persisted resident accounts. Seeded from LUMINA_RESIDENTS on boot.
const residentSchema = new mongoose.Schema({
  email:          { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:       { type: String, default: '' },
  unit:           { type: String, default: '' },
  name:           { type: String, default: '' },
  residentType:   { type: String, default: 'Resident' },
  phone:          { type: String, default: '' },
  active:         { type: Boolean, default: true },
  // Password reset: only the SHA-256 hash of the raw token is stored (fast hash
  // is correct here — unlike passwords, this is high-entropy random data, not
  // human-guessable, so bcrypt's deliberate slowness isn't needed). Cleared on
  // successful reset so each link is single-use.
  resetTokenHash:    { type: String, default: '' },
  resetTokenExpires: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.models.Resident || mongoose.model('Resident', residentSchema);
