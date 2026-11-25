'use strict';
// Utilisation report: available vs booked vs executed machine hours.
//
//   available  = centre opening hours on working days (from commissioning date)
//                minus downtime (maintenance windows and blocked slots)
//   booked     = customer booking slots (requested, confirmed, completed, no-show)
//   executed   = time the machine was actually in SETUP or RUNNING, taken from
//                the job's timestamped status history (job_event)
//
// Everything is clipped to the chosen period and to "now", so a period that
// includes today only counts hours that have already passed.

const { int, httpError } = require('../lib/util');
const { ADMINS } = require('../lib/auth');

const H = (r) => `COALESCE(EXTRACT(EPOCH FROM (upper(${r}) - lower(${r}))) / 3600.0, 0)`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function period(q) {
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // IST date
  const to = q.to && DATE_RE.test(q.to) ? q.to : today;
  const d = new Date(to + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 29);
  const from = q.from && DATE_RE.test(q.from) ? q.from : d.toISOString().slice(0, 10);
  if (from > to) throw httpError(400, 'The start date must be on or before the end date.');
  const days = (new Date(to) - new Date(from)) / 864e5 + 1;
  if (days > 366) throw httpError(400, 'Choose a period of one year or less.');
  return { from, to };
}

const MACHINE_SQL = `
WITH p AS (
  SELECT $1::date AS d0, $2::date + 1 AS d1,
         tstzrange($1::date::timestamptz, LEAST(($2::date + 1)::timestamptz, now())) AS r
),
mach AS (
  SELECT m.id, m.centre_id, m.make || ' ' || m.model AS machine, m.process_code, pr.label AS process,
         m.rate_per_hour, m.status, c.name AS centre, c.district, c.state_code,
         c.opens_at, c.closes_at, c.working_days,
         GREATEST(p.d0, COALESCE(m.commissioned_on, p.d0)) AS start_d
    FROM machine m
    JOIN centre c ON c.id = m.centre_id
    JOIN process pr ON pr.code = m.process_code
    CROSS JOIN p
   WHERE m.status <> 'retired' AND c.is_live
     AND ($3::bigint IS NULL OR m.centre_id = $3)
),
open_iv AS (
  SELECT mc.id AS machine_id,
         tstzrange((g::date + mc.opens_at)::timestamptz, (g::date + mc.closes_at)::timestamptz) * p.r AS iv
    FROM mach mc CROSS JOIN p
    CROSS JOIN LATERAL generate_series(mc.start_d::timestamp, (p.d1 - 1)::timestamp, interval '1 day') g
   WHERE EXTRACT(ISODOW FROM g)::int = ANY (mc.working_days)
),
avail AS (SELECT machine_id, SUM(${H('iv')}) AS open_h FROM open_iv GROUP BY 1),
down AS (
  SELECT o.machine_id, SUM(${H('o.iv * w.rng')}) AS down_h
    FROM open_iv o
    JOIN (
      SELECT machine_id, tstzrange(started_at, COALESCE(resolved_at, now())) AS rng FROM maintenance_window
      UNION ALL
      SELECT machine_id, slot FROM booking WHERE is_block AND status IN ('requested','confirmed','completed')
    ) w ON w.machine_id = o.machine_id AND w.rng && o.iv
   GROUP BY 1
),
bk AS (
  SELECT b.machine_id,
         SUM(${H('b.slot * p.r')}) FILTER (WHERE b.status IN ('requested','confirmed','completed','no_show')) AS booked_h,
         SUM(${H('b.slot * p.r')}) FILTER (WHERE b.status = 'no_show')   AS noshow_h,
         SUM(${H('b.slot * p.r')}) FILTER (WHERE b.status = 'cancelled') AS cancelled_h,
         COUNT(*) FILTER (WHERE b.status IN ('requested','confirmed','completed','no_show'))::int AS bookings,
         COUNT(*) FILTER (WHERE b.status = 'no_show')::int   AS no_shows,
         COUNT(*) FILTER (WHERE b.status = 'cancelled')::int AS cancellations
    FROM booking b CROSS JOIN p
   WHERE NOT b.is_block AND b.slot && p.r AND b.machine_id IN (SELECT id FROM mach)
   GROUP BY 1
),
ev AS (
  SELECT j.machine_id, e.job_id, e.to_status, e.at,
         COALESCE(LEAD(e.at) OVER (PARTITION BY e.job_id ORDER BY e.at, e.id), now()) AS nxt
    FROM job_event e JOIN job j ON j.id = e.job_id
   WHERE j.machine_id IN (SELECT id FROM mach)
),
ex AS (
  SELECT ev.machine_id,
         SUM(${H('tstzrange(ev.at, GREATEST(ev.at, ev.nxt)) * p.r')}) FILTER (WHERE ev.to_status = 'setup')   AS setup_h,
         SUM(${H('tstzrange(ev.at, GREATEST(ev.at, ev.nxt)) * p.r')}) FILTER (WHERE ev.to_status = 'running') AS run_h
    FROM ev CROSS JOIN p
   WHERE ev.to_status IN ('setup','running')
   GROUP BY 1
),
jobact AS (
  SELECT job_id, SUM(EXTRACT(EPOCH FROM (GREATEST(at, nxt) - at)) / 60.0) AS actual_min
    FROM ev WHERE to_status IN ('setup','running') GROUP BY 1
),
lastq AS (SELECT DISTINCT ON (job_id) job_id, est_minutes, total FROM quote ORDER BY job_id, version DESC),
readyj AS (SELECT DISTINCT e.job_id FROM job_event e CROSS JOIN p WHERE e.to_status = 'ready' AND e.at <@ p.r),
fin AS (   -- jobs finished in the period: estimate accuracy and value
  SELECT j.machine_id, j.id AS job_id, q.est_minutes AS est_min, q.total AS value, ja.actual_min
    FROM readyj r
    JOIN job j ON j.id = r.job_id AND j.machine_id IN (SELECT id FROM mach)
    LEFT JOIN lastq q ON q.job_id = j.id
    LEFT JOIN jobact ja ON ja.job_id = j.id
),
finagg AS (
  SELECT machine_id, COUNT(*)::int AS jobs_done, SUM(value) AS value_done,
         SUM(est_min) FILTER (WHERE est_min > 0 AND actual_min > 0) AS est_min,
         SUM(actual_min) FILTER (WHERE est_min > 0 AND actual_min > 0) AS actual_min,
         COUNT(*) FILTER (WHERE est_min > 0 AND actual_min > 0)::int AS jobs_compared
    FROM fin GROUP BY 1
)
SELECT mc.id, mc.machine, mc.process, mc.process_code, mc.centre_id, mc.centre, mc.district, mc.state_code,
       mc.rate_per_hour::float AS rate, mc.status,
       ROUND(COALESCE(a.open_h, 0)::numeric, 2)::float AS open_h,
       ROUND(LEAST(COALESCE(d.down_h, 0), COALESCE(a.open_h, 0))::numeric, 2)::float AS down_h,
       ROUND(COALESCE(b.booked_h, 0)::numeric, 2)::float AS booked_h,
       ROUND(COALESCE(b.noshow_h, 0)::numeric, 2)::float AS noshow_h,
       ROUND(COALESCE(b.cancelled_h, 0)::numeric, 2)::float AS cancelled_h,
       COALESCE(b.bookings, 0) AS bookings, COALESCE(b.no_shows, 0) AS no_shows, COALESCE(b.cancellations, 0) AS cancellations,
       ROUND(COALESCE(x.setup_h, 0)::numeric, 2)::float AS setup_h,
       ROUND(COALESCE(x.run_h, 0)::numeric, 2)::float AS run_h,
       COALESCE(f.jobs_done, 0) AS jobs_done, COALESCE(f.value_done, 0)::float AS value_done,
       COALESCE(f.est_min, 0)::float AS est_min, COALESCE(f.actual_min, 0)::float AS actual_min,
       COALESCE(f.jobs_compared, 0) AS jobs_compared
  FROM mach mc
  LEFT JOIN avail a ON a.machine_id = mc.id
  LEFT JOIN down d ON d.machine_id = mc.id
  LEFT JOIN bk b ON b.machine_id = mc.id
  LEFT JOIN ex x ON x.machine_id = mc.id
  LEFT JOIN finagg f ON f.machine_id = mc.id
 ORDER BY mc.centre, mc.machine`;

