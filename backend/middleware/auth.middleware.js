const { verifyToken } = require('../config/secrets');

function requireRole(role) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    try {
      const payload = verifyToken(token);
      if (payload.role !== role) {
        return res.status(403).json({ success: false, message: `${role} access required.` });
      }
      req.user = payload;
      next();
    } catch {
      return res.status(401).json({ success: false, message: 'Session expired or invalid. Please sign in again.' });
    }
  };
}

// Resident gate. Verifies the resident JWT and — critically — derives the caller's
// identity (contact_id / email / unit / name) from the SIGNED TOKEN, never from the
// request. It overwrites every identity alias the resident controllers read so a
// caller can only ever act as themselves; supplying another resident's contact_id or
// email is silently ignored. This closes the IDOR where any party could read/write
// another resident's data by passing their identifier.
// Verify the Bearer token. Returns the payload, or sends the 401 and returns null.
function _verifyBearer(req, res) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ success: false, message: 'Please sign in to continue.' });
    return null;
  }
  try {
    return verifyToken(token);
  } catch {
    res.status(401).json({ success: false, message: 'Session expired or invalid. Please sign in again.' });
    return null;
  }
}

// Force the trusted identity from the token onto every alias the controllers read.
// Read endpoints scope by req.query.{contact_id,email}; write endpoints read various
// {member_,host_,resident_}* fields from req.body.
function _injectResidentIdentity(req, payload) {
  const id = {
    contact_id: payload.contact_id || '',
    email:      (payload.email || '').toLowerCase(),
    unit:       payload.unit || '',
    name:       payload.name || '',
  };
  req.resident = id;
  if (req.query && typeof req.query === 'object') {
    req.query.contact_id = id.contact_id;
    req.query.email      = id.email;
  }
  if (req.body && typeof req.body === 'object') {
    Object.assign(req.body, {
      contact_id: id.contact_id, email: id.email, name: id.name, unit: id.unit,
      member_name: id.name, member_email: id.email, member_unit: id.unit,
      host_name: id.name, host_email: id.email, host_unit: id.unit, host_contact_id: id.contact_id,
      resident_name: id.name, resident_email: id.email, resident_unit: id.unit, resident_contact_id: id.contact_id,
    });
  }
}

function requireResident(req, res, next) {
  const payload = _verifyBearer(req, res);
  if (!payload) return;
  if (payload.role !== 'resident') {
    return res.status(403).json({ success: false, message: 'Resident access required.' });
  }
  req.user = payload;
  _injectResidentIdentity(req, payload);
  next();
}

// Endpoints a resident OR a management operator may call (e.g. confirming a deposit).
// Residents are locked to their own token identity; management is a trusted operator
// acting on an explicit target (opportunity_id) so its request fields are left intact.
function requireResidentOrManagement(req, res, next) {
  const payload = _verifyBearer(req, res);
  if (!payload) return;
  if (payload.role === 'resident') {
    req.user = payload;
    _injectResidentIdentity(req, payload);
    return next();
  }
  if (payload.role === 'management') {
    req.user = payload;
    return next();
  }
  return res.status(403).json({ success: false, message: 'Access denied.' });
}

function errorHandler(err, req, res, _next) {
  // Log the full stack server-side. The 5xx response body is genericised (and given
  // a reference id) by the response sanitizer in server.js; intentional 4xx messages
  // are preserved here. (M-01)
  console.error(`[error] ${req.method} ${req.originalUrl} —`, err.stack || err.message);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: status < 500 ? (err.message || 'Request error.') : 'Internal server error.',
  });
}

// Audit trail for privileged actions (L-05). Records every state-changing request
// (POST/PUT/DELETE/PATCH) after it completes — actor from the token, route, target id
// and resulting status — to an append-only collection. Reads (GET) are skipped.
// Non-fatal: a logging failure never affects the action.
function auditLog(req, res, next) {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return next();
  res.on('finish', () => {
    try {
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState !== 1) return;
      require('../models/audit.model').create({
        actor:  (req.user && (req.user.username || req.user.email)) || 'unknown',
        role:   (req.user && req.user.role) || 'unknown',
        method: req.method,
        path:   (req.originalUrl || '').split('?')[0],
        target: (req.params && req.params.id) || '',
        status: res.statusCode,
      }).catch(() => {});
    } catch { /* never block on audit logging */ }
  });
  next();
}

const requireManagement = requireRole('management');
const requireGuardhouse = requireRole('guardhouse');

module.exports = { requireRole, requireManagement, requireGuardhouse, requireResident, requireResidentOrManagement, auditLog, errorHandler };
