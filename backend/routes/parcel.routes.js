const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/parcel.controller');
const { requireResident } = require('../middleware/auth.middleware');

router.post('/', requireResident, controller.notifyParcel);
router.get('/mine', requireResident, controller.listMine);

module.exports = router;
