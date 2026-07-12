const express    = require('express');
const router     = express.Router();
const rateLimit  = require('express-rate-limit');
const controller = require('../controllers/guest.controller');
const { requireGuardhouse, auditLog } = require('../middleware/auth.middleware');

// Wider window than a normal mutation cap - a guard station scans many visitors
// per shift - but still bounded, since the reference is only a 4-digit/day
// suffix and an unlimited lookup would let it be brute-forced.
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { success: false, message: 'Too many lookups. Please wait a few minutes and try again.' },
});
const mutateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { success: false, message: 'Too many changes. Please wait a few minutes and try again.' },
});

router.use(requireGuardhouse);

router.get('/lookup',   lookupLimiter, controller.guardLookup);
router.post('/checkin', mutateLimiter, auditLog, controller.guardCheckin);

module.exports = router;
