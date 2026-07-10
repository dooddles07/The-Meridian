const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/opportunities.controller');
const { requireResident } = require('../middleware/auth.middleware');

router.get('/', requireResident, controller.getOpportunities);

module.exports = router;
