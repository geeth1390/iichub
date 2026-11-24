"""Equipment listings: ownership, upload safety, privacy and the review flow.
Runs after sec_test.py on the same database (uses its admin account)."""
import io, random, sys, requests, datetime as dt
from PIL import Image

B = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3300'
results = []
def check(name, cond, extra=''):
    results.append(bool(cond))
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else '  -> ' + str(extra)[:250]))
def ip(): return f'49.{random.randint(0,255)}.{random.randint(0,255)}.{random.randint(1,254)}'

class S:
    def __init__(s, token=None): s.token, s.ip = token, ip()
    def h(s, extra=None):
        h = {'X-Forwarded-For': s.ip, **(extra or {})}
        if s.token: h['Authorization'] = 'Bearer ' + s.token
        return h
    def j(s, m, path, body=None):
        r = requests.request(m, B + path, json=body, headers=s.h())
        try: return r.status_code, r.json()
        except Exception: return r.status_code, r.text
    def raw(s, m, path, data, ctype, extra=None):
        return requests.request(m, B + path, data=data, headers=s.h({'Content-Type': ctype, **(extra or {})}))

def register(role='equipment_owner'):
    s = S(); n = random.randint(1, 10**9)
    c, d = s.j('POST', '/auth/register', {'email': f'u{n}@example.com', 'password': 'Quartz-Meadow-Pilot-58', 'name': f'User {n}', 'account_type': role})
    s.token = d['token']; s.id = d['user']['id']; return s
def login(email, pw):
    s = S(); c, d = s.j('POST', '/auth/login', {'email': email, 'password': pw}); s.token = d.get('token'); return s

def jpeg(w=800, h=600, exif=False):
    b = io.BytesIO(); im = Image.new('RGB', (w, h), (random.randint(0,255), 120, 80))
    if exif:
        e = Image.Exif(); e[0x010F] = 'SpyCam'; e[0x0110] = 'GPSModel'
        im.save(b, 'JPEG', exif=e.tobytes())
    else: im.save(b, 'JPEG')
    return b.getvalue()

LISTING = {'centre': {'name': 'Kiran Makerspace', 'district': 'Hyderabad', 'address': '4-1-22, Secret Lane, Madhapur', 'pincode': '500081', 'lat': 17.448, 'lng': 78.391, 'state_code': 'TS', 'phone': '+91 90000 11111'},
           'machine': {'process_code': 'fdm', 'make': 'Bambu Lab', 'model': 'P1S', 'rate_per_hour': 180, 'max_x_mm': 256, 'max_y_mm': 256, 'max_z_mm': 256, 'materials': ['pla', 'petg']},
           'guide': {'how_to_use': 'Send the STL a day before.', 'safety_notes': 'Closed shoes inside.', 'file_formats': ['stl', '3mf'], 'requires_operator': True, 'typical_lead_hrs': 24}}

adm = login('admin@iichub.com', 'Granite-Orchid-Pivot-73')
check('admin from the security suite can sign in', adm.token)
A, Bo, inn = register(), register(), register('innovator')

# ---- who may create
c, d = inn.j('POST', '/owner/listings', LISTING); check('innovator cannot create listings', c == 403, d)
c, d = S().j('POST', '/owner/listings', LISTING); check('anonymous cannot create listings', c == 401)
bad = {**LISTING, 'centre': {**LISTING['centre'], 'pincode': '12345'}}
c, d = A.j('POST', '/owner/listings', bad); check('invalid PIN code rejected', c == 400, d)
bad = {**LISTING, 'centre': {**LISTING['centre'], 'lat': 51.5, 'lng': -0.12}}
c, d = A.j('POST', '/owner/listings', bad); check('location outside India rejected', c == 400, d)
bad = {**LISTING, 'centre': {**LISTING['centre'], 'owner_user_id': 1}}
c, d = A.j('POST', '/owner/listings', bad); check('extra fields (owner_user_id) rejected', c == 400, d)
bad = {**LISTING, 'machine': {**LISTING['machine'], 'materials': ['unobtanium']}}
c, d = A.j('POST', '/owner/listings', bad); check('unknown material rejected cleanly', c == 400, d)
xss = {**LISTING, 'centre': {**LISTING['centre'], 'name': '<img src=x onerror=alert(1)> Lab'}}
c, d = A.j('POST', '/owner/listings', xss); check('owner A creates a draft', c == 201, d)
cid, mid = d['centre_id'], d['machine_id']