// Booked hours by weekday x hour of day (Indian time), for the peak-demand grid.
const HEAT_SQL = `
WITH p AS (SELECT tstzrange($1::date::timestamptz, LEAST(($2::date + 1)::timestamptz, now())) AS r)
SELECT EXTRACT(ISODOW FROM h)::int AS dow, EXTRACT(HOUR FROM h)::int AS hour,
       ROUND(SUM(${H('(b.slot * p.r) * tstzrange(h, h + interval \'1 hour\')')})::numeric, 2)::float AS hours
  FROM booking b
  JOIN machine m ON m.id = b.machine_id
  JOIN centre c ON c.id = m.centre_id
  CROSS JOIN p
  CROSS JOIN LATERAL generate_series(date_trunc('hour', lower(b.slot * p.r)), upper(b.slot * p.r) - interval '1 second', interval '1 hour') h
 WHERE NOT b.is_block AND b.status IN ('requested','confirmed','completed','no_show') AND b.slot && p.r
   AND NOT isempty(b.slot * p.r) AND c.is_live AND m.status <> 'retired'
   AND ($3::bigint IS NULL OR m.centre_id = $3)
 GROUP BY 1, 2`;

// How long people wait: booking made -> slot start, and job created -> first quote.
const TIMING_SQL = `
WITH p AS (SELECT tstzrange($1::date::timestamptz, LEAST(($2::date + 1)::timestamptz, now())) AS r)
SELECT
  (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (lower(b.slot) - b.created_at)) / 3600.0)
     FROM booking b JOIN machine m ON m.id = b.machine_id CROSS JOIN p
    WHERE NOT b.is_block AND b.created_at <@ p.r AND lower(b.slot) > b.created_at
      AND ($3::bigint IS NULL OR m.centre_id = $3)) AS lead_h,
  (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.at - j.created_at)) / 3600.0)
     FROM job j JOIN machine m ON m.id = j.machine_id CROSS JOIN p
     JOIN LATERAL (SELECT MIN(at) AS at FROM job_event WHERE job_id = j.id AND to_status = 'quote_sent') e ON e.at IS NOT NULL
    WHERE e.at <@ p.r AND ($3::bigint IS NULL OR m.centre_id = $3)) AS quote_h`;

