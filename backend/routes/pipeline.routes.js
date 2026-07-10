const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/pipeline.controller');

router.get('/',       controller.listPipelines);   // configured pipeline map
router.get('/verify', controller.verifyPipelines); // live check against GHL

module.exports = router;
