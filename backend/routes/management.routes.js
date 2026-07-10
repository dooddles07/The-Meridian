const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/management.controller');
const booking    = require('../controllers/booking.controller');
const announce   = require('../controllers/announcement.controller');
const rsvp       = require('../controllers/rsvp.controller');
const messaging  = require('../controllers/messaging.controller');
const payment    = require('../controllers/payment.controller');
const resource   = require('../controllers/resource.controller');
const { requireManagement, auditLog } = require('../middleware/auth.middleware');

// Registered router-wide, ahead of requireManagement. Safe because it reads
// req.user from res.on('finish') — by then requireManagement has already run
// and set it.
router.use(auditLog);

router.get('/contacts/search', requireManagement, controller.searchContacts);
router.post('/guest',          requireManagement, controller.registerGuest);
router.get('/guests',             requireManagement, controller.listGuests);
router.put('/guests/:id/stage',   requireManagement, controller.updateGuestStage);
router.get('/opportunities',          requireManagement, controller.listOpportunities);
router.put('/opportunities/:id/stage', requireManagement, controller.updateOpportunityStage);
router.get('/residents', requireManagement, controller.listResidents);
router.get('/announcements',              requireManagement, announce.listAll);
router.post('/announcements',             requireManagement, announce.create);
router.delete('/announcements/:id',       requireManagement, announce.remove);
router.patch('/announcements/:id',        requireManagement, announce.patch);
router.get('/rsvp/:announcement_id',      requireManagement, rsvp.rsvpSummary);
router.get('/messages',                requireManagement, messaging.listConversations);
router.get('/messages-residents',      requireManagement, messaging.listMessageResidents);
router.get('/messages/:id',            requireManagement, messaging.getConversation);
router.post('/messages/:id/reply',     requireManagement, messaging.replyConversation);
router.post('/messages/:id/resolve',   requireManagement, messaging.resolveConversation);
router.post('/messages/start',         requireManagement, messaging.startConversation);
router.get('/payments',                requireManagement, payment.allPayments);
router.get('/bookings',            requireManagement, booking.getAllBookings);
router.put('/bookings/:id/stage',  requireManagement, booking.updateBookingStage);
router.get('/resources',              requireManagement, resource.listForManagement);
router.get('/resources/:id/download', requireManagement, resource.downloadForManagement);
router.post('/resources',             requireManagement, resource.create);
router.delete('/resources/:id',       requireManagement, resource.remove);

module.exports = router;
