const express    = require('express');
const router     = express.Router();
const rateLimit  = require('express-rate-limit');
const controller = require('../controllers/message.controller');
const { requireResident } = require('../middleware/auth.middleware');

const limiterOpts = { windowMs: 15 * 60 * 1000, standardHeaders: 'draft-7', legacyHeaders: false };
const sendLimiter = rateLimit({
  ...limiterOpts, limit: 60,
  message: { success: false, message: 'Too many messages. Please wait a few minutes and try again.' },
});

router.use(requireResident);

router.get('/mine',   controller.mine);
router.get('/unread', controller.unread);
router.post('/',      sendLimiter, controller.send);

module.exports = router;
