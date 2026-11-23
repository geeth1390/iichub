'use strict';
// Browsing: machine search, profiles, free slots, national dashboards.
const { num, int, httpError } = require('../lib/util');
const { isAdmin, canStaffCentre } = require('../lib/auth');

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
        },
      },
    },
  }, async (req) => {
    const q = req.query;
    const { rows } = await db.query(
      'SELECT * FROM match_machines($1,$2,$3,$4,$5,NULL,$6,$7,$8) LIMIT 200',
      [num(q.x), num(q.y), num(q.z), q.mat || null, num(q.tol), num(q.lat), num(q.lng), int(q.qty) || 1]
    );
    return rows;
  });

  // Is this machine visible to the public (live centre, government or verified)?
  async function machineCentre(id) {
    const { rows } = await db.query(
      `SELECT m.centre_id, (c.is_live AND (c.owner_type = 'government' OR c.verification = 'verified')) AS listed
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
    if (!user) delete p.operator_phone; // staff contact numbers only for signed-in users
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
    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
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
    const [p, m, s] = await Promise.all([
      db.query('SELECT code, label, layman_label FROM process ORDER BY label'),
      db.query('SELECT code, label, class FROM material ORDER BY label'),
      db.query('SELECT code, name FROM state ORDER BY name'),
    ]);
    return { processes: p.rows, materials: m.rows, states: s.rows };
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
