const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/feedback.controller');
const { requireResident } = require('../middleware/auth.middleware');

router.post('/', requireResident, controller.submitFeedback);
router.get('/mine', requireResident, controller.listMine);

module.exports = router;
