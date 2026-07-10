const express    = require('express');
const router     = express.Router();
const rateLimit  = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const controller = require('../controllers/auth.controller');

// Reject wrong-typed or oversized credentials before they reach the controller;
// empty/missing fields fall through to the controller's own "required" message so
// the resident UX is unchanged.
function validate(req, res, next) {
  if (!validationResult(req).isEmpty()) {
    return res.status(400).json({ success: false, message: 'Please check your details and try again.' });
  }
  next();
}
const residentRules = [
  body('email').optional({ checkFalsy: true }).isString().isLength({ max: 254 }),
  body('unit').optional({ checkFalsy: true }).isString().isLength({ max: 20 }),
];
const staffRules = [
  body('username').optional({ checkFalsy: true }).isString().isLength({ max: 64 }),
  body('password').optional({ checkFalsy: true }).isString().isLength({ max: 200 }),
];

// Counts per client IP (trust proxy is set in server.js so the real IP is used
// behind Railway). Staff logins are a high-value password-guessing target so they
// get a tighter cap; resident login (email+unit) is looser so a shared building IP
// isn't locked out during normal use.
const limiterOpts = {
  windowMs: 15 * 60 * 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please wait a few minutes and try again.' },
};
const staffLoginLimiter    = rateLimit({ ...limiterOpts, limit: 10 });
const residentLoginLimiter = rateLimit({ ...limiterOpts, limit: 20 });

router.post('/resident/login',   residentLoginLimiter, residentRules, validate, controller.residentLogin);
router.post('/management/login', staffLoginLimiter,    staffRules,    validate, controller.managementLogin);
router.post('/guardhouse/login', staffLoginLimiter,    staffRules,    validate, controller.guardhouseLogin);

module.exports = router;
