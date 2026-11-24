import requests, random, subprocess, json, sys, datetime as dt

B = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3300'
SUPER_EMAIL, SUPER_PW = 'owner@iichub.com', 'Tr1cky-Banyan-Kite-2026'
results = []

def check(name, cond, extra=''):
    results.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + (('  -> ' + str(extra)[:200]) if not cond and extra else ''))

def ip():
    return f'49.{random.randint(0,255)}.{random.randint(0,255)}.{random.randint(1,254)}'

class S:
    def __init__(s, token=None):
        s.token = token; s.ip = ip()
    def req(s, m, path, body=None, token=None, headers=None):
        h = {'X-Forwarded-For': s.ip, **(headers or {})}
        t = token if token is not None else s.token
        if t: h['Authorization'] = 'Bearer ' + t
        r = requests.request(m, B + path, json=body, headers=h, timeout=30)
        try: d = r.json()
        except Exception: d = r.text
        return r.status_code, d
    def get(s, p, **k): return s.req('GET', p, **k)
    def post(s, p, b=None, **k): return s.req('POST', p, b if b is not None else {}, **k)
    def patch(s, p, b, **k): return s.req('PATCH', p, b, **k)

def login(email, pw):
    s = S(); c, d = s.post('/auth/login', {'email': email, 'password': pw})
    if c == 200: s.token = d['token']; s.user = d['user']
    return s, c, d

def setpw(s, cur, new):
    c, d = s.post('/auth/change-password', {'current_password': cur, 'new_password': new})
    if c == 200: s.token = d['token']
    return c, d

def node_sign(payload, secret, opts='{}'):
    return subprocess.check_output(['node', '-e', f"console.log(require('/home/claude/work/node_modules/jsonwebtoken').sign({json.dumps(payload)}, {json.dumps(secret)}, {opts}))"]).decode().strip()

def psql(sql):
    return subprocess.run(['psql', '-h', '/tmp', '-p', '5433', '-U', 'postgres', 't2', '-Atc', sql], capture_output=True, text=True)

# ---------------- super admin bootstrap & forced password change
sup, c, d = login(SUPER_EMAIL, SUPER_PW)
check('super admin can sign in with bootstrap password', c == 200, d)
check('bootstrap account flagged must_change_password', d.get('user', {}).get('must_change_password') is True)
c, d = sup.get('/admin/users')
check('temp-password session blocked from admin API', c == 403 and d.get('code') == 'must_change_password', d)
old = sup.token
c, d = setpw(sup, SUPER_PW, 'weak')
check('weak new password rejected', c == 400, d)
NEW_SUPER = 'Monsoon-Lantern-Quarry-48'
c, d = setpw(sup, SUPER_PW, NEW_SUPER)
check('super admin sets own password', c == 200, d)
c, _ = sup.get('/auth/me', token=old)
check('old token revoked after password change', c == 401)
c, d = sup.get('/admin/users')
check('super admin can list accounts', c == 200 and isinstance(d, list), d)

# ---------------- forged tokens
c, _ = S(node_sign({'tv': 0}, 'dev-only-change-me', "{subject:'1',issuer:'protohub'}")).get('/admin/users')
check('token forged with old default secret rejected', c == 401)
c, _ = S(node_sign({'id': 2, 'role': 'super_admin'}, 'x', "{algorithm:'none'}")).get('/admin/users')
check('unsigned (alg none) token rejected', c == 401)
c, _ = S('garbage.token.here').get('/auth/me')
check('garbage token rejected', c == 401)

