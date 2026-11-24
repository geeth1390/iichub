'use strict';
// Booking and the innovator's own jobs.
const { int, httpError } = require('../lib/util');
const { mailEnabled } = require('../lib/mailer');

const OPEN_JOB_LIMIT = 10; // stops one account from holding every slot

module.exports = async function innovatorRoutes(app, { db, auth, audit }) {
  const bookers = auth.guard(['innovator', 'equipment_owner']);

  app.post('/bookings', {
    preValidation: bookers,
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['machine_id', 'slot_start', 'slot_end'],
        properties: {
          machine_id: { type: 'integer', minimum: 1 },
          slot_start: { type: 'string', format: 'date-time' },
          slot_end: { type: 'string', format: 'date-time' },
          title: { type: 'string', maxLength: 120 },
          material: { type: 'string', maxLength: 40 },
          qty: { type: 'integer', minimum: 1, maximum: 100000 },
        },
      },
    },
  }, async (req, reply) => {
    const b = req.body;
    if (mailEnabled() && !req.user.email_verified_at) {
      throw httpError(403, 'Please confirm your email address before booking. Check your inbox for the link.');
    }
    if (b.material) {
      const { rows } = await db.query(
        'SELECT 1 FROM machine_material WHERE machine_id = $1 AND material_code = $2', [b.machine_id, b.material]
      );
      if (!rows[0]) throw httpError(400, 'This machine does not offer that material.');
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Lock this user's row so parallel requests can't slip past the limit.
      await client.query('SELECT id FROM app_user WHERE id = $1 FOR UPDATE', [req.user.id]);
      const { rows: open } = await client.query(
        `SELECT count(*)::int AS n FROM job WHERE user_id = $1 AND status IN ('quote_pending','quote_sent','quote_accepted')`,
        [req.user.id]
      );
      if (open[0].n >= OPEN_JOB_LIMIT) {
        throw httpError(429, `You already have ${OPEN_JOB_LIMIT} bookings waiting. Finish or cancel some first.`);
      }
      const bk = await client.query(
        `INSERT INTO booking (machine_id, user_id, slot, status)
         VALUES ($1, $2, tstzrange($3::timestamptz, $4::timestamptz), 'confirmed') RETURNING id`,
        [b.machine_id, req.user.id, b.slot_start, b.slot_end]
      );
      const j = await client.query(
        `INSERT INTO job (booking_id, user_id, machine_id, material_code, title, quantity, status)
         VALUES ($1,$2,$3,$4,$5,$6,'quote_pending') RETURNING id`,
        [bk.rows[0].id, req.user.id, b.machine_id, b.material || null,
         (b.title || '').trim() || 'Untitled job', b.qty || 1]
      );
      await client.query('COMMIT');
      await audit(req, 'booking.create', 'job', j.rows[0].id, { machine_id: b.machine_id });
      return reply.code(201).send({ booking_id: Number(bk.rows[0].id), job_id: Number(j.rows[0].id), status: 'quote_pending' });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });

  app.get('/my/jobs', { preValidation: auth.guard() }, async (req) => {
    const { rows } = await db.query(
      `SELECT j.id, j.title, j.status, j.quantity, j.created_at,
              m.make || ' ' || m.model AS machine, c.name AS centre, c.address AS centre_address,
              c.district AS centre_district, c.phone AS centre_phone, m.id AS machine_id,
              lower(b.slot) AS slot_start, upper(b.slot) AS slot_end,
              (SELECT total FROM quote WHERE job_id = j.id ORDER BY version DESC LIMIT 1) AS quote
         FROM job j
         JOIN machine m ON m.id = j.machine_id
         JOIN centre c ON c.id = m.centre_id
         LEFT JOIN booking b ON b.id = j.booking_id
        WHERE j.user_id = $1
        ORDER BY j.created_at DESC LIMIT 200`,
      [req.user.id]
    );
    return rows;
  });

  // Accept a quote (owner of the job only, only while a quote is waiting).
  app.post('/jobs/:id/accept', { preValidation: bookers }, async (req) => {
    const id = int(req.params.id);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `UPDATE job SET status = 'quote_accepted'
          WHERE id = $1 AND user_id = $2 AND status = 'quote_sent' RETURNING id`,
        [id, req.user.id]
      );
      if (!r.rows[0]) throw httpError(409, 'This job has no quote waiting for you.');
      await client.query(
        `INSERT INTO job_event (job_id, from_status, to_status, note, actor_id)
         VALUES ($1,'quote_sent','quote_accepted','Quote accepted by innovator',$2)`,
        [id, req.user.id]
      );
      await client.query('COMMIT');
      return { ok: true, status: 'quote_accepted' };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });

  // Cancel before work starts; frees the slot.
  app.post('/jobs/:id/cancel', { preValidation: bookers }, async (req) => {
    const id = int(req.params.id);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `SELECT status, booking_id FROM job WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, req.user.id]
      );
      const j = r.rows[0];
      if (!j || !['quote_pending', 'quote_sent', 'quote_accepted'].includes(j.status)) {
        throw httpError(409, 'This job can no longer be cancelled online. Please contact the centre.');
      }
      await client.query(`UPDATE job SET status = 'cancelled' WHERE id = $1`, [id]);
      if (j.booking_id) await client.query(`UPDATE booking SET status = 'cancelled' WHERE id = $1`, [j.booking_id]);
      await client.query(
        `INSERT INTO job_event (job_id, from_status, to_status, note, actor_id)
         VALUES ($1,$2,'cancelled','Cancelled by innovator',$3)`,
        [id, j.status, req.user.id]
      );
      await client.query('COMMIT');
      return { ok: true, status: 'cancelled' };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });
};
