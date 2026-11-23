'use strict';
// Sessions, guards and the role rules — the single place that decides
// who may do what. The database re-checks staff actions on its own.
const jwt = require('jsonwebtoken');

const ROLES = ['innovator', 'equipment_owner', 'centre_staff', 'centre_manager', 'apis_admin', 'super_admin'];
const STAFF = ['centre_staff', 'centre_manager', 'apis_admin', 'super_admin'];
const ADMINS = ['apis_admin', 'super_admin'];
const CENTRE_ROLES = ['centre_staff', 'centre_manager'];
const SELF_SIGNUP_ROLES = ['innovator', 'equipment_owner'];

// Which roles each role may create or manage.
const MANAGEABLE = {
  super_admin: ROLES,
  apis_admin: ['innovator', 'equipment_owner', 'centre_staff', 'centre_manager'],
  centre_manager: ['centre_staff'],
};

const SESSION_HOURS = 12;
const ISSUER = 'protohub';

function createAuth({ db, secret }) {
  function issueToken(user) {
    return jwt.sign({ tv: user.token_version }, secret, {
      subject: String(user.id),
      expiresIn: `${SESSION_HOURS}h`,
      issuer: ISSUER,
      algorithm: 'HS256',
    });
  }

  // Loads the user fresh from the database on every request, so a
  // disabled account, a role change or a password change takes effect
  // immediately (old tokens stop working).
  async function authenticate(req) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
    if (!token) return { error: 401, msg: 'Please sign in.' };
    let claims;
    try {
      claims = jwt.verify(token, secret, { issuer: ISSUER, algorithms: ['HS256'] });
    } catch {
      return { error: 401, msg: 'Your session has expired. Please sign in again.' };
    }
    const { rows } = await db.query(
      `SELECT id, email, name, role, centre_id, is_active, token_version,
              must_change_password, email_verified_at
         FROM app_user WHERE id = $1`,
      [claims.sub]
    );
    const u = rows[0];
    if (!u || !u.is_active || u.token_version !== claims.tv) {
      return { error: 401, msg: 'Your session has ended. Please sign in again.' };
    }
    u.id = Number(u.id);
    u.centre_id = u.centre_id == null ? null : Number(u.centre_id);
    return { user: u };
  }

  // allowPasswordChange: routes a user with a temporary password may use.
  function guard(roles = null, { allowPasswordChange = false } = {}) {
    return async (req, reply) => {
      const r = await authenticate(req);
      if (r.error) return reply.code(r.error).send({ error: r.msg });
      req.user = r.user;
      if (r.user.must_change_password && !allowPasswordChange) {
        return reply.code(403).send({ error: 'Please set a new password first.', code: 'must_change_password' });
      }
      if (roles && !roles.includes(r.user.role)) {
        return reply.code(403).send({ error: 'You do not have permission to do that.' });
      }
    };
  }

  // Tries to read a session but never rejects (for public pages that show
  // a little more to signed-in users).
  async function optionalUser(req) {
    if (!req.headers.authorization) return null;
    const r = await authenticate(req).catch(() => ({}));
    return r.user && !r.user.must_change_password ? r.user : null;
  }

  return { issueToken, guard, optionalUser };
}

const isAdmin = (u) => ADMINS.includes(u.role);

// May this user work on this centre's queue, stock and machines?
function canStaffCentre(user, centreId) {
  if (isAdmin(user)) return true;
  return CENTRE_ROLES.includes(user.role) && user.centre_id != null && Number(centreId) === user.centre_id;
}

// May `actor` create or change an account that has (or will have) `role`
// at `centreId`?
function canManageRole(actor, role, centreId) {
  const allowed = MANAGEABLE[actor.role] || [];
  if (!allowed.includes(role)) return false;
  if (actor.role === 'centre_manager') return Number(centreId) === actor.centre_id;
  return true;
}

module.exports = {
  ROLES, STAFF, ADMINS, CENTRE_ROLES, SELF_SIGNUP_ROLES, MANAGEABLE,
  createAuth, isAdmin, canStaffCentre, canManageRole,
};
