// Shared Express app — the real API. Mounted directly by server.js for local dev
// and re-exported by ../api/index.js as a single Vercel Serverless Function.
// Static file serving is NOT handled here: locally server.js adds it after this
// app; on Vercel, static files are served by the platform (outputDirectory),
// only /api/* is rewritten to this function.

require('dotenv').config();
require('./config/logging');

// Some ISP/router DNS resolvers refuse SRV queries, which breaks mongodb+srv://
// connection strings with a cryptic "querySrv ECONNREFUSED". Force a resolver
// that supports them — harmless where the default resolver already works fine.
require('dns').setServers(['1.1.1.1', '8.8.8.8']);

const express  = require('express');
const helmet   = require('helmet');
const cors     = require('cors');
const mongoose = require('mongoose');

const { errorHandler } = require('./middleware/auth.middleware');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(cors({ origin: false })); // same-origin only — frontend and API share one domain
app.use(express.json());

// Connect once per warm serverless container; skip if already connecting/connected.
// Scoped to /api only — a DB hiccup must never 503 a static asset request in the
// local-dev setup where this app is mounted alongside express.static (see server.js).
let connecting = null;
app.use('/api', (req, res, next) => {
  if (mongoose.connection.readyState === 1) return next();
  if (!connecting) {
    connecting = mongoose.connect(process.env.MONGO_URL).catch((err) => {
      connecting = null;
      throw err;
    });
  }
  connecting.then(() => next()).catch(() => {
    res.status(503).json({ success: false, message: 'Database unavailable. Please try again shortly.' });
  });
});

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'The Lumina API is running.', db: mongoose.connection.readyState === 1, timestamp: new Date().toISOString() });
});

// Mounted at the full /api/* path (not a bare prefix) so this app works
// identically whether Express sees the path directly (local dev, server.js
// mounts this at '/') or via a Vercel rewrite that preserves the original
// /api/... URL when forwarding to this serverless function.
app.use('/api/auth',          require('./routes/auth.routes'));
app.use('/api/booking',       require('./routes/booking.routes'));
app.use('/api/guest',         require('./routes/guest.routes'));
app.use('/api/defect',        require('./routes/defect.routes'));
app.use('/api/feedback',      require('./routes/feedback.routes'));
app.use('/api/move',          require('./routes/move.routes'));
app.use('/api/parcel',        require('./routes/parcel.routes'));
app.use('/api/resources',     require('./routes/resource.routes'));
app.use('/api/announcements', require('./routes/announcement.routes'));
app.use('/api/rsvp',          require('./routes/rsvp.routes'));
app.use('/api/messages',      require('./routes/messaging.routes'));
app.use('/api/payments',      require('./routes/payment.routes'));
app.use('/api/opportunities', require('./routes/opportunities.routes'));
app.use('/api/pipelines',     require('./routes/pipeline.routes'));
app.use('/api/guardhouse',    require('./routes/guardhouse.routes'));
app.use('/api/management',    require('./routes/management.routes'));

// Scoped to /api so mounting this app alongside static file serving (local dev,
// see server.js) still falls through to the static handler for non-API paths.
app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Not found.' }));
app.use(errorHandler);

module.exports = app;
