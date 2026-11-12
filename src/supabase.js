'use strict';

const { createClient } = require('@supabase/supabase-js');
const WebSocketImpl = require('ws');
const { config } = require('./config');

let client = null;

/**
 * Server-side Supabase client using the service_role key.
 * Never expose this key or this client to the browser.
 */
function getClient() {
  if (!config.configured) return null;
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: {
        transport: WebSocketImpl,
        params: { eventsPerSecond: 20 },
      },
    });
  }
  return client;
}

/** Clear, user friendly message for common Supabase errors. */
function friendlyDbError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const message = String(error.message || error);
  if (/relation .* does not exist|schema cache/i.test(message)) {
    return 'The database is not set up yet. Run supabase/setup.sql in your Supabase SQL Editor.';
  }
  if (/bucket not found/i.test(message)) {
    return 'The image bucket "menu-images" was not found. Run supabase/setup.sql or create the bucket in Supabase Storage.';
  }
  if (/invalid api key|jwt/i.test(message)) {
    return 'Supabase rejected the API key. Check SUPABASE_SERVICE_ROLE_KEY.';
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(message)) {
    return 'Cannot reach Supabase. Check your internet connection and SUPABASE_URL.';
  }
  return 'Database error. Please try again.';
}

module.exports = { getClient, friendlyDbError };
