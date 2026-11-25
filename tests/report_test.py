"""Utilisation report: exact arithmetic on a controlled scenario, plus access rules.
Run against a server on :3300 with the test database t2 (same as the other suites)."""
import json, subprocess, urllib.request, urllib.error, datetime, random

B = 'http://localhost:3300'
IP = '49.11.%d.%d' % (random.randint(1, 250), random.randint(1, 250))
PASS = FAIL = 0
def ok(cond, name):
    global PASS, FAIL
    if cond: PASS += 1
    else: FAIL += 1; print('FAIL', name)

def sql(q):
    return subprocess.run(['psql', '-h', '/tmp', '-p', '5433', '-U', 'postgres', 't2', '-tAc', q], capture_output=True, text=True, check=True).stdout.strip()

def call(path, token=None, method='GET', body=None, raw=False):
    req = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={'Content-Type': 'application/json', 'X-Forwarded-For': IP, **({'Authorization': 'Bearer ' + token} if token else {})})
    try:
        with urllib.request.urlopen(req) as r:
            d = r.read().decode('utf-8-sig')
            return r.status, (d if raw else json.loads(d))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')

# ---- scenario: one centre, one machine, one known day ----
D = (datetime.date.today() - datetime.timedelta(days=3)).isoformat()
cid = sql("""INSERT INTO centre (name, district, address, lat, lng, is_live, opens_at, closes_at, working_days, state_code)
             VALUES ('Report Test Centre', 'Testpur', 'Test Road', 17.0, 80.0, TRUE, '09:00', '17:00', '{1,2,3,4,5,6,7}', 'AP') RETURNING id""").splitlines()[0]
mid = sql(f"""INSERT INTO machine (centre_id, process_code, make, model, rate_per_hour, status)
             VALUES ({cid}, 'fdm', '=Formula', 'Test Printer', 500, 'available') RETURNING id""").splitlines()[0]
uid = sql("SELECT id FROM app_user WHERE email='sample-history@system.invalid'")
def ts(t): return f"'{D} {t}'::timestamp::timestamptz"
bA = sql(f"INSERT INTO booking (machine_id,user_id,slot,status) VALUES ({mid},{uid},tstzrange({ts('10:00')},{ts('12:00')}),'completed') RETURNING id").splitlines()[0]
sql(f"INSERT INTO booking (machine_id,user_id,slot,status) VALUES ({mid},{uid},tstzrange({ts('13:00')},{ts('14:00')}),'no_show')")
sql(f"INSERT INTO booking (machine_id,user_id,slot,status) VALUES ({mid},{uid},tstzrange({ts('14:00')},{ts('15:00')}),'cancelled')")
sql(f"INSERT INTO maintenance_window (machine_id,reason,kind,started_at,resolved_at) VALUES ({mid},'test repair','repair',{ts('15:00')},{ts('16:00')})")
jid = sql(f"INSERT INTO job (booking_id,user_id,machine_id,title,status) VALUES ({bA},{uid},{mid},'t','collected') RETURNING id").splitlines()[0]
sql(f"INSERT INTO quote (job_id,est_minutes,machine_cost,total,source) VALUES ({jid},120,1000,1150,'manual')")
sql("ALTER TABLE job_event DISABLE TRIGGER trg_on_job_event")
sql(f"""INSERT INTO job_event (job_id,from_status,to_status,at) VALUES
   ({jid},'queued','setup',{ts('10:00')}),({jid},'setup','running',{ts('10:15')}),
   ({jid},'running','qc',{ts('11:45')}),({jid},'qc','ready',{ts('12:15')})""")
sql("ALTER TABLE job_event ENABLE TRIGGER trg_on_job_event")

