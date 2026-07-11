const express    = require('express');
const router     = express.Router();
const resources  = require('../controllers/resource.controller');
const { requireManagement } = require('../middleware/auth.middleware');

router.use(requireManagement);

router.get('/resources',               resources.listForManagement);
router.get('/resources/:id/download',  resources.downloadForManagement);
router.post('/resources',              resources.create);
router.delete('/resources/:id',        resources.remove);

module.exports = router;
