const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/booking.controller');
const { requireResident } = require('../middleware/auth.middleware');

router.use(requireResident);

router.get('/availability', controller.getAvailability);
router.get('/mine', controller.getMyBookings);
// Bypasses the search cache — reads the opportunity stage directly from GHL.
router.get('/opp-stage', controller.getOppStage);
router.post('/', controller.createBooking);
router.put('/:id', controller.updateBooking);
router.delete('/:id', controller.cancelBooking);

module.exports = router;
