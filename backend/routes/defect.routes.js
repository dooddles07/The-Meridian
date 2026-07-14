const express    = require('express');
const router     = express.Router();
const rateLimit  = require('express-rate-limit');
const controller = require('../controllers/defect.controller');
const { requireResident, auditLog } = require('../middleware/auth.middleware');

const limiterOpts = { windowMs: 15 * 60 * 1000, standardHeaders: 'draft-7', legacyHeaders: false };
const mutateLimiter = rateLimit({
  ...limiterOpts, limit: 30,
  message: { success: false, message: 'Too many reports. Please wait a few minutes and try again.' },
});

router.use(requireResident);

router.get('/mine', controller.listMine);
router.post('/',    mutateLimiter, auditLog, controller.create);

module.exports = router;
