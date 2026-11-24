// Pressure test for IICHUB. Usage: node pressure.js http://localhost:3300 <serverPid>
'use strict';
const autocannon = require('autocannon');
const { execSync } = require('child_process');
const B = process.argv[2] || 'http://localhost:3300';
const PID = process.argv[3];
const rip = () => `49.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;
const rss = () => (PID ? Math.round(Number(execSync(`ps -o rss= -p ${PID}`).toString().trim()) / 1024) + ' MB' : 'n/a');
const results = [];
const check = (n, c, x = '') => { results.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + JSON.stringify(x).slice(0, 300))); };

async function j(method, path, body, headers = {}) {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': rip(), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
}
function run(opts) { return new Promise((res, rej) => autocannon(opts, (e, r) => (e ? rej(e) : res(r)))); }
function summary(name, r) {
  const non2 = r.non2xx; const s5 = (r['5xx'] || 0);
  console.log(`  ${name}: ${Math.round(r.requests.average)} req/s · latency p50 ${r.latency.p50} ms, p97.5 ${r.latency.p97_5} ms, p99 ${r.latency.p99} ms · ${r.requests.total} requests · non-2xx ${non2} · 5xx ${s5} · errors ${r.errors} · timeouts ${r.timeouts}`);
  return r;
}

(async () => {
  console.log('Server memory at start:', rss());
  const ids = Array.from({ length: 24 }, (_, i) => i + 1).join(',');
  const photo = (await j('GET', '/machines?x=10&y=10&z=10')).data.find((m) => m.photo_id);

  // ---------- A. Realistic public mix, many visitors ----------
  console.log('\nA. 60 simultaneous visitors browsing for 20 s (search, profiles, slots, free days, nearby, photos, pages)');
  const reqs = [
    { method: 'GET', path: '/machines?x=120&y=80&z=40&mat=pla&lat=17.73&lng=83.319&qty=1' },
    { method: 'GET', path: '/machines?x=60&y=40&z=20&lat=17.42&lng=78.41&qty=1' },
    { method: 'GET', path: '/machines/1/profile' },
    { method: 'GET', path: '/machines/2/slots?days=7&mins=60' },
    { method: 'GET', path: '/machines/free-days?ids=' + ids },
    { method: 'GET', path: '/centres/near?lat=17.73&lng=83.319&limit=5' },
    { method: 'GET', path: '/meta' },
    { method: 'GET', path: '/' },
    { method: 'GET', path: '/css/iichub.css' },
    ...(photo ? [{ method: 'GET', path: '/photos/' + photo.photo_id }] : []),
  ];
  let i = 0;
  const A = summary('mix', await run({
    url: B, connections: 60, duration: 20, timeout: 20,
    requests: reqs.map((r) => ({ ...r, setupRequest: (q) => ({ ...q, headers: { ...q.headers, 'x-forwarded-for': rip() } }) })),
    setupClient: () => { i++; },
  }));
  check('A: no server errors (5xx) under load', (A['5xx'] || 0) === 0 && A.errors === 0, { s5: A['5xx'], err: A.errors });
  check('A: 99% of requests answered within 1.5 s', A.latency.p99 <= 1500, A.latency);
  check('A: at least 150 requests/second on 2 CPUs', A.requests.average >= 150, A.requests.average);
  console.log('  Server memory after A:', rss());

  // ---------- B. Heaviest endpoint alone ----------
  console.log('\nB. Search only (the heaviest query), 40 visitors for 15 s');
  const Bs = summary('search', await run({
    url: B + '/machines?x=120&y=80&z=40&mat=pla&lat=17.73&lng=83.319&qty=1', connections: 40, duration: 15,
    setupRequest: undefined,
    requests: [{ setupRequest: (q) => ({ ...q, headers: { ...q.headers, 'x-forwarded-for': rip() } }) }],
  }));
  check('B: search stays error-free', (Bs['5xx'] || 0) === 0 && Bs.errors === 0);

  // ---------- C. One attacker floods from one address ----------
  console.log('\nC. One address floods search with 100 connections for 10 s');
  const C = summary('flood', await run({ url: B + '/machines?x=10&y=10&z=10', connections: 100, duration: 10, headers: { 'x-forwarded-for': '203.0.113.66' } }));
  check('C: flood is throttled (most requests get "too many requests")', C.non2xx > C.requests.total * 0.8, { non2xx: C.non2xx, total: C.requests.total });
  check('C: flooding never causes server errors', (C['5xx'] || 0) === 0 && C.errors === 0);
  const t0 = Date.now(); const ok = await j('GET', '/machines?x=10&y=10&z=10');
  check('C: a normal visitor is unaffected right after the flood', ok.status === 200 && Date.now() - t0 < 1500, { status: ok.status, ms: Date.now() - t0 });

  // ---------- D. 40 people race for the same slot ----------
  console.log('\nD. 40 innovators try to book the same slot at the same moment');
  const users = await Promise.all(Array.from({ length: 40 }, async (_, k) => {
    const r = await j('POST', '/auth/register', { email: `race${Date.now()}${k}@example.com`, password: 'Racing-Kettle-Orbit-73', name: 'Racer ' + k });
    return r.data.token;
  }));
  const slots = (await j('GET', '/machines/3/slots?days=7&mins=60')).data;
  const s = slots[slots.length - 1];
  const tries = await Promise.all(users.map((t) => j('POST', '/bookings', { machine_id: 3, slot_start: s.slot_start, slot_end: s.slot_end, title: 'race' }, { Authorization: 'Bearer ' + t })));
  const codes = tries.map((r) => r.status);
  check('D: exactly one booking wins; 39 are told the slot was taken', codes.filter((c) => c === 201).length === 1 && codes.filter((c) => c === 409).length === 39, codes);

  // ---------- E. Password guessing from 60 addresses at once ----------
  console.log('\nE. 60 parallel wrong-password attempts on one account from 60 addresses');
  const victim = `victim${Date.now()}@example.com`;
  await j('POST', '/auth/register', { email: victim, password: 'Correct-Horse-Battery-91', name: 'Victim' });
  const guesses = await Promise.all(Array.from({ length: 60 }, (_, k) => j('POST', '/auth/login', { email: victim, password: 'guess-' + k })));
  const g = guesses.map((r) => r.status);
  check('E: no server errors during the guessing burst', !g.includes(500), g);
  const after = await j('POST', '/auth/login', { email: victim, password: 'Correct-Horse-Battery-91' });
  check('E: account is locked afterwards, even for the right password', after.status === 429, after);

  // ---------- F. Heavy photo uploads in parallel ----------
  console.log('\nF. 16 owners upload a 4 MB photo at the same time');
  const sharp = require('sharp');
  let big, q = 92;
  do { big = await sharp({ create: { width: 3000, height: 3000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).jpeg({ quality: q }).toBuffer(); q -= 8; }
  while (big.length > 4.6 * 1048576 && q > 20);
  console.log('  photo size:', (big.length / 1048576).toFixed(1), 'MB');
  const owners = await Promise.all(Array.from({ length: 16 }, async (_, k) => {
    const o = await j('POST', '/auth/register', { email: `up${Date.now()}${k}@example.com`, password: 'Upload-Meadow-Stone-44', name: 'Uploader ' + k, account_type: 'equipment_owner' });
    const t = o.data.token;
    const l = await j('POST', '/owner/listings', { centre: { name: 'Lab ' + k, address: 'Road ' + k + ', Town', district: 'Pune', pincode: '411001', lat: 18.5, lng: 73.8 },
      machine: { process_code: 'fdm', make: 'Prusa', model: 'MK4', rate_per_hour: 150, max_x_mm: 250, max_y_mm: 210, max_z_mm: 220, materials: ['pla'] } }, { Authorization: 'Bearer ' + t });
    return { t, mid: l.data.machine_id };
  }));
  const tu = Date.now();
  const ups = await Promise.all(owners.map((o) => fetch(`${B}/owner/machines/${o.mid}/photos?kind=machine`, {
    method: 'POST', body: big, headers: { Authorization: 'Bearer ' + o.t, 'Content-Type': 'image/jpeg', 'X-Forwarded-For': rip() } }).then((r) => r.status)));
  console.log(`  16 uploads finished in ${((Date.now() - tu) / 1000).toFixed(1)} s · server memory now ${rss()}`);
  const tu2 = Date.now();
  const ups2 = await Promise.all(owners.map((o) => fetch(`${B}/owner/machines/${o.mid}/photos?kind=sample_output`, {
    method: 'POST', body: big, headers: { Authorization: 'Bearer ' + o.t, 'Content-Type': 'image/jpeg', 'X-Forwarded-For': rip() } }).then((r) => r.status)));
  console.log(`  second burst of 16 finished in ${((Date.now() - tu2) / 1000).toFixed(1)} s · server memory now ${rss()}`);
  check('F: second burst also fully processed (no leak or stall)', ups2.every((c) => c === 201), ups2);
  check('F: all 16 heavy uploads processed', ups.every((c) => c === 201), ups);
  const t1 = Date.now(); const h = await j('GET', '/health');
  check('F: site still responsive right after the upload burst', h.status === 200 && Date.now() - t1 < 1000, Date.now() - t1);

  // ---------- G. Burst of 300 at once ----------
  console.log('\nG. 300 requests fired at the same instant (database pool is 10 connections)');
  const tg = Date.now();
  const listed = (await j('GET', '/machines?x=10&y=10&z=10')).data.map((m) => m.machine_id);
  const burst = await Promise.all(Array.from({ length: 300 }, (_, k) => j('GET', `/machines/${listed[k % listed.length]}/slots?days=7&mins=60`).then((r) => r.status)));
  console.log(`  finished in ${((Date.now() - tg) / 1000).toFixed(1)} s`);
  check('G: all 300 answered successfully (requests queue, none fail)', burst.every((c) => c === 200), [...new Set(burst)]);

  const h2 = await j('GET', '/health');
  check('Server healthy at the end', h2.status === 200 && h2.data.db === 'up');
  console.log('Server memory at end:', rss());
  console.log(`\n${results.filter(Boolean).length} / ${results.length} passed`);
})().catch((e) => { console.error('pressure test crashed:', e); process.exit(1); });
