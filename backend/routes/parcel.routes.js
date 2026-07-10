const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/parcel.controller');
const { requireResident } = require('../middleware/auth.middleware');

// POST /api/parcel — resident notifies the guardhouse of an expected parcel (by reference).
router.post('/', requireResident, controller.notifyParcel);

// GET /api/parcel/mine — the resident's own parcel notifications (full detail), from Mongo.
router.get('/mine', requireResident, controller.listMine);

module.exports = router;
