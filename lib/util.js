'use strict';

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

// An error with an HTTP status and a message that is safe to show.
function httpError(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  e.expose = true;
  return e;
}

function cleanEmail(e) {
  return typeof e === 'string' ? e.trim().toLowerCase() : '';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Writes to the audit log. Never lets a logging failure break a request.
function makeAudit(db, log) {
  return async function audit(req, action, objectType, objectId, detail = null, ok = true, error = null) {
    try {
      await db.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, object_type, object_id, detail, ip, ok, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          req.user ? req.user.id : null,
          req.user ? req.user.role : null,
          action,
          objectType,
          objectId == null ? null : Number(objectId),
          detail ? JSON.stringify(detail) : null,
          req.ip || null,
          ok,
          error,
        ]
      );
    } catch (e) {
      log.error({ err: e }, 'audit write failed');
    }
  };
}

module.exports = { num, int, httpError, cleanEmail, EMAIL_RE, makeAudit };
