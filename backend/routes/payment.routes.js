const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/payment.controller');
const { requireResident, requireResidentOrManagement } = require('../middleware/auth.middleware');

router.get('/mine', requireResident, controller.myPayments);
// Resident confirms their OWN deposit after paying via the Wibiz link, OR management
// marks a booking paid as a manual override. A resident caller is verified to own the
// opportunity before it advances (see payDeposit); a management caller is trusted to
// act on any opportunity_id.
router.post('/pay-deposit', requireResidentOrManagement, controller.payDeposit);
// Payment-provider success webhook — authenticated by a shared secret inside the
// controller (verifyWebhookSecret), not a user token.
router.post('/confirm', controller.confirmPayment);

module.exports = router;
