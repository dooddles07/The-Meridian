const mongoose = require('mongoose');
const AuditLog = require('../models/audit.model');

const dbReady = () => mongoose.connection.readyState === 1;

const ROLES = ['resident', 'management', 'guardhouse'];

// GET /api/management/audit?limit=&role= - read-only view of the append-only
// privileged-action trail (see middleware/auth.middleware.js's auditLog).
async function list(req, res) {
  if (!dbReady()) return res.status(503).json({ success: false, message: 'Database not connected.' });
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 150));
  const query = {};
  if (ROLES.includes(req.query.role)) query.role = req.query.role;
  const items = await AuditLog.find(query).sort({ createdAt: -1 }).limit(limit).lean();
  return res.json({
    success: true,
    items: items.map(a => ({
      actor: a.actor, role: a.role, method: a.method, path: a.path,
      target: a.target || '', status: a.status, createdAt: a.createdAt,
    })),
    total: items.length,
  });
}

module.exports = { list };
