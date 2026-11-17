'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { config } = require('./config');
const { friendlyDbError } = require('./supabase');
const { attachUser, csrfProtection } = require('./middleware/auth');
const { startRealtime } = require('./realtime');

const authRoutes = require('./routes/auth');
const menuRoutes = require('./routes/menu');
const orderRoutes = require('./routes/orders');
const staffMealRoutes = require('./routes/staffMeals');
const userRoutes = require('./routes/users');
const auditRoutes = require('./routes/audit');
const reportRoutes = require('./routes/reports');
const settingsRoutes = require('./routes/settings');
const eventRoutes = require('./routes/events');
const messageRoutes = require('./routes/messages');
const { startMessageRetention } = require('./lib/messageRetention');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind a proxy

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
const supabaseOrigin = config.supabaseUrl ? new URL(config.supabaseUrl).origin : null;
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:', ...(supabaseOrigin ? [supabaseOrigin] : [])],
        'connect-src': ["'self'", ...(supabaseOrigin ? [supabaseOrigin] : [])],
        'font-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'same-origin' },
  })
);

// ---------------------------------------------------------------------------
// Parsers & cookies
// ---------------------------------------------------------------------------
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ---------------------------------------------------------------------------
// Tiny request log (no external dependency)
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api/events')) return; // noisy long-lived stream
    const ms = Date.now() - startedAt;
    if (res.statusCode >= 400 || ms > 1500) {
      console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
    }
  });
  next();
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.use('/api', csrfProtection);
app.use('/api', attachUser);

// API data is live data: browsers and proxies must never cache it.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});

app.use('/api', authRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/staff-meals', staffMealRoutes);
app.use('/api/users', userRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/messages', messageRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------
const publicDir = path.join(__dirname, '..', 'public');
app.use(
  express.static(publicDir, {
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/.test(filePath)) {
        // Always revalidate code so updates reach tablets immediately (cheap 304s).
        res.setHeader('Cache-Control', 'no-cache');
      } else if (/\.(png|jpg|jpeg|svg|webp|ico)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    },
  })
);

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  const message =
    err && err.expose !== false && typeof err.message === 'string' && err.message.length < 200
      ? err.message
      : friendlyDbError(err);
  res.status(err && err.status ? err.status : 500).json({ error: message || 'Something went wrong.' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
startRealtime();
startMessageRetention();

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log('');
  console.log('  Kuya E Tapsilogan POS');
  console.log(`  http://localhost:${config.port}`);
  console.log(`  Supabase:      ${config.configured ? 'configured' : 'NOT configured (setup screen will show)'}`);
  console.log(`  Timezone:      ${config.timezone}`);
  console.log(`  Environment:   ${config.nodeEnv}`);
  console.log('');
});

// A clear message beats a stack trace when a previous instance still owns the port.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  [server] Port ${config.port} is already in use.`);
    console.error('           Another POS server is probably still running.');
    console.error('           Close it (or set PORT to a free port) and start again.');
    console.error('');
    process.exit(1);
  }
  throw err;
});
