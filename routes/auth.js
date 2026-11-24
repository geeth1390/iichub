'use strict';
// Accounts: register, sign in, password change/reset, email verification.
const { checkPolicy, hashPassword, verifyPassword, newLinkToken, sha256 } = require('../lib/passwords');
const { SELF_SIGNUP_ROLES } = require('../lib/auth');
const { cleanEmail, EMAIL_RE, httpError } = require('../lib/util');
const { mailEnabled, sendEmail } = require('../lib/mailer');

const MAX_FAILS = 8;          // wrong passwords before a lock
const LOCK_MINUTES = 15;

const str = (max, min = 0) => ({ type: 'string', minLength: min, maxLength: max });

module.exports = async function authRoutes(app, { db, auth, audit, config }) {
  const strict = { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } };

  function publicUser(u) {
    return {
      id: Number(u.id), email: u.email, name: u.name, role: u.role,
      centre_id: u.centre_id == null ? null : Number(u.centre_id),
      must_change_password: Boolean(u.must_change_password),
      email_verified: Boolean(u.email_verified_at),
    };
  }

  async function sendLink(user, purpose) {
    if (!mailEnabled()) return false;
    const { raw, hash } = newLinkToken();
    const hours = purpose === 'reset' ? 1 : 48;
    await db.query(
      `UPDATE auth_token SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
      [user.id, purpose]
    );
    await db.query(
      `INSERT INTO auth_token (user_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
      [user.id, purpose, hash, hours]
    );
    const link = `${config.siteUrl}/#${purpose === 'reset' ? 'reset' : 'verify'}=${raw}`;
    const subject = purpose === 'reset' ? 'Reset your IICHUB password' : 'Confirm your IICHUB email';
    const body = purpose === 'reset'
      ? `Hi ${user.name},\n\nUse this link within 1 hour to choose a new password:\n${link}\n\nIf you didn't ask for this, ignore this email; your password stays the same.\n\n— IICHUB`
      : `Hi ${user.name},\n\nPlease confirm your email address:\n${link}\n\n— IICHUB`;
    await sendEmail(user.email, subject, body);
    return true;
  }

  async function useLinkToken(raw, purpose) {
    const { rows } = await db.query(
      `UPDATE auth_token SET used_at = now()
        WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [sha256(raw || ''), purpose]
    );
    return rows[0] ? Number(rows[0].user_id) : null;
  }

  // ---- register (innovators and equipment owners only) ----
  app.post('/auth/register', {
    ...{ config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['email', 'password', 'name'],
        properties: {
          email: str(254, 3), password: str(128, 1), name: str(80, 2),
          phone: str(20), institution: str(120),
          affiliation: { enum: ['student', 'startup', 'industry', 'individual', 'institution'] },
          account_type: { enum: SELF_SIGNUP_ROLES },
        },
      },
    },
  }, async (req, reply) => {
    const b = req.body;
    const email = cleanEmail(b.email);
    const name = b.name.trim();
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address.');
    if (name.length < 2) throw httpError(400, 'Enter your name.');
    const policy = checkPolicy(b.password, { email, name });
    if (policy) throw httpError(400, policy);
    const phone = b.phone && b.phone.trim() ? b.phone.trim() : null;
    if (phone && !/^\+?[0-9 -]{8,16}$/.test(phone)) throw httpError(400, 'Enter a valid phone number, or leave it empty.');

    const hash = await hashPassword(b.password);
    let user;
    try {
      const r = await db.query(
        `INSERT INTO app_user (email, name, phone, role, affiliation, institution, password_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, email, name, role, centre_id, token_version, must_change_password, email_verified_at`,
        [email, name, phone, b.account_type || 'innovator', b.affiliation || 'individual',
         b.institution ? b.institution.trim() : null, hash]
      );
      user = r.rows[0];
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'An account with this email or phone already exists. Try signing in.');
      throw e;
    }
    req.user = { id: Number(user.id), role: user.role };
    await audit(req, 'auth.register', 'app_user', user.id, { role: user.role });
    const emailed = await sendLink(user, 'verify').catch((e) => { req.log.error(e, 'verify email failed'); return false; });
    return reply.code(201).send({ token: auth.issueToken(user), user: publicUser(user), verification_sent: emailed });
  });

  // ---- sign in ----
  app.post('/auth/login', {
    ...strict,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['email', 'password'],
        properties: { email: str(254, 1), password: str(200, 1) },
      },
    },
  }, async (req) => {
    const email = cleanEmail(req.body.email);
    const { rows } = await db.query(
      `SELECT id, email, name, role, centre_id, is_active, password_hash, token_version,
              failed_logins, locked_until, must_change_password, email_verified_at
         FROM app_user WHERE email = $1`,
      [email]
    );
    const u = rows[0];
    const fail = async (why) => {
      await audit(req, 'auth.login', 'app_user', u ? u.id : null, { email, why }, false, why);
      throw httpError(401, 'Email or password is incorrect.');
    };

    if (u && u.locked_until && new Date(u.locked_until) > new Date()) {
      await verifyPassword(req.body.password, null); // same timing
      await audit(req, 'auth.login', 'app_user', u.id, { email, why: 'locked' }, false, 'locked');
      throw httpError(429, `Too many wrong attempts. Try again in ${LOCK_MINUTES} minutes or reset your password.`);
    }
    const ok = await verifyPassword(req.body.password, u ? u.password_hash : null);
    if (!u) return fail('no such user');
    if (!ok) {
      // One atomic statement, so parallel guesses can't overwrite each
      // other's count and slip past the lock.
      const { rows: lk } = await db.query(
        `UPDATE app_user SET
            locked_until  = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END,
            failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END
          WHERE id = $1
          RETURNING (locked_until IS NOT NULL AND locked_until > now()) AS locked`,
        [u.id, MAX_FAILS, LOCK_MINUTES]
      );
      if (lk[0] && lk[0].locked) {
        await audit(req, 'auth.locked', 'app_user', u.id, { email }, false, 'too many wrong passwords');
      }
      return fail('wrong password');
    }
    if (!u.is_active) return fail('account disabled');

    await db.query(`UPDATE app_user SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [u.id]);
    req.user = { id: Number(u.id), role: u.role };
    await audit(req, 'auth.login', 'app_user', u.id, null, true);
    return { token: auth.issueToken(u), user: publicUser(u) };
  });

  // ---- who am I ----
  app.get('/auth/me', { preValidation: auth.guard(null, { allowPasswordChange: true }) }, async (req) => {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.phone, u.name, u.role, u.centre_id, c.name AS centre_name,
              u.affiliation, u.institution, u.must_change_password, u.email_verified_at
         FROM app_user u LEFT JOIN centre c ON c.id = u.centre_id WHERE u.id = $1`,
      [req.user.id]
    );
    const u = rows[0];
    return { ...publicUser(u), phone: u.phone, centre_name: u.centre_name, affiliation: u.affiliation,
             institution: u.institution, email_required: mailEnabled() };
  });

  // ---- change password (also clears a temporary password) ----
  app.post('/auth/change-password', {
    ...strict,
    preValidation: auth.guard(null, { allowPasswordChange: true }),
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['current_password', 'new_password'],
        properties: { current_password: str(200, 1), new_password: str(128, 1) },
      },
    },
  }, async (req) => {
    const { rows } = await db.query('SELECT password_hash, email, name FROM app_user WHERE id = $1', [req.user.id]);
    if (!(await verifyPassword(req.body.current_password, rows[0].password_hash))) {
      await audit(req, 'auth.change_password', 'app_user', req.user.id, null, false, 'wrong current password');
      throw httpError(400, 'Your current password is incorrect.');
    }
    if (req.body.current_password === req.body.new_password) throw httpError(400, 'Choose a password different from the current one.');
    const policy = checkPolicy(req.body.new_password, rows[0]);
    if (policy) throw httpError(400, policy);
    const r = await db.query(
      `UPDATE app_user SET password_hash = $2, must_change_password = FALSE, token_version = token_version + 1
        WHERE id = $1 RETURNING id, email, name, role, centre_id, token_version, must_change_password, email_verified_at`,
      [req.user.id, await hashPassword(req.body.new_password)]
    );
    await audit(req, 'auth.change_password', 'app_user', req.user.id);
    return { token: auth.issueToken(r.rows[0]), user: publicUser(r.rows[0]) };
  });

  // ---- sign out on every device ----
  app.post('/auth/logout-all', { preValidation: auth.guard(null, { allowPasswordChange: true }) }, async (req) => {
    await db.query('UPDATE app_user SET token_version = token_version + 1 WHERE id = $1', [req.user.id]);
    await audit(req, 'auth.logout_all', 'app_user', req.user.id);
    return { ok: true };
  });

  // ---- forgotten password ----
  app.post('/auth/forgot-password', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['email'], properties: { email: str(254, 1) } } },
  }, async (req) => {
    if (!mailEnabled()) {
      return { ok: true, message: 'Email is not set up yet. Ask your administrator to reset your password.' };
    }
    const { rows } = await db.query(
      'SELECT id, email, name FROM app_user WHERE email = $1 AND is_active', [cleanEmail(req.body.email)]
    );
    if (rows[0]) {
      await sendLink({ ...rows[0], id: Number(rows[0].id) }, 'reset').catch((e) => req.log.error(e, 'reset email failed'));
      await audit(req, 'auth.forgot_password', 'app_user', rows[0].id);
    }
    // Same answer either way, so this can't be used to test which emails exist.
    return { ok: true, message: 'If that email has an account, a reset link is on its way.' };
  });

  app.post('/auth/reset-password', {
    ...strict,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['token', 'password'],
        properties: { token: str(100, 10), password: str(128, 1) },
      },
    },
  }, async (req) => {
    const { rows: pre } = await db.query(
      `SELECT u.email, u.name FROM auth_token t JOIN app_user u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.purpose = 'reset' AND t.used_at IS NULL AND t.expires_at > now()`,
      [sha256(req.body.token)]
    );
    if (!pre[0]) throw httpError(400, 'This reset link has expired or was already used. Ask for a new one.');
    const policy = checkPolicy(req.body.password, pre[0]);
    if (policy) throw httpError(400, policy);
    const userId = await useLinkToken(req.body.token, 'reset');
    if (!userId) throw httpError(400, 'This reset link has expired or was already used. Ask for a new one.');
    await db.query(
      `UPDATE app_user SET password_hash = $2, must_change_password = FALSE, failed_logins = 0,
              locked_until = NULL, token_version = token_version + 1,
              email_verified_at = COALESCE(email_verified_at, now())
        WHERE id = $1`,
      [userId, await hashPassword(req.body.password)]
    );
    req.user = { id: userId };
    await audit(req, 'auth.reset_password', 'app_user', userId);
    return { ok: true };
  });

  app.post('/auth/verify-email', {
    ...strict,
    schema: { body: { type: 'object', additionalProperties: false, required: ['token'], properties: { token: str(100, 10) } } },
  }, async (req) => {
    const userId = await useLinkToken(req.body.token, 'verify');
    if (!userId) throw httpError(400, 'This confirmation link has expired or was already used.');
    await db.query('UPDATE app_user SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [userId]);
    return { ok: true };
  });

  app.post('/auth/resend-verification', {
    config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
    preValidation: auth.guard(),
  }, async (req) => {
    if (req.user.email_verified_at) return { ok: true, already: true };
    const sent = await sendLink(req.user, 'verify');
    return { ok: true, sent };
  });
};