function derive(m) {
  const avail = Math.max(m.open_h - m.down_h, 0);
  const exec = m.setup_h + m.run_h;
  const out = {
    ...m,
    available_h: +avail.toFixed(2),
    executed_h: +exec.toFixed(2),
    idle_h: +Math.max(avail - m.booked_h, 0).toFixed(2),
    gap_h: +Math.max(m.booked_h - exec, 0).toFixed(2),
    unbooked_h: +Math.max(avail - Math.max(exec, m.booked_h), 0).toFixed(2),
    utilisation: avail > 0 ? exec / avail : null,
    booking_rate: avail > 0 ? m.booked_h / avail : null,
    execution_ratio: m.booked_h > 0 ? exec / m.booked_h : null,
    estimate_ratio: m.est_min > 0 ? m.actual_min / m.est_min : null,
  };
  out.idle_value = Math.round(out.idle_h * m.rate);
  const f = [];
  if (avail >= 8 && out.utilisation !== null && out.utilisation < 0.2) f.push('underused');
  if (out.booking_rate !== null && out.booking_rate > 0.85) f.push('near_capacity');
  if (m.booked_h >= 4 && out.execution_ratio !== null && out.execution_ratio < 0.7) f.push('leakage');
  if (m.bookings >= 5 && m.no_shows / m.bookings > 0.15) f.push('no_shows');
  if (m.open_h > 0 && m.down_h / m.open_h > 0.2) f.push('downtime');
  if (m.jobs_compared >= 3 && out.estimate_ratio !== null && Math.abs(out.estimate_ratio - 1) > 0.25) f.push('estimates_off');
  out.flags = f;
  return out;
}

