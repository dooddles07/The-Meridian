const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/guest.controller');
const { requireResident } = require('../middleware/auth.middleware');

router.post('/', requireResident, controller.registerGuest);

module.exports = router;
