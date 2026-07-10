const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/guardhouse.controller');
const { requireGuardhouse } = require('../middleware/auth.middleware');

router.get('/lookup',   requireGuardhouse, controller.lookup);
router.post('/checkin', requireGuardhouse, controller.checkin);
router.get('/parcel',         requireGuardhouse, controller.parcelLookup);
router.post('/parcel/status', requireGuardhouse, controller.parcelStatus);
// Activity log is shared across all guardhouse stations and persisted in MongoDB.
router.get('/log',    requireGuardhouse, controller.listLog);
router.post('/log',   requireGuardhouse, controller.addLog);
router.delete('/log', requireGuardhouse, controller.clearLog);

module.exports = router;
