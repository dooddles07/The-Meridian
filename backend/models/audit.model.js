const mongoose = require('mongoose');

// Append-only trail of privileged (state-changing) actions - see
// middleware/auth.middleware.js's auditLog.
const auditSchema = new mongoose.Schema({
  actor:  { type: String, default: 'unknown' },
  role:   { type: String, default: 'unknown' },
  method: { type: String, required: true },
  path:   { type: String, required: true },
  target: { type: String, default: '' },
  status: { type: Number, required: true },
}, { timestamps: true });

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', auditSchema);
