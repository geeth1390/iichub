// ============================================================
// ProtoHub API server
// Serves the screens and the API, enforces sign-in and roles, and (by
// default) runs the notification worker in the same process.
// ============================================================
'use strict';
require('dotenv').config({ quiet: true });

const path = require('path');
const Fastify = require('fastify');
const { Pool } = require('pg');
const { dbConfig } = require('./lib/db-config');
const { createAuth } = require('./lib/auth');
const { makeAudit } = require('./lib/util');

function loadConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const secret = env.JWT_SECRET || '';
  if (secret.length < 32 || /change|example|secret/i.test(secret)) {
    throw new Error('JWT_SECRET must be a random string of at least 32 characters (run: openssl rand -hex 32)');
  }
  const siteUrl = (env.SITE_URL || (prod ? '' : 'http://localhost:3000')).replace(/\/+$/, '');
  if (!siteUrl) throw new Error('SITE_URL is required in production, e.g. https://www.iichub.com');
  if (prod && !siteUrl.startsWith('https://')) throw new Error('SITE_URL must start with https:// in production');
  if (env.OTP_DEV_MODE) console.warn('OTP_DEV_MODE is no longer used (sign-in is email + password). Remove it.');
  return {
    prod,
    secret,
    siteUrl,
    port: Number(env.PORT) || 3000,
    // Only proxies on private networks (Dokploy's Traefik) are trusted to
    // say who the visitor is; a forged X-Forwarded-For from outside is ignored.
    trustProxy: env.TRUST_PROXY || 'loopback,linklocal,uniquelocal',
    runWorker: env.RUN_WORKER !== 'false',
    demoBanner: env.SEED_DEMO === 'true' && env.HIDE_SAMPLE_NOTICE !== 'true',
  };
}

async function buildApp({ config, db, logger = true }) {
  const app = Fastify({
    logger: logger && {
      level: process.env.LOG_LEVEL || 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', allErrors: false } },
  });

  const auth = createAuth({ db, secret: config.secret });
  const audit = makeAudit(db, app.log);
  const ctx = { db, auth, audit, config };

  // ---- security headers ----
  await app.register(require('@fastify/helmet'), {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: config.prod ? [] : null,
      },
    },
    strictTransportSecurity: config.prod ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
  });

  // ---- rate limits (per client IP; auth routes set stricter ones) ----
  await app.register(require('@fastify/rate-limit'), {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: (req, ctx2) => {
      const mins = Math.ceil(ctx2.ttl / 60000);
      const e = new Error(`Too many attempts. Please wait ${mins > 1 ? mins + ' minutes' : 'a minute'} and try again.`);
      e.statusCode = 429;
      e.expose = true;
      return e;
    },
  });

  // ---- send bare-domain visitors to the canonical address ----
  const canonical = new URL(config.siteUrl);
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host || '').toLowerCase();
    if (canonical.hostname.startsWith('www.') && host === canonical.hostname.slice(4)) {
      return reply.redirect(config.siteUrl + req.url, 301);
    }
  });

  // ---- errors: database rule messages are shown, everything else is generic ----
  app.setErrorHandler((err, req, reply) => {
    if (err.validation) {
      return reply.code(400).send({ error: `Invalid input: ${err.message.replace(/^(body|querystring|params)\/?/, '')}` });
    }
    if (err.expose && err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
    if (err.statusCode === 429) return reply.code(429).send({ error: err.message });
    const pg = { P0001: 400, '23P01': 409, '23505': 409, '23503': 400, '23514': 400, '22P02': 400, '22007': 400, '22008': 400, '22003': 400 };
    if (err.code && pg[err.code]) {
      const msg = {
        P0001: err.message.replace(/^permission denied: /i, 'Not allowed: '),
        '23P01': 'That time slot was just taken. Please pick another.',
        '23505': 'That already exists.',
        '23503': 'Something this refers to does not exist.',
        '23514': 'One of the values is not allowed.',
      }[err.code] || 'Some of the input is not valid.';
      const status = err.code === 'P0001' && /permission denied/i.test(err.message) ? 403 : pg[err.code];
      return reply.code(status).send({ error: msg });
    }
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong on our side. Please try again.' });
  });

  // ---- API ----
  await app.register(require('./routes/auth'), ctx);
  await app.register(require('./routes/public'), ctx);
  await app.register(require('./routes/innovator'), ctx);
  await app.register(require('./routes/staff'), ctx);
  await app.register(require('./routes/owner'), ctx);
  await app.register(require('./routes/admin'), ctx);

  app.get('/config.json', async () => ({ sample_notice: config.demoBanner }));

  // ---- screens ----
  await app.register(require('@fastify/static'), {
    root: path.join(__dirname, 'public'),
    prefix: '/',
    index: false,
    dotfiles: 'deny',
    setHeaders(reply, file) {
      reply.header('Cache-Control', file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
    },
  });
  const page = (file) => async (req, reply) => reply.sendFile(file);
  app.get('/', page('app.html'));
  app.get('/manager', page('manager.html'));
  app.get('/admin', page('admin.html'));

  return app;
}

async function main() {
  const config = loadConfig();
  const db = new Pool(dbConfig({ max: 10, idleTimeoutMillis: 30000 }));
  const app = await buildApp({ config, db });

  await require('./lib/bootstrap').bootstrapSuperAdmin(db, app.log);
  if (config.runWorker) {
    require('./worker/notification-worker').startWorker({ db, log: app.log, siteUrl: config.siteUrl });
  }

  const close = async (sig) => {
    app.log.info(`${sig}: shutting down`);
    await app.close().catch(() => {});
    await db.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => close('SIGTERM'));
  process.on('SIGINT', () => close('SIGINT'));

  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`ProtoHub ready on :${config.port} (${config.siteUrl})`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}

module.exports = { buildApp, loadConfig };
