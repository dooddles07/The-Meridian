const express    = require('express');
const router     = express.Router();
const rateLimit  = require('express-rate-limit');
const resources  = require('../controllers/resource.controller');
const { requireManagement, auditLog } = require('../middleware/auth.middleware');

router.use(requireManagement);

// Mutations get a tighter cap + audit logging; downloads get a lighter cap
// (no audit — reads aren't privileged actions, just noise in the trail).
const limiterOpts = { windowMs: 15 * 60 * 1000, standardHeaders: 'draft-7', legacyHeaders: false };
const mutateLimiter = rateLimit({
  ...limiterOpts, limit: 30,
  message: { success: false, message: 'Too many changes. Please wait a few minutes and try again.' },
});
const downloadLimiter = rateLimit({
  ...limiterOpts, limit: 60,
  message: { success: false, message: 'Too many downloads. Please wait a few minutes and try again.' },
});

router.get('/resources',               resources.listForManagement);
router.get('/resources/:id/download',  downloadLimiter, resources.downloadForManagement);
router.post('/resources',              mutateLimiter, auditLog, resources.create);
router.patch('/resources/:id',         mutateLimiter, auditLog, resources.patch);
router.delete('/resources/:id',        mutateLimiter, auditLog, resources.remove);

module.exports = router;
