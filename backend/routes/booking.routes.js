const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/booking.controller');
const { requireResident } = require('../middleware/auth.middleware');

// All booking routes require a signed-in resident; identity comes from the token.
router.use(requireResident);

// GET /api/booking/availability — busy slot ranges for a facility/date.
router.get('/availability', controller.getAvailability);
// GET /api/booking/mine?contact_id= — resident's bookings + live pipeline stages.
router.get('/mine', controller.getMyBookings);
// GET /api/booking/opp-stage?opp_id= — direct GHL opportunity stage (bypasses search cache).
router.get('/opp-stage', controller.getOppStage);
// POST /api/booking  — create a GHL calendar appointment for a facility booking.
router.post('/', controller.createBooking);
// PUT /api/booking/:id — edit an existing booking (date/slot/pax/notes).
router.put('/:id', controller.updateBooking);
// DELETE /api/booking/:id — cancel a GHL calendar appointment.
router.delete('/:id', controller.cancelBooking);

module.exports = router;