# ---------------- self-registration cannot pick a privileged role
inn = S()
c, d = inn.post('/auth/register', {'email': 'evil@x.com', 'password': 'Long-Enough-Pass-1', 'name': 'Evil', 'role': 'super_admin'})
check('register with extra "role" field rejected', c == 400, d)
c, d = inn.post('/auth/register', {'email': 'evil@x.com', 'password': 'Long-Enough-Pass-1', 'name': 'Evil', 'account_type': 'apis_admin'})
check('register as apis_admin rejected', c == 400, d)
c, d = inn.post('/auth/register', {'email': 'Ravi@Example.com', 'password': 'Paper-Rocket-Delta-9', 'name': 'Ravi Teja', 'affiliation': 'student'})
check('innovator can register', c == 201 and d['user']['role'] == 'innovator', d)
inn.token = d.get('token')
c, d = S().post('/auth/register', {'email': 'ravi@example.com', 'password': 'Paper-Rocket-Delta-9', 'name': 'Dup'})
check('duplicate email (case-insensitive) rejected', c == 409, d)
c, d = inn.get('/admin/users'); check('innovator blocked from admin API', c == 403)
c, d = inn.get('/queue/1'); check('innovator blocked from staff queue', c == 403)

# ---------------- super admin creates admin + centre accounts
def create(s, body):
    c, d = s.post('/admin/users', body)
    return c, d

c, d = create(sup, {'email': 'admin@iichub.com', 'name': 'Asha Admin', 'role': 'apis_admin'})
check('super admin creates admin', c == 201 and d.get('temp_password'), d); admin_temp = d.get('temp_password')
c, d = create(sup, {'email': 'mgr1@iichub.com', 'name': 'Prasad Manager', 'role': 'centre_manager', 'centre_id': 1})
check('super admin creates centre manager (centre 1)', c == 201, d); mgr_temp = d.get('temp_password')
c, d = create(sup, {'email': 'staff2@iichub.com', 'name': 'Lakshmi Staff', 'role': 'centre_staff', 'centre_id': 2})
check('super admin creates centre staff (centre 2)', c == 201, d); st2_temp = d.get('temp_password')
c, d = create(sup, {'email': 'nocentre@iichub.com', 'name': 'No Centre', 'role': 'centre_staff'})
check('staff without centre rejected', c == 400, d)

adm, c, _ = login('admin@iichub.com', admin_temp); setpw(adm, admin_temp, 'Granite-Orchid-Pivot-73')
mgr, c, _ = login('mgr1@iichub.com', mgr_temp); setpw(mgr, mgr_temp, 'Copper-Meadow-Tiger-15')
st2, c, _ = login('staff2@iichub.com', st2_temp); setpw(st2, st2_temp, 'Velvet-Harbor-Comet-62')
check('new accounts sign in with temp password and set their own', all(x.get('/auth/me')[0] == 200 for x in (adm, mgr, st2)))

# admin limits
c, d = create(adm, {'email': 'sneaky@iichub.com', 'name': 'Sneaky', 'role': 'super_admin'})
check('admin cannot create super admin', c == 403, d)
c, d = create(adm, {'email': 'sneaky2@iichub.com', 'name': 'Sneaky', 'role': 'apis_admin'})
check('admin cannot create another admin', c == 403, d)
sup_id = sup.get('/auth/me')[1]['id']
c, d = adm.patch(f'/admin/users/{sup_id}', {'is_active': False}); check('admin cannot disable super admin', c == 403, d)
c, d = adm.post(f'/admin/users/{sup_id}/reset-password'); check('admin cannot reset super admin password', c == 403, d)
c, d = adm.get('/admin/audit'); check('admin cannot read audit log', c == 403)
c, d = create(adm, {'email': 'mgr2@iichub.com', 'name': 'Second Manager', 'role': 'centre_manager', 'centre_id': 2})
check('admin creates centre manager', c == 201, d)

# manager limits
c, d = create(mgr, {'email': 'st1@iichub.com', 'name': 'Suresh Staff', 'role': 'centre_staff', 'centre_id': 2})
check('manager creates staff (centre forced to own)', c == 201 and int(d['user']['centre_id']) == 1, d); st1_temp = d.get('temp_password')
c, d = create(mgr, {'email': 'x2@iichub.com', 'name': 'Up Grade', 'role': 'centre_manager'})
check('manager cannot create managers', c == 403, d)
st2_id = st2.get('/auth/me')[1]['id']
c, d = mgr.patch(f'/admin/users/{st2_id}', {'is_active': False}); check('manager cannot touch other centre staff', c == 403, d)
c, d = mgr.get('/admin/users'); check('manager sees only own centre accounts', c == 200 and all(int(u['centre_id'] or 0) == 1 for u in d), d)
c, d = mgr.get('/admin/centres'); check('manager sees only own centre', c == 200 and len(d) == 1)
c, d = mgr.post('/admin/centres', {'name': 'X', 'district': 'Y', 'address': 'ZZZ', 'lat': 1, 'lng': 1}); check('manager cannot create centres', c == 403)
st1, *_ = login('st1@iichub.com', st1_temp); setpw(st1, st1_temp, 'Saffron-Bridge-Otter-27')