function totals(rows) {
  const t = { machines: rows.length };
  for (const k of ['open_h', 'down_h', 'available_h', 'booked_h', 'noshow_h', 'cancelled_h', 'setup_h', 'run_h', 'executed_h', 'idle_h', 'gap_h', 'unbooked_h', 'idle_value', 'value_done', 'est_min', 'actual_min', 'bookings', 'no_shows', 'cancellations', 'jobs_done', 'jobs_compared']) {
    t[k] = +rows.reduce((a, r) => a + (r[k] || 0), 0).toFixed(2);
  }
  t.utilisation = t.available_h > 0 ? t.executed_h / t.available_h : null;
  t.booking_rate = t.available_h > 0 ? t.booked_h / t.available_h : null;
  t.execution_ratio = t.booked_h > 0 ? t.executed_h / t.booked_h : null;
  t.estimate_ratio = t.est_min > 0 ? t.actual_min / t.est_min : null;
  return t;
}

function group(rows, key, label) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!m.has(k)) m.set(k, { key: k, label: r[label], rows: [] });
    m.get(k).rows.push(r);
  }
  return [...m.values()].map((g) => ({ key: g.key, label: g.label, ...totals(g.rows) }))
    .sort((a, b) => (b.utilisation || 0) - (a.utilisation || 0));
}

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;               // stop spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const pct = (x) => (x == null ? '' : (x * 100).toFixed(1));

module.exports = async function reportRoutes(app, { db, auth }) {
  const viewers = auth.guard([...ADMINS, 'centre_manager', 'centre_staff']);
  const query = {
    type: 'object', additionalProperties: false,
    properties: { from: { type: 'string', maxLength: 10 }, to: { type: 'string', maxLength: 10 }, centre_id: { type: 'string', pattern: '^[0-9]{1,12}$' } },
  };

  function scope(req) {
    const isAdmin = ADMINS.includes(req.user.role);
    if (!isAdmin) {
      if (req.user.centre_id == null) throw httpError(403, 'Your account is not linked to a centre.');
      return req.user.centre_id;
    }
    return req.query.centre_id ? int(req.query.centre_id) : null;
  }

  async function build(req) {
    const { from, to } = period(req.query);
    const centre = scope(req);
    const args = [from, to, centre];
    const [m, h, t] = await Promise.all([db.query(MACHINE_SQL, args), db.query(HEAT_SQL, args), db.query(TIMING_SQL, args)]);
    const machines = m.rows.map(derive);
    return {
      period: { from, to }, centre_id: centre,
      totals: totals(machines),
      by_centre: group(machines, 'centre_id', 'centre'),
      by_process: group(machines, 'process_code', 'process'),
      machines,
      heatmap: h.rows,
      timing: { median_lead_hours: t.rows[0].lead_h, median_quote_hours: t.rows[0].quote_h },
    };
  }

  const limit = { rateLimit: { max: 60, timeWindow: '1 minute' } };
  app.get('/reports/utilisation', { preValidation: viewers, config: limit, schema: { querystring: query } }, build);

  app.get('/reports/utilisation.csv', { preValidation: viewers, config: limit, schema: { querystring: query } }, async (req, reply) => {
    const r = await build(req);
    const head = ['Centre', 'District', 'Machine', 'Process', 'Open hours', 'Downtime hours', 'Available hours', 'Booked hours',
      'Executed hours', 'Setup hours', 'Run hours', 'Idle hours', 'Booked but not run hours', 'No-show hours', 'Cancelled hours',
      'Utilisation %', 'Booking rate %', 'Booked to executed %', 'Bookings', 'No-shows', 'Cancellations', 'Jobs finished',
      'Actual vs quoted time %', 'Idle value (Rs)', 'Flags'];
    const lines = [head.map(csvCell).join(',')];
    for (const x of r.machines) {
      lines.push([x.centre, x.district, x.machine, x.process, x.open_h, x.down_h, x.available_h, x.booked_h, x.executed_h,
        x.setup_h, x.run_h, x.idle_h, x.gap_h, x.noshow_h, x.cancelled_h, pct(x.utilisation), pct(x.booking_rate),
        pct(x.execution_ratio), x.bookings, x.no_shows, x.cancellations, x.jobs_done, pct(x.estimate_ratio), x.idle_value,
        x.flags.join(' ')].map(csvCell).join(','));
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="iichub-utilisation-${r.period.from}-to-${r.period.to}.csv"`);
    return '﻿' + lines.join('\r\n') + '\r\n';
  });
};
