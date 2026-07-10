const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/move.controller');
const { requireResident } = require('../middleware/auth.middleware');

// POST /api/move — resident submits a move-in/out request (token-scoped identity).
router.post('/', requireResident, controller.submitMove);

// GET /api/move/mine — the resident's own move requests (full detail), from Mongo.
router.get('/mine', requireResident, controller.listMine);

module.exports = router;
