'use strict';
// Equipment listings by private owners: details, photos, operating
// procedure, submit for review. Also the media endpoints (photos, SOP PDF)
// with their visibility rules, and the admin review queue.
const { int, httpError } = require('../lib/util');
const { ADMINS, isAdmin, canStaffCentre } = require('../lib/auth');
const { processImage, processPdf, safeFilename, MAX_UPLOAD } = require('../lib/uploads');

const MAX_LISTINGS = 10;
const MAX_PHOTOS = 8;
const UPLOAD_LIMIT = MAX_UPLOAD + 64 * 1024;

const s = (max, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const time = { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' };
const dim = { type: 'number', exclusiveMinimum: 0, maximum: 100000 };
const money = { type: 'number', minimum: 0, maximum: 1000000 };

const CENTRE = {
  type: 'object', additionalProperties: false,
  properties: {
    name: s(120, 2), address: s(300, 5), district: s(80, 2),
    state_code: { type: ['string', 'null'], maxLength: 4 },
    pincode: { type: 'string', pattern: '^[1-9][0-9]{5}$' },
    lat: { type: 'number', minimum: 6, maximum: 38 }, lng: { type: 'number', minimum: 68, maximum: 98 },
    phone: { type: ['string', 'null'], maxLength: 20, pattern: '^[+0-9 -]*$' },
    opens_at: time, closes_at: time,
    working_days: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 7 } },
  },
};
const MACHINE = {
  type: 'object', additionalProperties: false,
  properties: {
    process_code: s(30, 1), make: s(60, 1), model: s(60, 1),
    rate_per_hour: money, setup_fee: money, min_charge: money,
    max_x_mm: dim, max_y_mm: dim, max_z_mm: dim,
    tolerance_mm: { type: ['number', 'null'], exclusiveMinimum: 0, maximum: 100 },
    materials: { type: 'array', maxItems: 12, uniqueItems: true, items: s(40, 1) },
  },
};
const GUIDE = {
  type: 'object', additionalProperties: false,
  properties: {
    how_to_use: s(2000), prep_notes: s(2000), safety_notes: s(2000),
    file_formats: { type: 'array', maxItems: 12, items: { type: 'string', pattern: '^[A-Za-z0-9]{1,8}$' } },
    requires_operator: { type: 'boolean' },
    typical_lead_hrs: { type: ['number', 'null'], minimum: 0, maximum: 2000 },
  },
};

const CENTRE_COLS = ['name', 'address', 'district', 'state_code', 'pincode', 'lat', 'lng', 'phone', 'opens_at', 'closes_at', 'working_days'];
const MACHINE_COLS = ['process_code', 'make', 'model', 'rate_per_hour', 'setup_fee', 'min_charge'];
const CAP_COLS = ['max_x_mm', 'max_y_mm', 'max_z_mm', 'tolerance_mm'];
const GUIDE_COLS = ['how_to_use', 'prep_notes', 'safety_notes', 'file_formats', 'requires_operator', 'typical_lead_hrs'];

const trimAll = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

