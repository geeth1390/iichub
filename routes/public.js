'use strict';
// Browsing: machine search, profiles, free slots, national dashboards.
const { num, int, httpError } = require('../lib/util');
const { isAdmin, canStaffCentre } = require('../lib/auth');

const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

module.exports = async function publicRoutes(app, { db, auth }) {
  const pos = (max) => ({ type: 'number', exclusiveMinimum: 0, maximum: max });

  app.get('/machines', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          x: pos(100000), y: pos(100000), z: pos(100000),
          mat: { type: 'string', maxLength: 40 }, tol: pos(100),
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
          qty: { type: 'integer', minimum: 1, maximum: 100000 },
          proc: { type: 'string', maxLength: 30 },
        },
      },
    },
  }, async (req) => {
    const q = req.query;
    const { rows } = await db.query(
      `SELECT r.machine_id::int AS machine_id, r.centre_name, r.district, r.machine, r.process_label, r.distance_km, r.status,
              r.rate_per_hour, r.material_ok, r.in_stock_g, r.fit_score, r.reason,
              m.process_code, c.owner_type, cap.tolerance_mm,
              cap.max_x_mm, cap.max_y_mm, cap.max_z_mm,
              (SELECT p.id::int FROM machine_photo p WHERE p.machine_id = r.machine_id AND p.data IS NOT NULL
                ORDER BY (p.kind = 'machine') DESC, p.sort, p.id LIMIT 1) AS photo_id
         FROM match_machines($1,$2,$3,$4,$5,NULL,$6,$7,$8) WITH ORDINALITY r
         JOIN machine m ON m.id = r.machine_id
         JOIN centre c ON c.id = m.centre_id
         LEFT JOIN machine_capability cap ON cap.machine_id = m.id
        WHERE ($9::text IS NULL OR m.process_code = $9)
        ORDER BY r.ordinality
        LIMIT 200`,
      [num(q.x), num(q.y), num(q.z), q.mat || null, num(q.tol), num(q.lat), num(q.lng), int(q.qty) || 1, q.proc || null]
    );
    return rows;
  });

  // Which of the next 7 days still have a free 1-hour slot, per machine.
  app.get('/machines/free-days', {
    schema: { querystring: { type: 'object', required: ['ids'], properties: { ids: { type: 'string', pattern: '^[0-9]+(,[0-9]+){0,29}$' } } } },
  }, async (req) => {
    const ids = [...new Set(req.query.ids.split(',').map(Number))];
    const { rows } = await db.query(
      `SELECT x.id AS machine_id,
              array_agg(DISTINCT to_char(f.slot_start AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')) AS days
         FROM unnest($1::bigint[]) x(id)
         JOIN machine m ON m.id = x.id AND m.status NOT IN ('retired','broken','offline')
         JOIN centre c ON c.id = m.centre_id AND c.is_live AND (c.owner_type = 'government' OR c.verification = 'verified')
         CROSS JOIN LATERAL free_slots(x.id, $2::date, 7, 60) f
        WHERE f.slot_start > now()
        GROUP BY x.id`,
      [ids, todayIST()]
    );
    return { from: todayIST(), days: Object.fromEntries(rows.map((r) => [r.machine_id, r.days])) };
  });

  // Listed centres nearest to a point.
  app.get('/centres/near', {
    schema: {
      querystring: {
        type: 'object', required: ['lat', 'lng'],
        properties: {
          lat: { type: 'number', minimum: -90, maximum: 90 }, lng: { type: 'number', minimum: -180, maximum: 180 },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
      },
    },
  }, async (req) => {
    const { rows } = await db.query(
      `SELECT c.id::int AS id, c.name, c.district, c.owner_type,
              ROUND((6371 * acos(LEAST(1, cos(radians($1)) * cos(radians(c.lat)) * cos(radians(c.lng) - radians($2))
                + sin(radians($1)) * sin(radians(c.lat)))))::numeric, 1) AS distance_km,
              (SELECT string_agg(DISTINCT p.layman_label, ', ') FROM machine m JOIN process p ON p.code = m.process_code
                WHERE m.centre_id = c.id AND m.status <> 'retired') AS processes,
              (SELECT count(*)::int FROM machine m WHERE m.centre_id = c.id AND m.status <> 'retired') AS machines
         FROM centre c
        WHERE c.is_live AND (c.owner_type = 'government' OR c.verification = 'verified')
        ORDER BY distance_km
        LIMIT $3`,
      [req.query.lat, req.query.lng, req.query.limit || 5]
    );
    return rows;
  });

  // Is this machine visible to the public (live centre, government or verified)?
  async function machineCentre(id) {
    const { rows } = await db.query(
      `SELECT m.centre_id, c.owner_type, c.owner_user_id,
              (c.is_live AND (c.owner_type = 'government' OR c.verification = 'verified')) AS listed
         FROM machine m JOIN centre c ON c.id = m.centre_id WHERE m.id = $1`,
      [id]
    );
    return rows[0] || null;
  }

  app.get('/machines/:id/profile', async (req) => {
    const id = int(req.params.id);
    const mc = id && (await machineCentre(id));
    const user = await auth.optionalUser(req);
    if (!mc || (!mc.listed && !(user && (isAdmin(user) || canStaffCentre(user, mc.centre_id))))) {
      throw httpError(404, 'Machine not found.');
    }
    const { rows } = await db.query('SELECT * FROM v_machine_profile WHERE machine_id = $1', [id]);
    const p = rows[0];
    const [extra, photos] = await Promise.all([
      db.query(
        `SELECT g.prep_notes, c.phone AS centre_phone, c.pincode, c.verification,
                (SELECT json_build_object('filename', d.filename, 'size', d.size_bytes) FROM machine_doc d WHERE d.machine_id = $1) AS sop,
                (SELECT COALESCE(json_agg(json_build_object('code', mt.code, 'label', mt.label) ORDER BY mt.label), '[]')
                   FROM machine_material mm JOIN material mt ON mt.code = mm.material_code WHERE mm.machine_id = $1) AS materials,
                c.id AS centre_id
           FROM machine m JOIN centre c ON c.id = m.centre_id LEFT JOIN machine_guide g ON g.machine_id = m.id
          WHERE m.id = $1`, [id]),
      db.query(
        `SELECT id, kind, caption FROM machine_photo WHERE machine_id = $1 AND data IS NOT NULL
          ORDER BY (kind = 'machine') DESC, sort, id`, [id]),
    ]);
    Object.assign(p, extra.rows[0], { owner_type: mc.owner_type, photos: photos.rows });

    // Private labs: the exact address and phone numbers are shared only with
    // people who have a booking there (and the owner, staff, admins).
    let trusted = user && (isAdmin(user) || canStaffCentre(user, mc.centre_id) || Number(mc.owner_user_id) === user.id);
    if (!trusted && user && mc.owner_type === 'private') {
      const { rows: b } = await db.query(
        `SELECT 1 FROM booking b JOIN machine m ON m.id = b.machine_id
          WHERE m.centre_id = $1 AND b.user_id = $2 AND b.status IN ('confirmed','completed') LIMIT 1`,
        [mc.centre_id, user.id]
      );
      trusted = Boolean(b[0]);
    }
    if (mc.owner_type === 'private' && !trusted) {
      delete p.address; delete p.pincode; delete p.centre_phone; delete p.operator_phone;
      p.lat = Math.round(Number(p.lat) * 50) / 50; // about 2 km
      p.lng = Math.round(Number(p.lng) * 50) / 50;
      p.address_hidden = true;
    } else if (!user) {
      delete p.operator_phone; // staff contact numbers only for signed-in users
    }
    return p;
  });

  app.get('/machines/:id/slots', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          from: { type: 'string', format: 'date' },
          days: { type: 'integer', minimum: 1, maximum: 31 },
          mins: { type: 'integer', minimum: 15, maximum: 720 },
        },
      },
    },
  }, async (req) => {
    const id = int(req.params.id);
    const mc = id && (await machineCentre(id));
    if (!mc || !mc.listed) throw httpError(404, 'Machine not found.');
    const today = todayIST();
    const from = req.query.from && req.query.from > today ? req.query.from : today;
    const { rows } = await db.query('SELECT * FROM free_slots($1,$2,$3,$4)',
      [id, from, req.query.days || 7, req.query.mins || 60]);
    return rows;
  });

  app.get('/national', async () => (await db.query('SELECT * FROM v_national')).rows[0]);
  app.get('/states', async () => (await db.query('SELECT * FROM v_state_utilisation')).rows);
  app.get('/zones/:state', async (req) =>
    (await db.query('SELECT * FROM v_zone_utilisation WHERE state_code = $1', [String(req.params.state).slice(0, 4)])).rows);

  // Lists used by forms (processes, materials, states).
  app.get('/meta', async () => {
    const [p, m, s, t] = await Promise.all([
      db.query('SELECT code, family, label, layman_label FROM process ORDER BY label'),
      db.query('SELECT code, label, class FROM material ORDER BY label'),
      db.query('SELECT code, name FROM state ORDER BY name'),
      db.query(`SELECT count(DISTINCT m.id)::int AS machines, count(DISTINCT c.id)::int AS centres,
                       count(DISTINCT c.state_code)::int AS states
                  FROM centre c JOIN machine m ON m.centre_id = c.id AND m.status <> 'retired'
                 WHERE c.is_live AND (c.owner_type = 'government' OR c.verification = 'verified')`),
    ]);
    return { processes: p.rows, materials: m.rows, states: s.rows, totals: t.rows[0] };
  });

  app.get('/health', { config: { rateLimit: false } }, async (req, reply) => {
    try {
      await db.query('SELECT 1');
      return { ok: true, db: 'up' };
    } catch {
      return reply.code(503).send({ ok: false, db: 'down' });
    }
  });
};
