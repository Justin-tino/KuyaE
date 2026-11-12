'use strict';

require('dotenv').config();

const env = process.env;

const config = {
  port: parseInt(env.PORT || '3000', 10),
  nodeEnv: env.NODE_ENV || 'development',
  isProduction: (env.NODE_ENV || 'development') === 'production',
  supabaseUrl: (env.SUPABASE_URL || '').trim().replace(/\/+$/, ''),
  supabaseServiceKey: (env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  bucket: (env.SUPABASE_BUCKET || 'menu-images').trim(),
  sessionSecret: (env.SESSION_SECRET || '').trim(),
  sessionHours: Math.max(1, parseInt(env.SESSION_HOURS || '12', 10) || 12),
  timezone: (env.TIMEZONE || 'Asia/Manila').trim(),
  cookieName: 'kuyae_pos_session',
};

config.configured = Boolean(config.supabaseUrl && config.supabaseServiceKey);

config.missingEnvVars = [];
if (!config.supabaseUrl) config.missingEnvVars.push('SUPABASE_URL');
if (!config.supabaseServiceKey) config.missingEnvVars.push('SUPABASE_SERVICE_ROLE_KEY');
if (!config.sessionSecret) config.missingEnvVars.push('SESSION_SECRET');

if (!config.sessionSecret) {
  if (config.isProduction) {
    console.error(
      '[config] FATAL: SESSION_SECRET is required in production. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
    process.exit(1);
  }
  // Development fallback only: sessions will not survive a restart.
  config.sessionSecret = 'dev-only-insecure-secret';
  console.warn('[config] SESSION_SECRET is not set. Using an insecure development fallback.');
}

if (!config.configured) {
  console.warn(
    '[config] Supabase is not configured yet. The app will start and show a setup screen. ' +
      'Missing: ' +
      config.missingEnvVars.join(', ')
  );
}

module.exports = { config };
