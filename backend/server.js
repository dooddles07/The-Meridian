// Local dev entry point. Serves the static frontend in ../public AND mounts the
// real API (./app.js — JWT auth, MongoDB, the full route set) at /api/*, so
// `npm start` runs the whole thing (resident signup/login is genuinely real,
// backed by MONGO_URL). On Vercel, ../api/index.js re-exports ./app.js directly
// as a Serverless Function instead; static files are served by the platform.

const express = require('express');
const path    = require('path');
const helmet  = require('helmet');
const cors    = require('cors');

const api  = require('./app');
const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// CSP allows only self, jsDelivr, Google Fonts and the QR image API — no other
// external hosts, since this build talks to nothing but itself.
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

// Same-origin only; this build has no cross-origin API surface.
app.use(cors({ origin: false }));

app.use(api); // handles /api/* (its own /api/health, auth, booking, etc.)

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
  console.log(`✅ The Lumina running on http://localhost:${PORT}`);
});

module.exports = app;