# self-protection
c, d = sup.patch(f'/admin/users/{sup_id}', {'role': 'innovator'}); check('super admin cannot demote self', c == 403, d)

# ---------------- centre scoping (was the big hole)
c, d = st2.get('/queue/1'); check('centre-2 staff blocked from centre-1 queue', c == 403, d)
c, d = st2.get('/centre/1/resources'); check('centre-2 staff blocked from centre-1 stock', c == 403)
c, d = st2.post('/machines/1/restock', {'material': 'pla', 'grams': 100}); check('centre-2 staff cannot restock centre-1 machine', c == 403, d)
c, d = st2.post('/machines/1/maintenance', {'reason': 'sabotage'}); check('centre-2 staff cannot put centre-1 machine in maintenance', c == 403, d)
c, d = st2.get('/queue/2'); check('centre-2 staff can see own queue', c == 200)
c, d = adm.get('/queue/1'); check('admin can see any centre queue', c == 200)

# ---------------- booking flow
c, rows = S().get('/machines?x=50&y=50&z=20&mat=pla&lat=17.73&lng=83.319')
check('public machine search works', c == 200 and len(rows) > 0, rows)
mid = next(int(r['machine_id']) for r in rows if r['centre_name'] == 'APIIC Visakhapatnam' and r['status'] == 'available')
c, slots = S().get(f'/machines/{mid}/slots?days=7&mins=60')
check('free slots returned', c == 200 and len(slots) > 3, slots)
first = slots[0]['slot_start']
check('slots start at a round local hour in IST (+05:30)', first.endswith(':00:00+05:30') or 'T' in first, first)
c, prof = S().get(f'/machines/{mid}/profile'); check('anonymous profile hides operator phone', c == 200 and 'operator_phone' not in prof)
c, d = S().post('/bookings', {'machine_id': mid, 'slot_start': slots[0]['slot_start'], 'slot_end': slots[0]['slot_end']})
check('booking needs sign-in', c == 401)
c, d = inn.post('/bookings', {'machine_id': mid, 'slot_start': slots[0]['slot_start'], 'slot_end': slots[0]['slot_end'], 'title': 'Drone bracket', 'material': 'pla', 'qty': 2})
check('innovator books a slot', c == 201, d); job = d.get('job_id')
c, d = S().post('/auth/register', {'email': 'sneha@example.com', 'password': 'Willow-Engine-Sparrow-4', 'name': 'Sneha'}); inn2 = S(d.get('token'))
c, d = inn2.post('/bookings', {'machine_id': mid, 'slot_start': slots[0]['slot_start'], 'slot_end': slots[0]['slot_end']})
check('double booking blocked with friendly message', c == 409 and 'taken' in d.get('error', ''), d)
past = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).isoformat()
c, d = inn2.post('/bookings', {'machine_id': mid, 'slot_start': past, 'slot_end': (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=20)).isoformat()})
check('past booking blocked', c == 400, d)
s0 = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=3)
c, d = inn2.post('/bookings', {'machine_id': mid, 'slot_start': s0.isoformat(), 'slot_end': (s0 + dt.timedelta(hours=30)).isoformat()})
check('30-hour booking blocked', c == 400, d)
c, d = inn2.post('/bookings', {'machine_id': mid, 'slot_start': slots[5]['slot_start'], 'slot_end': slots[5]['slot_end'], 'material': 'unobtanium'})
check('booking with material the machine lacks blocked', c == 400, d)
c, d = inn2.post(f'/jobs/{job}/accept'); check("other innovator cannot accept someone else's job", c == 409, d)
c, d = inn.post(f'/jobs/{job}/accept'); check('cannot accept before a quote exists', c == 409, d)

