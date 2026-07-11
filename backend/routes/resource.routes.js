const express    = require('express');
const router     = express.Router();
const rateLimit  = require('express-rate-limit');
const controller = require('../controllers/resource.controller');
const { requireResident } = require('../middleware/auth.middleware');

const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many downloads. Please wait a few minutes and try again.' },
});

router.get('/',               requireResident, controller.listForResidents);
router.get('/:id/download',   requireResident, downloadLimiter, controller.downloadForResident);

module.exports = router;
