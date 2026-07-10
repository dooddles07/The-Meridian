// server.js
// The Meridian — Portal (PORTFOLIO DEMO BUILD)
//
// This demo runs FULLY CLIENT-SIDE with no external connections: no database,
// no CRM/GHL, no webhooks, no auth server. This Node process only serves the
// static frontend in ../public. All API calls the frontend makes are intercepted
// in the browser by public/js/demo-backend.js and answered from seeded, in-browser
// (localStorage) data — so nothing ever leaves the machine and no real workflow
// can be triggered.
//
// The original, full backend implementation is kept under ./controllers, ./models,
// ./routes and ./services as reference (it is NOT mounted here). See README.

require('dotenv').config();

const express = require('express');
const path    = require('path');
const helmet  = require('helmet');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
// Kept from the production build to show intent. CSP allows the app's own inline
// scripts/styles, the CDN libraries (jsDelivr), Google Fonts and QR images. No
// external app/API hosts are allowed — the demo talks to nothing but itself.
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      scriptSrcAttr:  ["'unsafe-inline'"],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
      fontSrc:        ["'self'", 'data:', 'https://fonts.gstatic.com'],
      imgSrc:         ["'self'", 'data:', 'blob:', 'https://api.qrserver.com'],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
}));

// Same-origin only; the demo has no cross-origin API surface.
app.use(cors({ origin: false }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({ success: true, message: 'The Meridian demo is running.', timestamp: new Date().toISOString() });
});

// ── No live API ─────────────────────────────────────────────────────────────
// The demo has no server-side API. Any /api/* request that slips past the browser
// mock (public/js/demo-backend.js) gets a clear JSON 404 rather than the SPA HTML.
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: 'This is a static demo — the API runs entirely in the browser (see public/js/demo-backend.js).' });
});

// ── Static frontend ─────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, '../public');
app.use(express.static(PUBLIC_DIR));

app.get('/management', (req, res) => res.redirect(301, '/management.html'));
app.get('/portal',     (req, res) => res.redirect(301, '/portal.html'));

// Unknown non-asset paths fall back to the landing page; asset-like paths 404.
app.get('*', (req, res) => {
  if (path.extname(req.path)) return res.status(404).json({ success: false, message: 'Not found.' });
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ The Meridian demo running on http://localhost:${PORT}`);
  console.log('   Static, client-side only — no database, CRM, or external connection.');
});

module.exports = app;
