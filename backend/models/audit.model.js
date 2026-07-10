const mongoose = require('mongoose');

// Append-only audit trail of privileged (state-changing) actions (L-05).
// One row per management/guardhouse mutation: who, what, where, outcome, when.
const auditSchema = new mongoose.Schema({
  actor:  { type: String, default: 'unknown' }, // username/email from the token
  role:   { type: String, default: 'unknown' },
  method: { type: String, default: '' },         // POST / PUT / DELETE
  path:   { type: String, default: '' },          // route, query stripped
  target: { type: String, default: '' },          // :id param when present
  status: { type: Number, default: 0 },           // HTTP status of the action
  at:     { type: Date,   default: Date.now },
}, { versionKey: false });

auditSchema.index({ at: -1 });

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', auditSchema);
