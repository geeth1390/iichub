'use strict';
// Manager console: queue, pricing, job progress, stock, maintenance.
// Every route checks the caller works at that centre (admins: any centre).
const { num, int, httpError } = require('../lib/util');
const { STAFF, canStaffCentre } = require('../lib/auth');

module.exports = async function staffRoutes(app, { db, auth, audit }) {
  const staff = auth.guard(STAFF);

  async function centreOfMachine(id) {
    const { rows } = await db.query('SELECT centre_id FROM machine WHERE id = $1', [id]);
    if (!rows[0]) throw httpError(404, 'Machine not found.');
    return Number(rows[0].centre_id);
  }
  async function centreOfJob(id) {
    const { rows } = await db.query('SELECT m.centre_id FROM job j JOIN machine m ON m.id = j.machine_id WHERE j.id = $1', [id]);
    if (!rows[0]) throw httpError(404, 'Job not found.');
    return Number(rows[0].centre_id);
  }
  function mustStaff(user, centreId) {
    if (!canStaffCentre(user, centreId)) throw httpError(403, 'You can only manage your own centre.');
  }

  app.get('/queue/:centreId', { preValidation: staff }, async (req) => {
    const c = int(req.params.centreId);
    mustStaff(req.user, c);
    return (await db.query('SELECT * FROM v_manager_queue WHERE centre_id = $1', [c])).rows;
  });

  app.get('/centre/:centreId/resources', { preValidation: staff }, async (req) => {
    const c = int(req.params.centreId);
    mustStaff(req.user, c);
    const { rows } = await db.query(
      `SELECT m.id AS machine_id, m.make || ' ' || m.model AS machine_name, m.status AS machine_status,
              mm.material_code, mm.in_stock_g, mm.reorder_at_g, mm.cost_per_gram
         FROM machine m LEFT JOIN machine_material mm ON mm.machine_id = m.id
        WHERE m.centre_id = $1 ORDER BY m.id, mm.material_code`,
      [c]
    );
    return rows;
  });

  app.get('/centre/:centreId/today', { preValidation: staff }, async (req) => {
    const c = int(req.params.centreId);
    mustStaff(req.user, c);
    const { rows } = await db.query('SELECT * FROM v_centre_today WHERE centre_id = $1', [c]);
    const { rows: col } = await db.query(
      `SELECT count(*)::int AS n FROM job j JOIN machine m ON m.id = j.machine_id
        WHERE m.centre_id = $1 AND j.status = 'collected'`, [c]
    );
    const { rows: name } = await db.query('SELECT name FROM centre WHERE id = $1', [c]);
    return { centre_name: name[0] && name[0].name, ...(rows[0] || {}), collected_jobs: col[0].n };
  });

  app.post('/jobs/:id/quote', {
    preValidation: staff,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['minutes'],
        properties: {
          minutes: { type: 'integer', minimum: 0, maximum: 525600 },
          grams: { type: ['number', 'null'], minimum: 0, maximum: 1000000 },
          note: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (req) => {
    const id = int(req.params.id);
    mustStaff(req.user, await centreOfJob(id));
    const { minutes, grams, note } = req.body;
    const { rows } = await db.query('SELECT issue_quote($1,$2,$3,$4,$5) AS total',
      [id, req.user.id, minutes, num(grams), note || null]);
    await audit(req, 'job.quote', 'job', id, { total: rows[0].total });
    return { total: rows[0].total };
  });

  app.post('/jobs/:id/advance', {
    preValidation: staff,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['to'],
        properties: {
          to: { enum: ['queued', 'setup', 'running', 'qc', 'ready', 'collected', 'failed', 'cancelled'] },
          note: { type: 'string', maxLength: 500 },
          grams: { type: ['number', 'null'], minimum: 0, maximum: 1000000 },
        },
      },
    },
  }, async (req) => {
    const id = int(req.params.id);
    mustStaff(req.user, await centreOfJob(id));
    const { to, note, grams } = req.body;
    const { rows } = await db.query('SELECT advance_job($1,$2,$3,$4,$5) AS status',
      [id, to, req.user.id, note || null, num(grams)]);
    if (to === 'collected') {
      await db.query('SELECT accrue_earning($1)', [id]).catch((e) => req.log.warn({ err: e }, 'accrue_earning'));
    }
    if (to === 'cancelled' || to === 'collected' || to === 'failed') {
      await db.query(
        `UPDATE booking SET status = CASE WHEN $2 = 'collected' THEN 'completed' ELSE 'cancelled' END
          WHERE id = (SELECT booking_id FROM job WHERE id = $1) AND status IN ('requested','confirmed')`,
        [id, to]
      );
    }
    return { status: rows[0].status };
  });

  app.post('/machines/:id/restock', {
    preValidation: staff,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['material', 'grams'],
        properties: {
          material: { type: 'string', maxLength: 40 },
          grams: { type: 'number', exclusiveMinimum: 0, maximum: 1000000 },
          note: { type: 'string', maxLength: 300 },
        },
      },
    },
  }, async (req) => {
    const id = int(req.params.id);
    mustStaff(req.user, await centreOfMachine(id));
    const { rows } = await db.query(
      'SELECT 1 FROM machine_material WHERE machine_id = $1 AND material_code = $2', [id, req.body.material]
    );
    if (!rows[0]) throw httpError(400, 'This machine does not stock that material.');
    await db.query(
      `INSERT INTO stock_movement (machine_id, material_code, delta_g, reason, actor_id, note)
       VALUES ($1,$2,$3,'restock',$4,$5)`,
      [id, req.body.material, req.body.grams, req.user.id, req.body.note || null]
    );
    await audit(req, 'stock.restock', 'machine', id, { material: req.body.material, grams: req.body.grams });
    return { ok: true };
  });

  app.get('/machines/:id/maintenance', { preValidation: staff }, async (req) => {
    const id = int(req.params.id);
    mustStaff(req.user, await centreOfMachine(id));
    return (await db.query(
      'SELECT * FROM maintenance_window WHERE machine_id = $1 ORDER BY started_at DESC LIMIT 100', [id]
    )).rows;
  });

  app.post('/machines/:id/maintenance', {
    preValidation: staff,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['reason'],
        properties: {
          reason: { type: 'string', minLength: 3, maxLength: 300 },
          kind: { enum: ['repair', 'service', 'calibration', 'upgrade', 'cleaning'] },
          expected_back: { type: ['string', 'null'], format: 'date-time' },
        },
      },
    },
  }, async (req, reply) => {
    const id = int(req.params.id);
    mustStaff(req.user, await centreOfMachine(id));
    const { rows } = await db.query(
      `INSERT INTO maintenance_window (machine_id, reason, kind, expected_back, logged_by)
       VALUES ($1,$2,COALESCE($3,'repair'),$4,$5) RETURNING *`,
      [id, req.body.reason.trim(), req.body.kind || null, req.body.expected_back || null, req.user.id]
    );
    await audit(req, 'machine.maintenance_start', 'machine', id, { reason: req.body.reason });
    return reply.code(201).send(rows[0]);
  });

  app.post('/maintenance/:id/resolve', { preValidation: staff }, async (req) => {
    const id = int(req.params.id);
    const { rows: mw } = await db.query('SELECT machine_id FROM maintenance_window WHERE id = $1', [id]);
    if (!mw[0]) throw httpError(404, 'Maintenance record not found.');
    mustStaff(req.user, await centreOfMachine(mw[0].machine_id));
    // the trigger on maintenance_window puts the machine back to available
    const { rows } = await db.query(
      `UPDATE maintenance_window SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL RETURNING *`, [id]
    );
    if (!rows[0]) throw httpError(409, 'This maintenance is already resolved.');
    await audit(req, 'machine.maintenance_resolve', 'machine', mw[0].machine_id);
    return { message: 'maintenance resolved', maintenance: rows[0] };
  });
};
