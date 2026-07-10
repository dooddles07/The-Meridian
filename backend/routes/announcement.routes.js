const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/announcement.controller');
const { requireResident } = require('../middleware/auth.middleware');

router.get('/', requireResident, controller.listPublic);

module.exports = router;
