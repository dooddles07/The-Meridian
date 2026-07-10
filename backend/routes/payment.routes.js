const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/payment.controller');
const { requireResident, requireResidentOrManagement } = require('../middleware/auth.middleware');

// GET /api/payments/mine — resident's payment history (scoped to the token identity)
router.get('/mine', requireResident, controller.myPayments);
// POST /api/payments/pay-deposit — resident confirms their OWN deposit after paying in
// the Wibiz link, OR management marks a booking paid as a manual override. A resident
// caller is verified to own the opportunity before it advances (see payDeposit); a
// management caller is trusted to act on any opportunity_id.
router.post('/pay-deposit', requireResidentOrManagement, controller.payDeposit);
// POST /api/payments/confirm — payment-provider success webhook. Authenticated by a
// shared secret inside the controller (verifyWebhookSecret), NOT a user token. (C-02/M-07)
router.post('/confirm', controller.confirmPayment);

module.exports = router;
