const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/guardhouse.controller');
const { requireGuardhouse } = require('../middleware/auth.middleware');

// Guardhouse-only: verify a guest pass by reference, and advance the stage on admit.
router.get('/lookup',   requireGuardhouse, controller.lookup);
router.post('/checkin', requireGuardhouse, controller.checkin);
// Parcel checker: look up a parcel by reference and set its status.
router.get('/parcel',         requireGuardhouse, controller.parcelLookup);
router.post('/parcel/status', requireGuardhouse, controller.parcelStatus);
// Shared, live activity log across all guardhouse stations (persisted in MongoDB).
router.get('/log',    requireGuardhouse, controller.listLog);
router.post('/log',   requireGuardhouse, controller.addLog);
router.delete('/log', requireGuardhouse, controller.clearLog);

module.exports = router;
