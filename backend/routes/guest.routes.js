const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/guest.controller');
const { requireResident } = require('../middleware/auth.middleware');

// POST /api/guest — resident registers a visitor (fires Guest Registrations workflow).
router.post('/', requireResident, controller.registerGuest);

module.exports = router;
