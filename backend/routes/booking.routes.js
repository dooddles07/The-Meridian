const express    = require('express');
const router     = express.Router();
const rateLimit  = require('express-rate-limit');
const controller = require('../controllers/booking.controller');
const { requireResident, auditLog } = require('../middleware/auth.middleware');

const limiterOpts = { windowMs: 15 * 60 * 1000, standardHeaders: 'draft-7', legacyHeaders: false };
const mutateLimiter = rateLimit({
  ...limiterOpts, limit: 30,
  message: { success: false, message: 'Too many changes. Please wait a few minutes and try again.' },
});

// Public - no role check. Just static facility/deposit metadata, no different
// from what both portals already hardcode in their own bundled JS; letting
// management fetch it too (it isn't resident-authenticated) is the whole point.
router.get('/facilities', controller.listFacilities);

router.use(requireResident);

router.get('/availability',            controller.availability);
router.get('/mine',                    controller.listMine);
router.post('/',                       mutateLimiter, auditLog, controller.create);
router.put('/:id',                     mutateLimiter, auditLog, controller.update);
router.delete('/:id',                  mutateLimiter, auditLog, controller.cancel);
router.patch('/:id/confirm-deposit',   mutateLimiter, auditLog, controller.confirmDeposit);

module.exports = router;
