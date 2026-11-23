'use strict';
// One place that turns env vars into node-postgres settings.
// DATABASE_SSL: "disable" for Dokploy's private network (default for
// local/internal hosts), "require" for hosted databases like Supabase.

function dbConfig(extra = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('FATAL: set DATABASE_URL (see .env.example)');
    process.exit(1);
  }
  const mode = (process.env.DATABASE_SSL || '').toLowerCase();
  let ssl;
  if (mode === 'require') ssl = { rejectUnauthorized: false };
  else if (mode === 'verify') ssl = { rejectUnauthorized: true };
  else ssl = false;

  return {
    connectionString: url,
    ssl,
    // Centre opening hours and "today" are Indian time.
    options: '-c timezone=Asia/Kolkata',
    application_name: 'protohub',
    ...extra,
  };
}

module.exports = { dbConfig };
