// ============================================================
// Create (or reset) an admin account from the command line.
// Prints a one-time temporary password; it must be changed at first
// sign-in. Use this if you are ever locked out of every super admin.
//
//   node scripts/create-admin.js <email> "<Full name>" [super_admin|apis_admin]
// ============================================================
'use strict';
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const { dbConfig } = require('../lib/db-config');
const { hashPassword, tempPassword } = require('../lib/passwords');
const { cleanEmail, EMAIL_RE } = require('../lib/util');

async function main() {
  const [emailArg, name, role = 'super_admin'] = process.argv.slice(2);
  const email = cleanEmail(emailArg);
  if (!EMAIL_RE.test(email) || !name || !['super_admin', 'apis_admin'].includes(role)) {
    console.error('Usage: node scripts/create-admin.js <email> "<Full name>" [super_admin|apis_admin]');
    process.exit(2);
  }
  const temp = tempPassword();
  const db = new Client(dbConfig());
  await db.connect();
  const r = await db.query(
    `INSERT INTO app_user (email, name, role, password_hash, must_change_password, email_verified_at)
     VALUES ($1,$2,$3,$4,TRUE,now())
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, centre_id = NULL,
       password_hash = EXCLUDED.password_hash, must_change_password = TRUE, is_active = TRUE,
       failed_logins = 0, locked_until = NULL, token_version = app_user.token_version + 1
     RETURNING id`,
    [email, name, role, await hashPassword(temp)]
  );
  await db.query(
    `INSERT INTO audit_log (actor_role, action, object_type, object_id, detail)
     VALUES ('cli', 'user.create_admin_cli', 'app_user', $1, $2)`,
    [r.rows[0].id, JSON.stringify({ email, role })]
  );
  await db.end();
  console.log(`\n  ${role} ready: ${email}\n  Temporary password: ${temp}\n  It must be changed at first sign-in.\n`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