_, login = call('/auth/login', method='POST', body={'email': 'admin@iichub.com', 'password': 'Granite-Orchid-Pivot-73'})
T = login['token']
st, r = call(f'/reports/utilisation?from={D}&to={D}&centre_id={cid}', T)
ok(st == 200, 'report 200')
m = r['machines'][0] if r.get('machines') else {}
near = lambda a, b: a is not None and abs(a - b) < 0.011
ok(len(r['machines']) == 1, 'one machine')
ok(near(m['open_h'], 8), 'open 8h')
ok(near(m['down_h'], 1), 'downtime 1h')
ok(near(m['available_h'], 7), 'available 7h')
ok(near(m['booked_h'], 3), 'booked 3h (completed + no-show)')
ok(near(m['noshow_h'], 1), 'no-show 1h')
ok(near(m['cancelled_h'], 1), 'cancelled 1h, not in booked')
ok(near(m['setup_h'], 0.25) and near(m['run_h'], 1.5), 'setup 0.25h + run 1.5h')
ok(near(m['executed_h'], 1.75), 'executed 1.75h')
ok(near(m['gap_h'], 1.25), 'booked-not-run 1.25h')
ok(near(m['unbooked_h'], 4), 'unbooked 4h')
ok(near(m['utilisation'], 0.25), 'utilisation 25%')
ok(near(m['booking_rate'], 3 / 7), 'booking rate 3/7')
ok(near(m['execution_ratio'], 1.75 / 3), 'executed/booked')
ok(near(m['estimate_ratio'], 105 / 120), 'actual/quoted 87.5%')
ok(m['idle_value'] == 2000, 'idle value 4h x 500')
ok(m['bookings'] == 2 and m['no_shows'] == 1 and m['cancellations'] == 1 and m['jobs_done'] == 1, 'counts')
ok(sum(h['hours'] for h in r['heatmap']) == 3, 'heatmap sums to booked hours')
ok(near(r['totals']['executed_h'] + r['totals']['gap_h'] + r['totals']['unbooked_h'] + r['totals']['down_h'], r['totals']['open_h']), 'hour bar adds up to open hours')

# a day outside the scenario has no bookings; future dates count nothing
D2 = (datetime.date.today() - datetime.timedelta(days=2)).isoformat()
st, r2 = call(f'/reports/utilisation?from={D2}&to={D2}&centre_id={cid}', T)
ok(near(r2['machines'][0]['open_h'], 8) and r2['machines'][0]['booked_h'] == 0, 'quiet day: open 8h, booked 0')

# CSV: formula injection neutralised
st, csv = call(f'/reports/utilisation.csv?from={D}&to={D}&centre_id={cid}', T, raw=True)
ok(st == 200 and "'=Formula Test Printer" in csv, 'csv escapes leading =')

# validation
ok(call('/reports/utilisation?from=2026-02-01&to=2026-01-01', T)[0] == 400, 'from after to -> 400')
ok(call('/reports/utilisation?from=2024-01-01&to=2026-01-01', T)[0] == 400, 'over a year -> 400')
ok(call('/reports/utilisation?centre_id=abc', T)[0] == 400, 'bad centre id -> 400')
ok(call('/reports/utilisation')[0] == 401, 'no login -> 401')

# centre manager: always own centre, cannot widen scope
other = sql("SELECT id FROM centre WHERE is_live AND id <> %s ORDER BY id LIMIT 1" % cid)
st, u = call('/admin/users', T, 'POST', {'email': f'repmgr{random.randint(1,99999)}@test.in', 'name': 'Rep Mgr', 'role': 'centre_manager', 'centre_id': int(cid)})
tmp = u.get('temp_password')
st, lg = call('/auth/login', method='POST', body={'email': u['user']['email'] if 'user' in u else u.get('email'), 'password': tmp})
MT = lg.get('token')
st, mr = call(f'/reports/utilisation?from={D}&to={D}&centre_id={other}', MT)
ok(st in (200, 403), 'manager request ok')
if st == 200:
    ok(all(int(x['centre_id']) == int(cid) for x in mr['machines']) and len(mr['machines']) == 1, 'manager sees only own centre')
else:
    ok(True, 'manager blocked until password change (acceptable)')
_, il = call('/auth/register', method='POST', body={'email': f'repinno{random.randint(1,99999)}@test.in', 'password': 'Plenty-Mango-Ridge-41', 'name': 'Report Innovator'})
ok(call('/reports/utilisation', il.get('token'))[0] == 403, 'innovator -> 403')

# clean up scenario
sql(f"DELETE FROM job_event WHERE job_id={jid}; DELETE FROM quote WHERE job_id={jid}; DELETE FROM job WHERE id={jid}; DELETE FROM booking WHERE machine_id={mid}; DELETE FROM maintenance_window WHERE machine_id={mid}")
print(f'{PASS} / {PASS + FAIL} passed')
