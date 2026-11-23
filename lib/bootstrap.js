'use strict';
// Creates the very first super admin from SUPERADMIN_EMAIL and
// SUPERADMIN_PASSWORD, but only while no super admin exists. After the
// first sign-in the password must be changed, and the variables should be
// removed from the server.
const { hashPassword, checkPolicy } = require('./passwords');
const { cleanEmail, EMAIL_RE } = require('./util');

async function bootstrapSuperAdmin(db, log) {
  const email = cleanEmail(process.env.SUPERADMIN_EMAIL || '');
  const password = process.env.SUPERADMIN_PASSWORD || '';
  const name = (process.env.SUPERADMIN_NAME || 'Super Admin').trim();

  const { rows } = await db.query(`SELECT count(*)::int AS n FROM app_user WHERE role = 'super_admin'`);
  if (rows[0].n > 0) {
    if (email || password) {
      log.warn('A super admin already exists, so SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD were ignored. Remove them from the environment.');
    }
    return;
  }
  if (!email || !password) {
    log.warn('No super admin exists yet. Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD and redeploy to create one.');
    return;
  }
  if (!EMAIL_RE.test(email)) throw new Error('SUPERADMIN_EMAIL is not a valid email address');
  const policy = checkPolicy(password, { email, name });
  if (policy) throw new Error(`SUPERADMIN_PASSWORD rejected: ${policy}`);
  if (password.length < 14) throw new Error('SUPERADMIN_PASSWORD must be at least 14 characters');

  const r = await db.query(
    `INSERT INTO app_user (email, name, role, password_hash, must_change_password, email_verified_at)
     VALUES ($1, $2, 'super_admin', $3, TRUE, now())
     ON CONFLICT (email) DO UPDATE SET role = 'super_admin', password_hash = EXCLUDED.password_hash,
         must_change_password = TRUE, is_active = TRUE, centre_id = NULL, token_version = app_user.token_version + 1
     RETURNING id`,
    [email, name, await hashPassword(password)]
  );
  await db.query(
    `INSERT INTO audit_log (actor_id, actor_role, action, object_type, object_id, detail)
     VALUES (NULL, 'system', 'user.bootstrap_super_admin', 'app_user', $1, $2)`,
    [r.rows[0].id, JSON.stringify({ email })]
  );
  log.warn(`Created the first super admin (${email}). Sign in, change the password, then remove SUPERADMIN_PASSWORD from the environment.`);
}

module.exports = { bootstrapSuperAdmin };
