const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/move.controller');
const { requireResident } = require('../middleware/auth.middleware');

router.post('/', requireResident, controller.submitMove);
router.get('/mine', requireResident, controller.listMine);

module.exports = router;