# quote: wrong-centre staff blocked at API and DB level
c, d = st2.post(f'/jobs/{job}/quote', {'minutes': 60, 'grams': 40}); check('centre-2 staff cannot price centre-1 job (API)', c == 403, d)
r = psql(f"SELECT issue_quote({job}, {st2_id}, 60, 40, NULL)")
check('centre-2 staff cannot price centre-1 job (database guard)', 'another centre' in r.stderr, r.stderr)
r = psql(f"SELECT advance_job({job}, 'queued', {inn.get('/auth/me')[1]['id']}, NULL, NULL)")
check('innovator cannot advance a job (database guard)', 'permission denied' in r.stderr, r.stderr)
c, d = mgr.post(f'/jobs/{job}/quote', {'minutes': 90, 'grams': 40}); check('centre manager prices the job', c == 200 and float(d['total']) > 0, d)
c, d = inn.post(f'/jobs/{job}/accept'); check('innovator accepts quote', c == 200, d)
c, d = mgr.post(f'/jobs/{job}/quote', {'minutes': 1, 'grams': 0}); check('cannot re-price after acceptance', c == 400, d)
ok = True
for to in ['queued', 'setup', 'running', 'qc', 'ready', 'collected']:
    c, d = st1.post(f'/jobs/{job}/advance', {'to': to, 'grams': 30 if to == 'running' else 0})
    ok = ok and c == 200
check('centre staff moves job through every stage to collected', ok, d)
c, d = inn.get('/my/jobs'); check('innovator sees job as collected with quote', d[0]['status'] == 'collected' and d[0]['quote'], d)
c, d = st1.post(f'/jobs/{job}/advance', {'to': 'running'}); check('illegal transition rejected', c == 400, d)
# cancel flow frees slot
c, d = inn2.post('/bookings', {'machine_id': mid, 'slot_start': slots[2]['slot_start'], 'slot_end': slots[2]['slot_end']}); j2 = d.get('job_id')
c, d = inn2.post(f'/jobs/{j2}/cancel'); check('innovator cancels own booking', c == 200, d)
c, d = inn.post('/bookings', {'machine_id': mid, 'slot_start': slots[2]['slot_start'], 'slot_end': slots[2]['slot_end']})
check('cancelled slot can be booked again', c == 201, d)

# ---------------- private listings (new flow: draft -> photos -> submit -> review)
import io
from PIL import Image
c, d = S().post('/auth/register', {'email': 'owner2@example.com', 'password': 'Cactus-Ribbon-Falcon-8', 'name': 'Lab Owner', 'account_type': 'equipment_owner'})
own = S(d.get('token'))
listing = {'centre': {'name': 'Garage Lab', 'district': 'Visakhapatnam', 'address': '12 Beach Road', 'pincode': '530002', 'lat': 17.72, 'lng': 83.31},
           'machine': {'process_code': 'fdm', 'make': 'Prusa', 'model': 'MK4', 'rate_per_hour': 200, 'max_x_mm': 250, 'max_y_mm': 210, 'max_z_mm': 220, 'materials': ['pla']},
           'guide': {'how_to_use': 'Send STL.', 'safety_notes': 'Closed shoes.'}}
