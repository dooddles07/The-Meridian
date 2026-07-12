const express    = require('express');
const router     = express.Router();
const rateLimit  = require('express-rate-limit');
const controller = require('../controllers/guest.controller');
const { requireResident, auditLog } = require('../middleware/auth.middleware');

const mutateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { success: false, message: 'Too many changes. Please wait a few minutes and try again.' },
});

router.use(requireResident);

router.get('/mine', controller.listMine);
router.post('/',    mutateLimiter, auditLog, controller.create);

module.exports = router;
