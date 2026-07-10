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

// Record all state-changing management actions to the audit trail (L-05). Registered
// router-wide; it reads req.user (set per-route by requireManagement) at response time.
router.use(auditLog);

// Management-only.
router.get('/contacts/search', requireManagement, controller.searchContacts);
router.post('/guest',          requireManagement, controller.registerGuest);
// All registered guests across residents + stage control.
router.get('/guests',             requireManagement, controller.listGuests);
router.put('/guests/:id/stage',   requireManagement, controller.updateGuestStage);
// Generic pipeline opportunities (defect/parcel/move/feedback) + stage control.
router.get('/opportunities',          requireManagement, controller.listOpportunities);
router.put('/opportunities/:id/stage', requireManagement, controller.updateOpportunityStage);
// All resident accounts (the directory of who can log in).
router.get('/residents', requireManagement, controller.listResidents);
// Announcements (published to the resident portal Notices).
router.get('/announcements',              requireManagement, announce.listAll);
router.post('/announcements',             requireManagement, announce.create);
router.delete('/announcements/:id',       requireManagement, announce.remove);
router.patch('/announcements/:id',        requireManagement, announce.patch);
router.get('/rsvp/:announcement_id',      requireManagement, rsvp.rsvpSummary);
// Resident ↔ management messaging.
router.get('/messages',                requireManagement, messaging.listConversations);
router.get('/messages-residents',      requireManagement, messaging.listMessageResidents);
router.get('/messages/:id',            requireManagement, messaging.getConversation);
router.post('/messages/:id/reply',     requireManagement, messaging.replyConversation);
router.post('/messages/:id/resolve',   requireManagement, messaging.resolveConversation);
router.post('/messages/start',         requireManagement, messaging.startConversation);
// Payments — all resident payment records (history).
router.get('/payments',                requireManagement, payment.allPayments);
// All residents' facility bookings (sourced from GHL calendar appointments).
router.get('/bookings',            requireManagement, booking.getAllBookings);
// Move a booking's pipeline opportunity to a new stage.
router.put('/bookings/:id/stage',  requireManagement, booking.updateBookingStage);
// Resources — document library (management can upload/delete; residents get a filtered view).
router.get('/resources',              requireManagement, resource.listForManagement);
router.get('/resources/:id/download', requireManagement, resource.downloadForManagement);
router.post('/resources',             requireManagement, resource.create);
router.delete('/resources/:id',       requireManagement, resource.remove);

module.exports = router;
