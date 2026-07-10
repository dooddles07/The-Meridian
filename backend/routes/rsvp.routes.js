const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/rsvp.controller');
const { requireResident } = require('../middleware/auth.middleware');

// RSVPs are scoped to the signed-in resident (contact_id from the token).
router.use(requireResident);

// POST /api/rsvp        — submit / update a resident's RSVP
// GET  /api/rsvp/mine   — resident's own RSVPs keyed by announcement_id
router.post('/',    controller.submitRsvp);
router.get('/mine', controller.myRsvps);

module.exports = router;
