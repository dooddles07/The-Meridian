const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/opportunities.controller');
const { requireResident } = require('../middleware/auth.middleware');

// GET /api/opportunities?pipeline=guest|defect|facility|… — scoped to the token identity.
router.get('/', requireResident, controller.getOpportunities);

module.exports = router;
