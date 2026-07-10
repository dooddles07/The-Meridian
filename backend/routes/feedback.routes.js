const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/feedback.controller');
const { requireResident } = require('../middleware/auth.middleware');

// POST /api/feedback — resident submits feedback/complaint (fires Feedback workflow).
router.post('/', requireResident, controller.submitFeedback);

// GET /api/feedback/mine — the resident's own submissions (full detail), from Mongo.
router.get('/mine', requireResident, controller.listMine);

module.exports = router;
