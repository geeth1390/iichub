'use strict';
// Admin console API: accounts, centres, machines, listing approval, audit.
//
//   super_admin     everything, including other admins and the audit log
//   apis_admin      centres, machines, listings; accounts below admin level
//   centre_manager  staff accounts for their own centre only
const { int, httpError, cleanEmail, EMAIL_RE } = require('../lib/util');
const { ADMINS, CENTRE_ROLES, ROLES, canManageRole } = require('../lib/auth');
const { tempPassword, hashPassword } = require('../lib/passwords');

const s = (max, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const time = { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' };
const money = { type: 'number', minimum: 0, maximum: 10000000 };
const pct = { type: 'number', minimum: 0, maximum: 100 };
const dim = { type: 'number', exclusiveMinimum: 0, maximum: 100000 };
const fine = { type: ['number', 'null'], exclusiveMinimum: 0, maximum: 100 };

const CENTRE_FIELDS = {
  name: s(120, 2), district: s(80, 1), address: s(300, 3),
  lat: { type: 'number', minimum: -90, maximum: 90 }, lng: { type: 'number', minimum: -180, maximum: 180 },
  phone: { type: ['string', 'null'], maxLength: 30 },
  opens_at: time, closes_at: time,
  working_days: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 7 } },
  is_live: { type: 'boolean' },
  state_code: { type: ['string', 'null'], maxLength: 4 },
  zone: { type: ['string', 'null'], maxLength: 60 },
  operator: { type: ['string', 'null'], maxLength: 60 },
  owner_type: { enum: ['government', 'institution', 'partner'] },
};
const MACHINE_FIELDS = {
  process_code: s(30, 1), make: s(60, 1), model: s(60, 1),
  asset_tag: { type: ['string', 'null'], maxLength: 60 },
  status: { enum: ['available', 'in_use', 'maintenance', 'broken', 'retired', 'offline'] },
  rate_per_hour: money, setup_fee: money, min_charge: money, student_discount_pct: pct,
  commissioned_on: { type: ['string', 'null'], format: 'date' },
};
const CAP_FIELDS = {
  max_x_mm: dim, max_y_mm: dim, max_z_mm: dim,
  tolerance_mm: fine, min_feature_mm: fine, layer_min_mm: fine,
  surface_finish: { enum: ['rough', 'standard', 'fine', 'mirror', null] },
  notes: { type: ['string', 'null'], maxLength: 500 },
};

// UPDATE ... SET only the whitelisted fields that were sent.
function setClause(body, fields, start = 2) {
  const cols = Object.keys(fields).filter((k) => body[k] !== undefined);
  return {
    sql: cols.map((c, i) => `${c} = $${i + start}`).join(', '),
    values: cols.map((c) => body[c]),
    cols,
  };
}

