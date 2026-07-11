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
const residentLoginRules = [
  body('email').optional({ checkFalsy: true }).isString().isLength({ max: 254 }),
  body('password').optional({ checkFalsy: true }).isString().isLength({ max: 200 }),
];
const residentSignupRules = [
  body('name').optional({ checkFalsy: true }).isString().isLength({ max: 120 }),
  body('email').optional({ checkFalsy: true }).isString().isLength({ max: 254 }),
  body('unit').optional({ checkFalsy: true }).isString().isLength({ max: 20 }),
  body('password').optional({ checkFalsy: true }).isString().isLength({ min: 8, max: 200 }),
];
const staffRules = [
  body('username').optional({ checkFalsy: true }).isString().isLength({ max: 64 }),
  body('password').optional({ checkFalsy: true }).isString().isLength({ max: 200 }),
];
const requestResetRules = [
  body('email').optional({ checkFalsy: true }).isString().isLength({ max: 254 }),
];
const resetPasswordRules = [
  body('token').optional({ checkFalsy: true }).isString().isLength({ min: 32, max: 200 }),
  body('password').optional({ checkFalsy: true }).isString().isLength({ min: 8, max: 200 }),
];

// Counts per client IP (trust proxy is set in server.js so the real IP is used
// behind Railway). Resident login is now real password auth (not a lookup), so
// it gets the same cap as staff logins; account creation is capped tighter still
// since it's a distinct spam/abuse surface from credential guessing.
const limiterOpts = {
  windowMs: 15 * 60 * 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please wait a few minutes and try again.' },
};
const staffLoginLimiter    = rateLimit({ ...limiterOpts, limit: 10 });
const residentLoginLimiter = rateLimit({ ...limiterOpts, limit: 10 });
const residentSignupLimiter = rateLimit({ ...limiterOpts, windowMs: 60 * 60 * 1000, limit: 5 });
// Tighter than login — this endpoint sends an email (abuse = spam/cost, not
// just credential guessing) and is a natural target for enumeration attempts.
const requestResetLimiter = rateLimit({ ...limiterOpts, limit: 3 });

router.post('/resident/signup', residentSignupLimiter, residentSignupRules, validate, controller.residentSignup);
router.post('/resident/login',   residentLoginLimiter, residentLoginRules, validate, controller.residentLogin);
router.post('/resident/request-reset', requestResetLimiter, requestResetRules, validate, controller.requestPasswordReset);
router.post('/resident/reset-password', residentLoginLimiter, resetPasswordRules, validate, controller.resetPassword);
router.post('/management/login', staffLoginLimiter,    staffRules,    validate, controller.managementLogin);
router.post('/guardhouse/login', staffLoginLimiter,    staffRules,    validate, controller.guardhouseLogin);
router.post('/logout', controller.logout);

module.exports = router;
