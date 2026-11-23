// ============================================================
// Database migrations
// Applies every file in migrations/ once, in order, each in its own
// transaction, and records it in schema_migrations. Safe to run on
// every start: files already applied are skipped. A lock stops two
// containers migrating at the same time.
//
// With SEED_DEMO=true, also loads seeds/demo.sql once, but only into
// an empty catalogue (it never touches real data).
//
//   node scripts/migrate.js
// ============================================================
'use strict';
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { dbConfig } = require('../lib/db-config');

const LOCK_ID = 7274661;

async function main() {
  const client = new Client(dbConfig());
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

    const done = new Set(
      (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name)
    );
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

    let applied = 0;
    for (const f of files) {
      if (done.has(f)) continue;
      await runFile(client, path.join(dir, f), f);
      applied++;
    }
    console.log(applied ? `Applied ${applied} migration(s).` : 'Database schema is up to date.');

    if (String(process.env.SEED_DEMO).toLowerCase() === 'true' && !done.has('seed:demo')) {
      const { rows } = await client.query('SELECT count(*)::int AS n FROM machine');
      if (rows[0].n === 0) {
        await runFile(client, path.join(__dirname, '..', 'seeds', 'demo.sql'), 'seed:demo');
        console.log('Loaded the sample catalogue.');
      } else {
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', ['seed:demo']);
        console.log('Catalogue already has machines; sample data skipped.');
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end();
  }
}

async function runFile(client, file, name) {
  const sql = fs.readFileSync(file, 'utf8');
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
    console.log(`  applied ${name}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    e.message = `${name}: ${e.message}`;
    throw e;
  }
}

main().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