module.exports = async function adminRoutes(app, { db, auth, audit }) {
  const admins = auth.guard(ADMINS);
  const peopleManagers = auth.guard([...ADMINS, 'centre_manager']);
  const superOnly = auth.guard(['super_admin']);

  // ------------------------------------------------------------------ overview
  app.get('/admin/overview', { preValidation: admins }, async () => {
    const [roles, pending, jobs, centres] = await Promise.all([
      db.query(`SELECT role, count(*)::int AS n FROM app_user WHERE is_active GROUP BY role`),
      db.query(`SELECT count(*)::int AS n FROM centre WHERE owner_type = 'private' AND verification = 'pending'`),
      db.query(`SELECT status, count(*)::int AS n FROM job GROUP BY status`),
      db.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE is_live)::int AS live FROM centre`),
    ]);
    return {
      users_by_role: Object.fromEntries(roles.rows.map((r) => [r.role, r.n])),
      pending_listings: pending.rows[0].n,
      jobs_by_status: Object.fromEntries(jobs.rows.map((r) => [r.status, r.n])),
      centres: centres.rows[0],
    };
  });

  // ------------------------------------------------------------------ accounts
  app.get('/admin/users', {
    preValidation: peopleManagers,
    schema: {
      querystring: {
        type: 'object',
        properties: { q: s(100), role: { enum: ROLES }, centre_id: { type: 'integer' } },
      },
    },
  }, async (req) => {
    const { q, role, centre_id } = req.query;
    const where = [];
    const vals = [];
    const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
    if (req.user.role === 'centre_manager') add('u.centre_id = ?', req.user.centre_id);
    else if (centre_id) add('u.centre_id = ?', centre_id);
    if (role) add('u.role = ?', role);
    if (q) {
      vals.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`(u.email ILIKE $${vals.length} OR u.name ILIKE $${vals.length})`);
    }
    // the locked system account that owns sample history is hidden
    where.push(`u.email NOT LIKE '%@system.invalid'`);
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.name, u.phone, u.role, u.centre_id, c.name AS centre_name, u.is_active,
              u.must_change_password, u.last_login_at, u.created_at,
              (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked
         FROM app_user u LEFT JOIN centre c ON c.id = u.centre_id
        WHERE ${where.join(' AND ')}
        ORDER BY CASE u.role WHEN 'super_admin' THEN 0 WHEN 'apis_admin' THEN 1 WHEN 'centre_manager' THEN 2
                 WHEN 'centre_staff' THEN 3 WHEN 'equipment_owner' THEN 4 ELSE 5 END, u.created_at DESC
        LIMIT 500`,
      vals
    );
    return rows.map((r) => ({ ...r, can_manage: canManageRole(req.user, r.role, r.centre_id) && Number(r.id) !== req.user.id }));
  });

  async function checkCentre(role, centreId) {
    if (CENTRE_ROLES.includes(role)) {
      if (!centreId) throw httpError(400, 'Centre staff and managers must be assigned to a centre.');
      const { rows } = await db.query('SELECT 1 FROM centre WHERE id = $1', [centreId]);
      if (!rows[0]) throw httpError(400, 'That centre does not exist.');
      return centreId;
    }
    return null; // other roles never belong to a centre
  }

  app.post('/admin/users', {
    preValidation: peopleManagers,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['email', 'name', 'role'],
        properties: {
          email: s(254, 3), name: s(80, 2), role: { enum: ROLES },
          centre_id: { type: ['integer', 'null'] }, phone: { type: ['string', 'null'], maxLength: 20 },
        },
      },
    },
  }, async (req, reply) => {
    const b = req.body;
    const email = cleanEmail(b.email);
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address.');
    const centreId = req.user.role === 'centre_manager' ? req.user.centre_id : (b.centre_id || null);
    if (!canManageRole(req.user, b.role, centreId)) throw httpError(403, 'You cannot create that kind of account.');
    const finalCentre = await checkCentre(b.role, centreId);
    const temp = tempPassword();
    let row;
    try {
      const r = await db.query(
        `INSERT INTO app_user (email, name, phone, role, centre_id, password_hash, must_change_password,
                               email_verified_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,now(),$7)
         RETURNING id, email, name, role, centre_id`,
        [email, b.name.trim(), b.phone ? b.phone.trim() : null, b.role, finalCentre, await hashPassword(temp), req.user.id]
      );
      row = r.rows[0];
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'An account with this email or phone already exists.');
      throw e;
    }
    await audit(req, 'user.create', 'app_user', row.id, { role: b.role, centre_id: finalCentre, email });
    return reply.code(201).send({ user: row, temp_password: temp });
  });

  async function loadTarget(req) {
    const id = int(req.params.id);
    const { rows } = await db.query(
      'SELECT id, email, role, centre_id, is_active FROM app_user WHERE id = $1', [id]
    );
    const t = rows[0];
    if (!t || t.email.endsWith('@system.invalid')) throw httpError(404, 'Account not found.');
    t.id = Number(t.id);
    t.centre_id = t.centre_id == null ? null : Number(t.centre_id);
    if (t.id === req.user.id) throw httpError(403, 'Use "My account" to change your own details.');
    if (!canManageRole(req.user, t.role, t.centre_id)) throw httpError(403, 'You cannot manage this account.');
    return t;
  }

  async function assertNotLastSuperAdmin(t, newRole, newActive) {
    if (t.role !== 'super_admin') return;
    if (newRole === 'super_admin' && newActive !== false) return;
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM app_user WHERE role = 'super_admin' AND is_active AND id <> $1`, [t.id]
    );
    if (rows[0].n === 0) throw httpError(409, 'There must always be at least one active super admin.');
  }

  app.patch('/admin/users/:id', {
    preValidation: peopleManagers,
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          name: s(80, 2), role: { enum: ROLES }, centre_id: { type: ['integer', 'null'] },
          is_active: { type: 'boolean' }, phone: { type: ['string', 'null'], maxLength: 20 },
        },
      },
    },
  }, async (req) => {
    const t = await loadTarget(req);
    const b = req.body;
    const role = b.role || t.role;
    let centre = b.centre_id !== undefined ? b.centre_id : t.centre_id;
    if (req.user.role === 'centre_manager') centre = req.user.centre_id;
    if (!canManageRole(req.user, role, centre)) throw httpError(403, 'You cannot give that role.');
    centre = await checkCentre(role, centre);
    const active = b.is_active !== undefined ? b.is_active : t.is_active;
    await assertNotLastSuperAdmin(t, role, active);

    const securityChange = role !== t.role || centre !== t.centre_id || active !== t.is_active;
    try {
      await db.query(
        `UPDATE app_user SET name = COALESCE($2, name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
                role = $5, centre_id = $6, is_active = $7,
                token_version = token_version + CASE WHEN $8::boolean THEN 1 ELSE 0 END
          WHERE id = $1`,
        [t.id, b.name ? b.name.trim() : null, b.phone !== undefined, b.phone ? b.phone.trim() : null,
         role, centre, active, securityChange]
      );
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'That phone number is used by another account.');
      throw e;
    }
    await audit(req, 'user.update', 'app_user', t.id, { from: { role: t.role, centre_id: t.centre_id, active: t.is_active }, to: { role, centre_id: centre, active } });
    return { ok: true };
  });

  app.post('/admin/users/:id/reset-password', { preValidation: peopleManagers }, async (req) => {
    const t = await loadTarget(req);
    const temp = tempPassword();
    await db.query(
      `UPDATE app_user SET password_hash = $2, must_change_password = TRUE, failed_logins = 0,
              locked_until = NULL, token_version = token_version + 1 WHERE id = $1`,
      [t.id, await hashPassword(temp)]
    );
    await audit(req, 'user.reset_password', 'app_user', t.id);
    return { temp_password: temp };
  });

  // ------------------------------------------------------------------ centres
  app.get('/admin/centres', { preValidation: peopleManagers }, async (req) => {
    const own = req.user.role === 'centre_manager';
    const { rows } = await db.query(
      `SELECT c.*, s.name AS state_name, o.email AS owner_email, o.name AS owner_name,
              (SELECT count(*)::int FROM machine m WHERE m.centre_id = c.id) AS machines
         FROM centre c LEFT JOIN state s ON s.code = c.state_code LEFT JOIN app_user o ON o.id = c.owner_user_id
        ${own ? 'WHERE c.id = $1' : ''}
        ORDER BY (c.verification = 'pending') DESC, c.state_code NULLS LAST, c.name`,
      own ? [req.user.centre_id] : []
    );
    return rows;
  });

  app.post('/admin/centres', {
    preValidation: admins,
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['name', 'district', 'address', 'lat', 'lng'], properties: CENTRE_FIELDS,
      },
    },
  }, async (req, reply) => {
    const b = { owner_type: 'government', ...req.body };
    const cols = Object.keys(CENTRE_FIELDS).filter((k) => b[k] !== undefined);
    const { rows } = await db.query(
      `INSERT INTO centre (${cols.join(', ')}, verification) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, 'verified')
       RETURNING id`,
      cols.map((c) => b[c])
    );
    await audit(req, 'centre.create', 'centre', rows[0].id, { name: b.name });
    return reply.code(201).send({ id: Number(rows[0].id) });
  });

  app.patch('/admin/centres/:id', {
    preValidation: admins,
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: CENTRE_FIELDS } },
  }, async (req) => {
    const id = int(req.params.id);
    const { sql, values, cols } = setClause(req.body, CENTRE_FIELDS);
    const { rowCount } = await db.query(`UPDATE centre SET ${sql} WHERE id = $1`, [id, ...values]);
    if (!rowCount) throw httpError(404, 'Centre not found.');
    await audit(req, 'centre.update', 'centre', id, { fields: cols });
    return { ok: true };
  });

  // Approve, reject or suspend a private listing; admins set the fee.
  app.post('/admin/centres/:id/verification', {
    preValidation: admins,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['verification'],
        properties: {
          verification: { enum: ['verified', 'changes_requested', 'rejected', 'suspended', 'pending'] },
          platform_fee_pct: pct,
          note: { type: 'string', maxLength: 1000 },
        },
      },
    },
  }, async (req) => {
    const id = int(req.params.id);
    const note = (req.body.note || '').trim();
    if (['changes_requested', 'rejected'].includes(req.body.verification) && note.length < 5) {
      throw httpError(400, 'Write a short note telling the owner what to change or why it was rejected.');
    }
    const { rowCount } = await db.query(
      `UPDATE centre SET verification = $2, platform_fee_pct = COALESCE($3, platform_fee_pct),
              review_note = $4, reviewed_at = now(), reviewed_by = $5
        WHERE id = $1 AND owner_type <> 'government' AND verification <> 'draft'`,
      [id, req.body.verification, req.body.platform_fee_pct ?? null, note || null, req.user.id]
    );
    if (!rowCount) throw httpError(404, 'Listing not found, or the owner has not submitted it yet.');
    await audit(req, 'centre.verification', 'centre', id, req.body);
    return { ok: true };
  });

  // ------------------------------------------------------------------ machines
  app.get('/admin/machines', {
    preValidation: admins,
    schema: { querystring: { type: 'object', properties: { centre_id: { type: 'integer' } } } },
  }, async (req) => {
    const { rows } = await db.query(
      `SELECT m.*, c.name AS centre_name, p.label AS process_label,
              cap.max_x_mm, cap.max_y_mm, cap.max_z_mm, cap.tolerance_mm, cap.min_feature_mm, cap.layer_min_mm, cap.surface_finish,
              COALESCE((SELECT json_agg(json_build_object('code', mm.material_code, 'cost_per_gram', mm.cost_per_gram,
                        'in_stock_g', mm.in_stock_g, 'reorder_at_g', mm.reorder_at_g) ORDER BY mm.material_code)
                        FROM machine_material mm WHERE mm.machine_id = m.id), '[]') AS materials
         FROM machine m JOIN centre c ON c.id = m.centre_id JOIN process p ON p.code = m.process_code
         LEFT JOIN machine_capability cap ON cap.machine_id = m.id
        ${req.query.centre_id ? 'WHERE m.centre_id = $1' : ''}
        ORDER BY c.name, m.id LIMIT 1000`,
      req.query.centre_id ? [req.query.centre_id] : []
    );
    return rows;
  });

  app.post('/admin/machines', {
    preValidation: admins,
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['centre_id', 'process_code', 'make', 'model', 'rate_per_hour', 'max_x_mm', 'max_y_mm', 'max_z_mm'],
        properties: { centre_id: { type: 'integer' }, ...MACHINE_FIELDS, ...CAP_FIELDS },
      },
    },
  }, async (req, reply) => {
    const b = req.body;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const mcols = ['centre_id', ...Object.keys(MACHINE_FIELDS).filter((k) => b[k] !== undefined)];
      const m = await client.query(
        `INSERT INTO machine (${mcols.join(', ')}) VALUES (${mcols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        mcols.map((c) => b[c])
      );
      const id = m.rows[0].id;
      const ccols = Object.keys(CAP_FIELDS).filter((k) => b[k] !== undefined);
      await client.query(
        `INSERT INTO machine_capability (machine_id, ${ccols.join(', ')}) VALUES ($1, ${ccols.map((_, i) => `$${i + 2}`).join(', ')})`,
        [id, ...ccols.map((c) => b[c])]
      );
      await client.query('COMMIT');
      await audit(req, 'machine.create', 'machine', id, { centre_id: b.centre_id, make: b.make, model: b.model });
      return reply.code(201).send({ id: Number(id) });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });

  app.patch('/admin/machines/:id', {
    preValidation: admins,
    schema: {
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { ...MACHINE_FIELDS, ...CAP_FIELDS } },
    },
  }, async (req) => {
    const id = int(req.params.id);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const mset = setClause(req.body, MACHINE_FIELDS);
      if (mset.cols.length) {
        const r = await client.query(`UPDATE machine SET ${mset.sql} WHERE id = $1`, [id, ...mset.values]);
        if (!r.rowCount) throw httpError(404, 'Machine not found.');
      }
      const cset = setClause(req.body, CAP_FIELDS);
      if (cset.cols.length) {
        const r = await client.query(`UPDATE machine_capability SET ${cset.sql} WHERE machine_id = $1`, [id, ...cset.values]);
        if (!r.rowCount) throw httpError(404, 'Machine not found.');
      }
      await client.query('COMMIT');
      await audit(req, 'machine.update', 'machine', id, { fields: [...mset.cols, ...cset.cols] });
      return { ok: true };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });

  // Add or update a material a machine can use. Stock changes go through
  // the restock ledger, not here.
  app.put('/admin/machines/:id/materials/:code', {
    preValidation: admins,
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        properties: { cost_per_gram: { type: 'number', minimum: 0, maximum: 100000 }, reorder_at_g: { type: 'number', minimum: 0, maximum: 1000000 } },
      },
    },
  }, async (req) => {
    const id = int(req.params.id);
    await db.query(
      `INSERT INTO machine_material (machine_id, material_code, cost_per_gram, reorder_at_g)
       VALUES ($1,$2,$3,COALESCE($4,0))
       ON CONFLICT (machine_id, material_code) DO UPDATE
         SET cost_per_gram = COALESCE(EXCLUDED.cost_per_gram, machine_material.cost_per_gram),
             reorder_at_g = COALESCE($4, machine_material.reorder_at_g)`,
      [id, req.params.code, req.body.cost_per_gram ?? null, req.body.reorder_at_g ?? null]
    );
    await audit(req, 'machine.material', 'machine', id, { code: req.params.code, ...req.body });
    return { ok: true };
  });

  // ------------------------------------------------------------------ audit log
  app.get('/admin/audit', {
    preValidation: superOnly,
    schema: {
      querystring: {
        type: 'object',
        properties: { action: s(60), actor_id: { type: 'integer' }, failed: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 500 } },
      },
    },
  }, async (req) => {
    const q = req.query;
    const where = ['TRUE'];
    const vals = [];
    if (q.action) { vals.push(q.action + '%'); where.push(`a.action LIKE $${vals.length}`); }
    if (q.actor_id) { vals.push(q.actor_id); where.push(`a.actor_id = $${vals.length}`); }
    if (q.failed) where.push('NOT a.ok');
    vals.push(q.limit || 200);
    const { rows } = await db.query(
      `SELECT a.id, a.at, a.action, a.object_type, a.object_id, a.detail, host(a.ip) AS ip, a.ok, a.error,
              a.actor_role, u.email AS actor_email
         FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_id
        WHERE ${where.join(' AND ')} ORDER BY a.at DESC LIMIT $${vals.length}`,
      vals
    );
    return rows;
  });
};
