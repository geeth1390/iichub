'use strict';
// Private equipment owners list machines; admins approve them before
// they appear in search.
const { num } = require('../lib/util');

module.exports = async function ownerRoutes(app, { db, auth, audit }) {
  const dim = { type: 'number', exclusiveMinimum: 0, maximum: 100000 };
  const s = (max, min = 1) => ({ type: 'string', minLength: min, maxLength: max });

  app.post('/owner/list-machine', {
    preValidation: auth.guard(['equipment_owner']),
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['centre_name', 'district', 'address', 'lat', 'lng', 'process', 'make', 'model', 'rate', 'max_x', 'max_y', 'max_z'],
        properties: {
          centre_name: s(120, 2), district: s(80), address: s(300, 5),
          lat: { type: 'number', minimum: 6, maximum: 38 },
          lng: { type: 'number', minimum: 68, maximum: 98 },
          process: s(30), make: s(60), model: s(60),
          rate: { type: 'number', minimum: 0, maximum: 1000000 },
          max_x: dim, max_y: dim, max_z: dim,
          material: s(40),
        },
      },
    },
  }, async (req) => {
    const b = req.body;
    const { rows } = await db.query(
      `SELECT list_private_machine($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) AS machine_id`,
      [req.user.id, b.centre_name.trim(), b.district.trim(), b.address.trim(), num(b.lat), num(b.lng),
       b.process, b.make.trim(), b.model.trim(), num(b.rate), num(b.max_x), num(b.max_y), num(b.max_z), b.material || 'pla']
    );
    await audit(req, 'owner.list_machine', 'machine', rows[0].machine_id);
    return { machine_id: Number(rows[0].machine_id), status: 'pending_verification' };
  });

  app.get('/owner/dashboard', { preValidation: auth.guard(['equipment_owner']) }, async (req) =>
    (await db.query('SELECT * FROM v_owner_dashboard WHERE owner_user_id = $1', [req.user.id])).rows);
};
