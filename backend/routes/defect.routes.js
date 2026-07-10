const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/defect.controller');
const { requireResident } = require('../middleware/auth.middleware');

router.post('/', requireResident, controller.submitDefect);
router.get('/mine', requireResident, controller.listMine);

module.exports = router;
