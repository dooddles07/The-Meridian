const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/announcement.controller');
const { requireResident } = require('../middleware/auth.middleware');

// GET /api/announcements — Notices list for the signed-in resident portal.
router.get('/', requireResident, controller.listPublic);

module.exports = router;
