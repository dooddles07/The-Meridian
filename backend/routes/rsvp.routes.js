const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/rsvp.controller');
const { requireResident } = require('../middleware/auth.middleware');

router.use(requireResident);

router.post('/',    controller.submitRsvp);
router.get('/mine', controller.myRsvps);

module.exports = router;