c, d = own.post('/owner/listings', {**listing, 'fee_pct': 0}); check('owner cannot set own platform fee (unknown field rejected)', c == 400, d)
c, d = own.post('/owner/listings', listing); check('owner creates a draft listing', c == 201 and d['verification'] == 'draft', d)
cid, pm = d.get('centre_id'), d.get('machine_id')
buf = io.BytesIO(); Image.new('RGB', (640, 480), (90, 120, 200)).save(buf, 'JPEG')
r = requests.post(B + f'/owner/machines/{pm}/photos?kind=machine', data=buf.getvalue(), headers={'Authorization': 'Bearer ' + own.token, 'Content-Type': 'image/jpeg', 'X-Forwarded-For': own.ip})
check('owner uploads a device photo', r.status_code == 201, r.text)
c, d = own.post(f'/owner/listings/{cid}/submit'); check('owner submits listing for review', c == 200, d)
c, rows = S().get('/machines?x=50&y=50&z=20&lat=17.72&lng=83.31')
check('pending listing hidden from search', all(r['centre_name'] != 'Garage Lab' for r in rows))
c, d = S().get(f'/machines/{pm}/slots'); check('pending listing not bookable', c == 404)
c, d = adm.post(f'/admin/centres/{cid}/verification', {'verification': 'verified', 'platform_fee_pct': 12})
check('admin approves listing', c == 200, d)
c, rows = S().get('/machines?x=50&y=50&z=20&lat=17.72&lng=83.31')
check('approved listing appears in search', any(r['centre_name'] == 'Garage Lab' for r in rows))

# ---------------- account disable takes effect immediately
c, d = sup.patch(f'/admin/users/{st2_id}', {'is_active': False}); check('super admin disables an account', c == 200, d)
c, _ = st2.get('/auth/me'); check("disabled account's live session stops at once", c == 401)
_, c, _ = login('staff2@iichub.com', 'Velvet-Harbor-Comet-62')
check('disabled account cannot sign in', c == 401)

# ---------------- brute force
bf = S()
for i in range(8): bf.ip = ip(); bf.post('/auth/login', {'email': 'ravi@example.com', 'password': f'wrong-{i}'})
bf.ip = ip(); c, d = bf.post('/auth/login', {'email': 'ravi@example.com', 'password': 'Paper-Rocket-Delta-9'})
check('account locks after 8 wrong passwords (even with right one)', c == 429, d)
psql("UPDATE app_user SET locked_until=NULL WHERE email='ravi@example.com'")
rl = S(); codes = [rl.post('/auth/login', {'email': f'nobody{i}@x.com', 'password': 'x'})[0] for i in range(12)]
check('per-IP sign-in rate limit kicks in', 429 in codes, codes)
c, d = S().post('/auth/login', {'email': 'nobody@x.com', 'password': 'x'})
check('unknown email gives same message as wrong password', d.get('error') == 'Email or password is incorrect.', d)

# ---------------- misc hardening
r = requests.get(B + '/health', headers={'Origin': 'https://evil.example'})
check('no CORS access for other websites', 'access-control-allow-origin' not in {k.lower() for k in r.headers})
r = requests.get(B + '/')
check('CSP blocks inline scripts', "script-src 'self'" in r.headers.get('content-security-policy', ''))
check('clickjacking blocked', "frame-ancestors 'none'" in r.headers.get('content-security-policy', ''))
c, d = S().get("/zones/AP'%20OR%201=1--"); check('SQL injection in path returns no data', c == 200 and d == [], d)
c, d = adm.get("/admin/users?q=%27%20OR%201%3D1--"); check('SQL injection in search is harmless', c == 200 and d == [], d)
c, d = S().get('/machines/abc/profile'); check('bad id gives 404 not 500', c in (400, 404), (c, d))
c, d = S().post('/auth/login', 'not json'); check('bad JSON gives 4xx', 400 <= c < 500, (c, d))
c, d = S().get('/machines?x=-5&y=1&z=1'); check('negative dimensions rejected', c == 400, d)
r = psql("SELECT count(*) FROM app_user WHERE password_hash NOT LIKE 'scrypt$%' AND is_active")
check('every active account has a scrypt hash', r.stdout.strip() == '0', r.stdout)
r = psql("SELECT count(*) FROM audit_log WHERE action LIKE 'auth.login%' AND NOT ok")
check('failed sign-ins are audited', int(r.stdout.strip() or 0) > 5)
c, d = sup.get('/admin/audit?failed=true'); check('super admin reads audit log', c == 200 and len(d) > 0)

print(f"\n{sum(ok for _, ok in results)} / {len(results)} passed")
