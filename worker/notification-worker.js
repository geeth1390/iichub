// ============================================================
// Notification worker
// The database QUEUES messages; this worker SENDS them.
// Runs inside the web server by default (RUN_WORKER=true), or on its
// own:  node worker/notification-worker.js
// Rows are claimed with FOR UPDATE SKIP LOCKED, so two copies never
// send the same message.
// ============================================================
'use strict';

const { sendEmail, mailEnabled } = require('../lib/mailer');

function render(tpl, payload) {
  return (tpl || '').replace(/\{(\w+)\}/g, (_, k) =>
    payload && payload[k] != null ? String(payload[k]) : '');
}

function startWorker({ db, log, siteUrl, pollMs = 15000 }) {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT n.id, n.channel, n.template, n.payload, n.related_job, n.attempts,
                u.name, u.email, u.phone, t.subject AS subject_tpl, t.body AS body_tpl
           FROM notification n
           JOIN app_user u ON u.id = n.user_id
           JOIN notification_template t ON t.key = n.template
          WHERE n.status = 'queued'
          ORDER BY n.created_at
          LIMIT 25
          FOR UPDATE OF n SKIP LOCKED`
      );
      for (const n of rows) {
        const payload = { ...(n.payload || {}), link: `${siteUrl}/#jobs` };
        if (n.related_job) {
          const q = await client.query(
            `SELECT total, to_char(valid_until, 'DD Mon YYYY') AS valid_until
               FROM quote WHERE job_id = $1 ORDER BY version DESC LIMIT 1`, [n.related_job]
          );
          if (q.rows[0]) Object.assign(payload, q.rows[0]);
        }
        const body = render(n.body_tpl, payload);
        const subject = render(n.subject_tpl, payload);
        try {
          let status = 'sent';
          let note = null;
          if (n.channel === 'email') {
            if (!mailEnabled()) { status = 'skipped'; note = 'email not configured'; }
            else if (!n.email || n.email.endsWith('.invalid')) { status = 'skipped'; note = 'no email on file'; }
            else await sendEmail(n.email, subject, body);
          } else if (n.channel === 'sms') {
            status = 'skipped'; note = 'SMS provider not configured';
          }
          await client.query(
            `UPDATE notification SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN now() END,
                    subject = $3, body = $4, last_error = $5 WHERE id = $1`,
            [n.id, status, subject, body, note]
          );
        } catch (e) {
          await client.query(
            `UPDATE notification SET status = CASE WHEN attempts >= 4 THEN 'failed' ELSE 'queued' END,
                    last_error = $2, attempts = attempts + 1 WHERE id = $1`,
            [n.id, String(e.message).slice(0, 500)]
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      log.error({ err: e }, 'notification worker tick failed');
    } finally {
      client.release();
      running = false;
    }
  }

  log.info(`notification worker started; polling every ${pollMs} ms`);
  const timer = setInterval(tick, pollMs);
  timer.unref();
  tick();
  return { stop: () => clearInterval(timer), tick };
}

module.exports = { startWorker, render };

// Stand-alone mode.
if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const { Pool } = require('pg');
  const { dbConfig } = require('../lib/db-config');
  const db = new Pool(dbConfig({ max: 3 }));
  startWorker({
    db,
    log: { info: console.log, error: (o, m) => console.error(m, o && o.err ? o.err.message : o) },
    siteUrl: (process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, ''),
    pollMs: Number(process.env.POLL_MS) || 15000,
  });
  setInterval(() => {}, 1 << 30);
}
