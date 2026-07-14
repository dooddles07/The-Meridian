const express      = require('express');
const router       = express.Router();
const rateLimit    = require('express-rate-limit');
const resources    = require('../controllers/resource.controller');
const announcements = require('../controllers/announcement.controller');
const bookings     = require('../controllers/booking.controller');
const moves        = require('../controllers/move.controller');
const guests       = require('../controllers/guest.controller');
const defects      = require('../controllers/defect.controller');
const audit        = require('../controllers/audit.controller');
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

router.get('/announcements',           announcements.listAll);
router.post('/announcements',          mutateLimiter, auditLog, announcements.create);
router.patch('/announcements/:id',     mutateLimiter, auditLog, announcements.patch);
router.delete('/announcements/:id',    mutateLimiter, auditLog, announcements.remove);

router.get('/bookings',                bookings.listForManagement);
router.put('/bookings/:id/stage',      mutateLimiter, auditLog, bookings.updateStage);
router.put('/bookings/:id/deposit',    mutateLimiter, auditLog, bookings.manageDeposit);

router.get('/moves',                   moves.listForManagement);
router.put('/moves/:id/stage',         mutateLimiter, auditLog, moves.updateStage);
router.put('/moves/:id/deposit',       mutateLimiter, auditLog, moves.manageDeposit);

router.get('/defects',                 defects.listForManagement);
router.put('/defects/:id/stage',       mutateLimiter, auditLog, defects.updateStage);

router.get('/audit',                   audit.list);

router.get('/contacts/search',         guests.searchContacts);
router.get('/guests',                  guests.listForManagement);
router.post('/guest',                  mutateLimiter, auditLog, guests.createByManagement);
router.put('/guests/:id/stage',        mutateLimiter, auditLog, guests.updateStage);

module.exports = router;
