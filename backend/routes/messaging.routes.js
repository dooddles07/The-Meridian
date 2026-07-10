const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/messaging.controller');
const { requireResident } = require('../middleware/auth.middleware');

router.use(requireResident);

router.post('/',       controller.sendMessage);
router.get('/mine',    controller.myThread); // also marks management's messages as read
router.get('/unread',  controller.myUnread);

module.exports = router;
