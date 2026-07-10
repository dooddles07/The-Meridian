// PORTFOLIO DEMO: runs fully client-side. This process only serves the static
// frontend in ../public — all API calls are intercepted in-browser by
// public/js/demo-backend.js. The real backend (./controllers, ./models, ./routes,
// ./services) is kept as reference only and is not mounted here.

require('dotenv').config();

const express = require('express');
const path    = require('path');
const helmet  = require('helmet');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// CSP allows only self, jsDelivr, Google Fonts and the QR image API — no other
// external hosts, since the demo talks to nothing but itself.
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

app.get('/health', (req, res) => {
  res.status(200).json({ success: true, message: 'The Meridian demo is running.', timestamp: new Date().toISOString() });
});

// Any /api/* request that slips past the browser mock gets a JSON 404 instead of the SPA HTML.
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: 'This is a static demo — the API runs entirely in the browser (see public/js/demo-backend.js).' });
});

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
