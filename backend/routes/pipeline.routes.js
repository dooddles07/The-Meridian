const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/pipeline.controller');

router.get('/',       controller.listPipelines);
router.get('/verify', controller.verifyPipelines);

module.exports = router;
