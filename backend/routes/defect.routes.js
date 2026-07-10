const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/defect.controller');
const { requireResident } = require('../middleware/auth.middleware');

// POST /api/defect — resident submits a defect report (fires Defect Tracking workflow).
router.post('/', requireResident, controller.submitDefect);

// GET /api/defect/mine — the resident's own submissions (full detail), from Mongo.
router.get('/mine', requireResident, controller.listMine);

module.exports = router;