# ---- ownership
c, d = Bo.j('PATCH', f'/owner/listings/{cid}', {'centre': {'name': 'Stolen'}}); check("owner B cannot edit A's listing", c == 404, d)
r = Bo.raw('POST', f'/owner/machines/{mid}/photos?kind=machine', jpeg(), 'image/jpeg'); check("owner B cannot upload to A's machine", r.status_code == 404, r.text)
c, d = Bo.j('POST', f'/owner/listings/{cid}/submit'); check("owner B cannot submit A's listing", c == 404, d)
c, d = Bo.j('PATCH', f'/owner/listings/{cid}', {'machine_id': mid, 'machine': {'rate_per_hour': 1}}); check("owner B cannot change A's price", c == 404, d)
c, d = inn.j('GET', '/owner/listings'); check('innovator cannot read owner listings', c == 403)

# ---- submit needs a photo
c, d = A.j('POST', f'/owner/listings/{cid}/submit'); check('submit without a photo is refused with a clear reason', c == 400 and 'photo' in d.get('error', ''), d)
c, d = adm.j('POST', f'/admin/centres/{cid}/verification', {'verification': 'verified'}); check('admin cannot approve an unsubmitted draft', c == 404, d)

# ---- upload safety
r = A.raw('POST', f'/owner/machines/{mid}/photos', b'this is not an image at all, just text pretending', 'image/jpeg'); check('text file pretending to be a JPEG rejected', r.status_code == 400, r.text)
r = A.raw('POST', f'/owner/machines/{mid}/photos', b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', 'image/svg+xml'); check('SVG upload refused', r.status_code in (400, 415), r.status_code)
b = io.BytesIO(); Image.new('RGB', (50, 50)).save(b, 'PNG')
r = A.raw('POST', f'/owner/machines/{mid}/photos', b.getvalue(), 'image/png'); check('tiny image (50×50) rejected', r.status_code == 400, r.text)
b = io.BytesIO(); Image.new('1', (12000, 12000)).save(b, 'PNG')  # 144 megapixels, tiny file
r = A.raw('POST', f'/owner/machines/{mid}/photos', b.getvalue(), 'image/png'); check('decompression bomb (144 MP) rejected', r.status_code == 400, r.text)
r = A.raw('POST', f'/owner/machines/{mid}/photos', b'\xff\xd8\xff' + b'\x00' * (6 * 1024 * 1024), 'image/jpeg'); check('6 MB upload refused', r.status_code in (400, 413), r.status_code)
r = A.raw('POST', f'/owner/machines/{mid}/photos?kind=evil', jpeg(), 'image/jpeg'); check('unknown photo kind rejected', r.status_code == 400)
src = jpeg(exif=True); check('test photo really contains camera data', b'SpyCam' in src)
r = A.raw('POST', f'/owner/machines/{mid}/photos?kind=machine&caption=Front', src, 'image/jpeg'); check('real photo accepted', r.status_code == 201, r.text)
pid = r.json().get('id')

# ---- photo privacy before approval
r = requests.get(B + f'/photos/{pid}'); check('draft photo is not public', r.status_code == 404)
r = requests.get(B + f'/photos/{pid}', headers=Bo.h()); check('another owner cannot see the draft photo', r.status_code == 404)
r = requests.get(B + f'/photos/{pid}', headers=A.h()); check('owner sees own draft photo', r.status_code == 200 and r.headers['content-type'] == 'image/webp')
check('camera/GPS data stripped from stored photo', b'SpyCam' not in r.content and b'Exif' not in r.content and b'GPSModel' not in r.content)
check('private photo not cached by browsers or proxies', 'no-store' in r.headers.get('cache-control', ''))
r = requests.get(B + f'/photos/{pid}', headers=adm.h()); check('admin sees draft photo for review', r.status_code == 200)

# ---- SOP PDF
r = A.raw('PUT', f'/owner/machines/{mid}/sop', b'not a pdf', 'application/pdf'); check('non-PDF refused', r.status_code == 400, r.text)
evil = b'%PDF-1.4\n1 0 obj << /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF\n'
r = A.raw('PUT', f'/owner/machines/{mid}/sop', evil, 'application/pdf'); check('PDF with JavaScript refused', r.status_code == 400 and 'scripts' in r.text, r.text)
good = b'%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'
r = A.raw('PUT', f'/owner/machines/{mid}/sop', good, 'application/pdf', {'X-Filename': '../../etc/passwd'}); check('clean PDF accepted', r.status_code == 200, r.text)
check('dangerous filename neutralised', r.json().get('filename') == 'operating-procedure.pdf', r.json())
r = requests.get(B + f'/machines/{mid}/sop'); check('draft SOP is not public', r.status_code == 404)

# ---- photo limit, including a parallel burst
import concurrent.futures as cf
with cf.ThreadPoolExecutor(12) as ex:
    codes = list(ex.map(lambda _: A.raw('POST', f'/owner/machines/{mid}/photos?kind=sample_output', jpeg(400, 300), 'image/jpeg').status_code, range(12)))
c, d = A.j('GET', '/owner/listings'); n = len([x for x in d if x['id'] == cid][0]['machines'][0]['photos'])
check('photo limit (8) holds even with 12 parallel uploads', n == 8 and codes.count(201) == 7, (n, codes))

# ---- submit, review with changes, resubmit, approve
c, d = A.j('POST', f'/owner/listings/{cid}/submit'); check('owner submits', c == 200, d)
c, d = A.j('POST', f'/owner/listings/{cid}/submit'); check('double submit refused', c == 409, d)
c, rows = S().j('GET', '/machines?x=20&y=20&z=20&lat=17.448&lng=78.391'); check('pending listing not in search', all(r['machine_id'] != mid for r in rows))
c, d = adm.j('POST', f'/admin/centres/{cid}/verification', {'verification': 'changes_requested'}); check('"ask for changes" needs a note', c == 400, d)
c, d = adm.j('POST', f'/admin/centres/{cid}/verification', {'verification': 'changes_requested', 'note': 'Please add a clearer front photo.'}); check('admin asks for changes with a note', c == 200, d)
c, d = A.j('GET', '/owner/listings'); l = [x for x in d if x['id'] == cid][0]
check('owner sees status and the note', l['verification'] == 'changes_requested' and 'clearer' in (l['review_note'] or ''), l.get('verification'))
c, d = A.j('POST', f'/owner/listings/{cid}/submit'); check('owner resubmits after changes', c == 200, d)
c, d = adm.j('GET', '/admin/listings?status=open'); check('admin review queue lists it with photos and procedure', any(x['id'] == cid and len(x['machines'][0]['photos']) == 8 and x['machines'][0]['guide']['safety_notes'] for x in d))
c, d = adm.j('POST', f'/admin/centres/{cid}/verification', {'verification': 'verified', 'platform_fee_pct': 12}); check('admin approves', c == 200, d)
c, rows = S().j('GET', '/machines?x=20&y=20&z=20&mat=petg&lat=17.448&lng=78.391'); check('approved private machine found for a declared material (no stock ledger)', any(r['machine_id'] == mid for r in rows))
r = requests.get(B + f'/photos/{pid}'); check('approved photo is public and cacheable', r.status_code == 200 and 'public' in r.headers.get('cache-control', ''))
r = requests.get(B + f'/machines/{mid}/sop'); check('approved SOP downloads as an attachment in a sandbox', r.status_code == 200 and 'attachment' in r.headers.get('content-disposition', '') and 'sandbox' in r.headers.get('content-security-policy', ''))

# ---- address privacy
c, p = S().j('GET', f'/machines/{mid}/profile'); check('anonymous visitor does not see the street address or phone', 'address' not in p and 'centre_phone' not in p and p.get('address_hidden'), {k: p.get(k) for k in ('address', 'centre_phone')})
check('anonymous visitor gets only an approximate location', abs(float(p['lat']) - 17.448) < 0.02 and float(p['lat']) != 17.448)
check('profile shows photos, procedure and materials', len(p['photos']) == 8 and p['how_to_use'] and p['sop'] and len(p['materials']) == 2)
c, p = inn.j('GET', f'/machines/{mid}/profile'); check('signed-in innovator without a booking: address still hidden', 'address' not in p)
c, slots = S().j('GET', f'/machines/{mid}/slots?days=7')
c, d = inn.j('POST', '/bookings', {'machine_id': mid, 'slot_start': slots[0]['slot_start'], 'slot_end': slots[0]['slot_end'], 'title': 'Bracket'})
check('innovator books the private machine', c == 201, d)
c, p = inn.j('GET', f'/machines/{mid}/profile'); check('after booking, the innovator sees the full address', 'Secret Lane' in (p.get('address') or ''))
c, jobs = inn.j('GET', '/my/jobs'); check('my jobs shows the address and phone after booking', 'Secret Lane' in (jobs[0].get('centre_address') or '') and jobs[0].get('centre_phone'))
c, p = A.j('GET', f'/machines/{mid}/profile'); check('owner sees own address', 'Secret Lane' in (p.get('address') or ''))

# ---- editing a live listing sends it back for review
c, d = A.j('PATCH', f'/owner/listings/{cid}', {'machine_id': mid, 'machine': {'rate_per_hour': 1}})
check('owner edits a live listing → back to review', c == 200 and d.get('back_to_review'), d)
c, rows = S().j('GET', '/machines?x=20&y=20&z=20&lat=17.448&lng=78.391'); check('edited listing hidden until re-approved (no bait-and-switch)', all(r['machine_id'] != mid for r in rows))
r = requests.get(B + f'/photos/{pid}'); check('its photos go private again', r.status_code == 404)
c, d = adm.j('POST', f'/admin/centres/{cid}/verification', {'verification': 'verified'}); check('admin re-approves', c == 200)
c, d = adm.j('POST', f'/admin/centres/{cid}/verification', {'verification': 'suspended'}); check('admin can suspend a live listing', c == 200)
c, d = A.j('PATCH', f'/owner/listings/{cid}', {'centre': {'name': 'Renamed'}}); check('suspended listing cannot be edited by the owner', c == 409, d)
c, d = adm.j('POST', f'/admin/centres/{cid}/verification', {'verification': 'verified'})

# ---- listing limit under a parallel burst
C = register()
with cf.ThreadPoolExecutor(14) as ex:
    codes = list(ex.map(lambda i: requests.post(B + '/owner/listings', json={**LISTING, 'centre': {**LISTING['centre'], 'name': f'Lab {i}'}},
                                                headers={'Authorization': 'Bearer ' + C.token, 'X-Forwarded-For': ip()}).status_code, range(14)))
c, d = C.j('GET', '/owner/listings'); check('listing limit (10) holds under 14 parallel creates', len(d) == 10 and codes.count(201) == 10, (len(d), sorted(codes)))

# ---- audit trail
c, d = login('owner@iichub.com', 'Monsoon-Lantern-Quarry-48').j('GET', '/admin/audit?action=listing.')
check('listing actions are in the audit log', c == 200 and any(a['action'] == 'listing.photo_add' for a in d) and any(a['action'] == 'listing.submit' for a in d))

print(f"\n{sum(results)} / {len(results)} passed")
