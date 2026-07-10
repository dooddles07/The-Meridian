const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/resource.controller');
const { requireResident } = require('../middleware/auth.middleware');

// Resident-facing: list and download resident-visible documents only.
router.get('/',               requireResident, controller.listForResidents);
router.get('/:id/download',   requireResident, controller.downloadForResident);

module.exports = router;