module.exports = async function listingRoutes(app, { db, auth, audit }) {
  const owner = auth.guard(['equipment_owner']);

  // Raw uploads: the body is the file itself.
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
    app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: UPLOAD_LIMIT }, (req, body, done) => done(null, body));
  }

  // ---------- helpers ----------
  async function ownedCentre(client, userId, centreId, lock = false) {
    const { rows } = await client.query(
      `SELECT id, verification FROM centre WHERE id = $1 AND owner_user_id = $2 AND owner_type = 'private'${lock ? ' FOR UPDATE' : ''}`,
      [centreId, userId]
    );
    if (!rows[0]) throw httpError(404, 'Listing not found.');
    return rows[0];
  }
  async function ownedMachine(client, userId, machineId) {
    const { rows } = await client.query(
      `SELECT m.id, m.centre_id, c.verification FROM machine m JOIN centre c ON c.id = m.centre_id
        WHERE m.id = $1 AND c.owner_user_id = $2 AND c.owner_type = 'private'`,
      [machineId, userId]
    );
    if (!rows[0]) throw httpError(404, 'Machine not found.');
    return rows[0];
  }
  // A change to an approved listing sends it back for review.
  async function needsReview(client, centreId, verification) {
    if (verification === 'verified') {
      await client.query(`UPDATE centre SET verification = 'pending', submitted_at = now() WHERE id = $1`, [centreId]);
      return true;
    }
    if (verification === 'suspended') throw httpError(409, 'This listing is suspended. Please contact the IICHUB team.');
    return false;
  }
  async function tx(fn) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async function writeMachineParts(client, machineId, machine, guide) {
    const caps = CAP_COLS.filter((k) => machine && machine[k] !== undefined);
    if (caps.length) {
      await client.query(
        `INSERT INTO machine_capability (machine_id, ${caps.join(', ')}) VALUES ($1, ${caps.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (machine_id) DO UPDATE SET ${caps.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
        [machineId, ...caps.map((c) => machine[c])]
      );
    }
    if (machine && machine.materials) {
      await client.query('DELETE FROM machine_material WHERE machine_id = $1 AND NOT (material_code = ANY($2))', [machineId, machine.materials]);
      for (const code of machine.materials) {
        await client.query(
          `INSERT INTO machine_material (machine_id, material_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [machineId, code]
        );
      }
    }
    const g = GUIDE_COLS.filter((k) => guide && guide[k] !== undefined);
    if (g.length) {
      await client.query(
        `INSERT INTO machine_guide (machine_id, ${g.join(', ')}, updated_at) VALUES ($1, ${g.map((_, i) => `$${i + 2}`).join(', ')}, now())
         ON CONFLICT (machine_id) DO UPDATE SET ${g.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()`,
        [machineId, ...g.map((c) => (c === 'file_formats' ? guide[c].map((f) => f.toUpperCase()) : guide[c]))]
      );
    }
  }

  // ---------- owner: my listings ----------
  app.get('/owner/listings', { preValidation: owner }, async (req) => {
    const { rows } = await db.query(
      `SELECT c.id::int AS id, c.name, c.address, c.district, c.state_code, c.pincode, c.lat, c.lng, c.phone,
              c.opens_at, c.closes_at, c.working_days, c.verification, c.review_note, c.submitted_at, c.reviewed_at,
              c.platform_fee_pct,
              COALESCE(json_agg(json_build_object(
                'id', m.id, 'process_code', m.process_code, 'make', m.make, 'model', m.model,
                'rate_per_hour', m.rate_per_hour, 'setup_fee', m.setup_fee, 'min_charge', m.min_charge, 'status', m.status,
                'max_x_mm', cap.max_x_mm, 'max_y_mm', cap.max_y_mm, 'max_z_mm', cap.max_z_mm, 'tolerance_mm', cap.tolerance_mm,
                'materials', (SELECT COALESCE(json_agg(mm.material_code ORDER BY mm.material_code), '[]') FROM machine_material mm WHERE mm.machine_id = m.id),
                'guide', (SELECT row_to_json(g) FROM (SELECT how_to_use, prep_notes, safety_notes, file_formats, requires_operator, typical_lead_hrs FROM machine_guide WHERE machine_id = m.id) g),
                'photos', (SELECT COALESCE(json_agg(json_build_object('id', p.id, 'kind', p.kind, 'caption', p.caption) ORDER BY p.sort, p.id), '[]') FROM machine_photo p WHERE p.machine_id = m.id AND p.data IS NOT NULL),
                'sop', (SELECT json_build_object('filename', d.filename, 'size', d.size_bytes) FROM machine_doc d WHERE d.machine_id = m.id)
              ) ORDER BY m.id) FILTER (WHERE m.id IS NOT NULL), '[]') AS machines
         FROM centre c
         LEFT JOIN machine m ON m.centre_id = c.id
         LEFT JOIN machine_capability cap ON cap.machine_id = m.id
        WHERE c.owner_user_id = $1 AND c.owner_type = 'private'
        GROUP BY c.id ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    return rows;
  });

  app.post('/owner/listings', {
    preValidation: owner,
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['centre', 'machine'],
        properties: {
          centre: { ...CENTRE, required: ['name', 'address', 'district', 'pincode', 'lat', 'lng'] },
          machine: { ...MACHINE, required: ['process_code', 'make', 'model', 'rate_per_hour', 'max_x_mm', 'max_y_mm', 'max_z_mm'] },
          guide: GUIDE,
        },
      },
    },
  }, async (req, reply) => {
    const centre = trimAll(req.body.centre);
    const machine = trimAll(req.body.machine);
    const guide = trimAll(req.body.guide);
    const ids = await tx(async (client) => {
      await client.query('SELECT id FROM app_user WHERE id = $1 FOR UPDATE', [req.user.id]);
      const { rows: n } = await client.query(
        `SELECT count(*)::int AS n FROM centre WHERE owner_user_id = $1`, [req.user.id]
      );
      if (n[0].n >= MAX_LISTINGS) throw httpError(429, `You can have up to ${MAX_LISTINGS} listings. Contact the IICHUB team for more.`);
      const cc = CENTRE_COLS.filter((k) => centre[k] !== undefined);
      const c = await client.query(
        `INSERT INTO centre (${cc.join(', ')}, owner_type, owner_user_id, operator, verification, is_live, platform_fee_pct)
         VALUES (${cc.map((_, i) => `$${i + 1}`).join(', ')}, 'private', $${cc.length + 1}, 'Private', 'draft', TRUE, 15)
         RETURNING id`,
        [...cc.map((k) => centre[k]), req.user.id]
      );
      const mc = MACHINE_COLS.filter((k) => machine[k] !== undefined);
      const m = await client.query(
        `INSERT INTO machine (centre_id, ${mc.join(', ')}) VALUES ($1, ${mc.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
        [c.rows[0].id, ...mc.map((k) => machine[k])]
      );
      await writeMachineParts(client, m.rows[0].id, machine, guide);
      return { centre_id: Number(c.rows[0].id), machine_id: Number(m.rows[0].id) };
    });
    await audit(req, 'listing.create', 'centre', ids.centre_id, { machine_id: ids.machine_id });
    return reply.code(201).send({ ...ids, verification: 'draft' });
  });

  app.patch('/owner/listings/:id', {
    preValidation: owner,
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: { centre: CENTRE, machine_id: { type: 'integer' }, machine: MACHINE, guide: GUIDE },
      },
    },
  }, async (req) => {
    const centreId = int(req.params.id);
    const b = req.body;
    const centre = trimAll(b.centre);
    const machine = trimAll(b.machine);
    const guide = trimAll(b.guide);
    const result = await tx(async (client) => {
      const c = await ownedCentre(client, req.user.id, centreId, true);
      const back = await needsReview(client, centreId, c.verification);
      const cc = CENTRE_COLS.filter((k) => centre[k] !== undefined);
      if (cc.length) {
        await client.query(`UPDATE centre SET ${cc.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [centreId, ...cc.map((k) => centre[k])]);
      }
      if (b.machine || b.guide) {
        if (!b.machine_id) throw httpError(400, 'Say which machine to change.');
        const m = await ownedMachine(client, req.user.id, b.machine_id);
        if (Number(m.centre_id) !== centreId) throw httpError(404, 'Machine not found.');
        const mc = MACHINE_COLS.filter((k) => machine[k] !== undefined);
        if (mc.length) {
          await client.query(`UPDATE machine SET ${mc.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [m.id, ...mc.map((k) => machine[k])]);
        }
        await writeMachineParts(client, m.id, machine, guide);
      }
      return { back_to_review: back };
    });
    await audit(req, 'listing.update', 'centre', centreId, { fields: Object.keys(b) });
    return { ok: true, ...result };
  });

  app.post('/owner/listings/:id/submit', { preValidation: owner }, async (req) => {
    const centreId = int(req.params.id);
    await tx(async (client) => {
      const c = await ownedCentre(client, req.user.id, centreId, true);
      if (!['draft', 'changes_requested', 'rejected'].includes(c.verification)) {
        throw httpError(409, c.verification === 'pending' ? 'This listing is already waiting for review.' : 'This listing cannot be submitted right now.');
      }
      const { rows } = await client.query(
        `SELECT m.id,
                EXISTS (SELECT 1 FROM machine_photo p WHERE p.machine_id = m.id AND p.kind = 'machine' AND p.data IS NOT NULL) AS has_photo,
                COALESCE(length(trim(g.how_to_use)), 0) > 0 AS has_how,
                COALESCE(length(trim(g.safety_notes)), 0) > 0 AS has_safety,
                EXISTS (SELECT 1 FROM machine_material mm WHERE mm.machine_id = m.id) AS has_material
           FROM machine m LEFT JOIN machine_guide g ON g.machine_id = m.id WHERE m.centre_id = $1`,
        [centreId]
      );
      if (!rows.length) throw httpError(400, 'Add a machine before submitting.');
      const missing = [];
      for (const r of rows) {
        if (!r.has_photo) missing.push('at least one photo of the device');
        if (!r.has_how) missing.push('how a job runs');
        if (!r.has_safety) missing.push('safety rules');
        if (!r.has_material) missing.push('the materials you offer');
      }
      if (missing.length) throw httpError(400, `Before submitting, please add ${[...new Set(missing)].join(', ')}.`);
      await client.query(`UPDATE centre SET verification = 'pending', submitted_at = now() WHERE id = $1`, [centreId]);
    });
    await audit(req, 'listing.submit', 'centre', centreId);
    return { ok: true, verification: 'pending' };
  });

  // ---------- owner: photos and SOP ----------
  app.post('/owner/machines/:id/photos', {
    preValidation: owner,
    bodyLimit: UPLOAD_LIMIT,
    config: { rateLimit: { max: 40, timeWindow: '1 hour' } },
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { kind: { enum: ['machine', 'location', 'sample_output'] }, caption: s(120) },
      },
    },
  }, async (req, reply) => {
    const machineId = int(req.params.id);
    if (!Buffer.isBuffer(req.body)) throw httpError(415, 'Upload a JPG, PNG or WebP image.');
    const m = await ownedMachine(db, req.user.id, machineId);
    const img = await processImage(req.body);
    const id = await tx(async (client) => {
      await client.query('SELECT id FROM machine WHERE id = $1 FOR UPDATE', [machineId]); // one upload at a time per machine
      const { rows: n } = await client.query('SELECT count(*)::int AS n FROM machine_photo WHERE machine_id = $1', [machineId]);
      if (n[0].n >= MAX_PHOTOS) throw httpError(409, `A machine can have up to ${MAX_PHOTOS} photos. Remove one first.`);
      await needsReview(client, m.centre_id, m.verification);
      const r = await client.query(
        `INSERT INTO machine_photo (machine_id, kind, caption, sort, data, mime, size_bytes, width, height, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [machineId, req.query.kind || 'machine', req.query.caption ? req.query.caption.trim() : null, n[0].n,
         img.data, img.mime, img.size, img.width, img.height, req.user.id]
      );
      return Number(r.rows[0].id);
    });
    await audit(req, 'listing.photo_add', 'machine', machineId, { photo_id: id, kind: req.query.kind || 'machine' });
    return reply.code(201).send({ id, width: img.width, height: img.height });
  });

  app.delete('/owner/photos/:id', { preValidation: owner }, async (req) => {
    const id = int(req.params.id);
    const { rows } = await db.query(
      `SELECT p.machine_id, c.id AS centre_id, c.verification FROM machine_photo p
         JOIN machine m ON m.id = p.machine_id JOIN centre c ON c.id = m.centre_id
        WHERE p.id = $1 AND c.owner_user_id = $2 AND c.owner_type = 'private'`,
      [id, req.user.id]
    );
    if (!rows[0]) throw httpError(404, 'Photo not found.');
    await tx(async (client) => {
      await needsReview(client, rows[0].centre_id, rows[0].verification);
      await client.query('DELETE FROM machine_photo WHERE id = $1', [id]);
    });
    await audit(req, 'listing.photo_delete', 'machine', rows[0].machine_id, { photo_id: id });
    return { ok: true };
  });

  app.put('/owner/machines/:id/sop', {
    preValidation: owner,
    bodyLimit: UPLOAD_LIMIT,
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (req) => {
    const machineId = int(req.params.id);
    if (!Buffer.isBuffer(req.body)) throw httpError(415, 'Upload a PDF document.');
    const m = await ownedMachine(db, req.user.id, machineId);
    const pdf = processPdf(req.body);
    const filename = safeFilename(req.headers['x-filename'], 'operating-procedure.pdf');
    await tx(async (client) => {
      await needsReview(client, m.centre_id, m.verification);
      await client.query(
        `INSERT INTO machine_doc (machine_id, filename, mime, data, size_bytes, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (machine_id) DO UPDATE SET filename = EXCLUDED.filename, data = EXCLUDED.data,
           size_bytes = EXCLUDED.size_bytes, uploaded_by = EXCLUDED.uploaded_by, created_at = now()`,
        [machineId, filename, pdf.mime, pdf.data, pdf.size, req.user.id]
      );
    });
    await audit(req, 'listing.sop_upload', 'machine', machineId, { size: pdf.size });
    return { ok: true, filename, size: pdf.size };
  });

  app.delete('/owner/machines/:id/sop', { preValidation: owner }, async (req) => {
    const machineId = int(req.params.id);
    const m = await ownedMachine(db, req.user.id, machineId);
    await tx(async (client) => {
      await needsReview(client, m.centre_id, m.verification);
      await client.query('DELETE FROM machine_doc WHERE machine_id = $1', [machineId]);
    });
    return { ok: true };
  });

  // ---------- media: who may see a photo / document ----------
  // Public when the machine is listed; otherwise only its owner, admins and
  // that centre's staff (sent with the session token, fetched by script).
  async function mediaAccess(req, machineId) {
    const { rows } = await db.query(
      `SELECT c.id AS centre_id, c.owner_user_id,
              (c.is_live AND (c.owner_type = 'government' OR c.verification = 'verified')) AS listed
         FROM machine m JOIN centre c ON c.id = m.centre_id WHERE m.id = $1`,
      [machineId]
    );
    const r = rows[0];
    if (!r) return null;
    if (r.listed) return 'public';
    const user = await auth.optionalUser(req);
    if (user && (isAdmin(user) || Number(r.owner_user_id) === user.id || canStaffCentre(user, r.centre_id))) return 'private';
    return null;
  }

  app.get('/photos/:id', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = int(req.params.id);
    const { rows } = await db.query('SELECT machine_id, data, mime FROM machine_photo WHERE id = $1 AND data IS NOT NULL', [id]);
    const p = rows[0];
    const access = p && (await mediaAccess(req, p.machine_id));
    if (!access) throw httpError(404, 'Photo not found.');
    reply.header('Cache-Control', access === 'public' ? 'public, max-age=86400' : 'private, no-store');
    reply.header('Content-Disposition', 'inline');
    return reply.type(p.mime).send(p.data);
  });

  app.get('/machines/:id/sop', async (req, reply) => {
    const id = int(req.params.id);
    const { rows } = await db.query('SELECT filename, mime, data FROM machine_doc WHERE machine_id = $1', [id]);
    const d = rows[0];
    const access = d && (await mediaAccess(req, id));
    if (!access) throw httpError(404, 'Document not found.');
    reply.header('Cache-Control', access === 'public' ? 'public, max-age=3600' : 'private, no-store');
    reply.header('Content-Disposition', `attachment; filename="${safeFilename(d.filename, 'operating-procedure.pdf')}"`);
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    return reply.type('application/pdf').send(d.data);
  });

  // ---------- admin: review queue ----------
  app.get('/admin/listings', {
    preValidation: auth.guard(ADMINS),
    schema: { querystring: { type: 'object', properties: { status: { enum: ['open', 'all', 'pending', 'changes_requested', 'verified', 'rejected', 'suspended', 'draft'] } } } },
  }, async (req) => {
    const st = req.query.status || 'open';
    const filter = st === 'all' ? 'TRUE' : st === 'open' ? `c.verification = 'pending'` : 'c.verification = $1';
    const { rows } = await db.query(
      `SELECT c.id::int AS id, c.name, c.address, c.district, c.state_code, c.pincode, c.lat, c.lng, c.phone, c.opens_at, c.closes_at,
              c.working_days, c.verification, c.review_note, c.submitted_at, c.reviewed_at, c.platform_fee_pct,
              o.name AS owner_name, o.email AS owner_email, o.phone AS owner_phone,
              COALESCE(json_agg(json_build_object(
                'id', m.id, 'process', p.label, 'make', m.make, 'model', m.model, 'rate_per_hour', m.rate_per_hour,
                'size', cap.max_x_mm || ' × ' || cap.max_y_mm || ' × ' || cap.max_z_mm || ' mm', 'tolerance_mm', cap.tolerance_mm,
                'materials', (SELECT COALESCE(json_agg(mm.material_code ORDER BY mm.material_code), '[]') FROM machine_material mm WHERE mm.machine_id = m.id),
                'guide', (SELECT row_to_json(g) FROM (SELECT how_to_use, prep_notes, safety_notes, file_formats, requires_operator, typical_lead_hrs FROM machine_guide WHERE machine_id = m.id) g),
                'photos', (SELECT COALESCE(json_agg(json_build_object('id', ph.id, 'kind', ph.kind, 'caption', ph.caption) ORDER BY ph.sort, ph.id), '[]') FROM machine_photo ph WHERE ph.machine_id = m.id AND ph.data IS NOT NULL),
                'sop', (SELECT json_build_object('filename', d.filename, 'size', d.size_bytes) FROM machine_doc d WHERE d.machine_id = m.id)
              ) ORDER BY m.id) FILTER (WHERE m.id IS NOT NULL), '[]') AS machines
         FROM centre c
         LEFT JOIN app_user o ON o.id = c.owner_user_id
         LEFT JOIN machine m ON m.centre_id = c.id
         LEFT JOIN process p ON p.code = m.process_code
         LEFT JOIN machine_capability cap ON cap.machine_id = m.id
        WHERE c.owner_type = 'private' AND ${filter}
        GROUP BY c.id, o.id
        ORDER BY c.submitted_at NULLS LAST, c.id
        LIMIT 200`,
      ['open', 'all'].includes(st) ? [] : [st]
    );
    return rows;
  });
};
