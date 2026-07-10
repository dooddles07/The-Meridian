const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/messaging.controller');
const { requireResident } = require('../middleware/auth.middleware');

// Resident messaging — identity is taken from the signed token, not the request.
router.use(requireResident);

// POST /api/messages          — send a message to management
// GET  /api/messages/mine     — the resident's thread (marks management msgs read)
// GET  /api/messages/unread   — unread count for the resident's inbox badge
router.post('/',       controller.sendMessage);
router.get('/mine',    controller.myThread);
router.get('/unread',  controller.myUnread);

module.exports = router;
