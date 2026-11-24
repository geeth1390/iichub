"""Browser test of the Bold IICHUB screens: owner lists a machine with photos and
an SOP, admin approves it in the console, the public finds and views it; plus
phone layouts, XSS safety and console/CSP errors on every screen."""
import asyncio, random, io, os
from PIL import Image
from playwright.async_api import async_playwright

B = 'http://localhost:3300'
R = []
def check(n, c, x=''):
    R.append(bool(c)); print(('PASS ' if c else 'FAIL ') + n + ('' if c else '  -> ' + str(x)[:300]))

os.makedirs('/tmp/up', exist_ok=True)
Image.new('RGB', (1200, 900), (230, 120, 60)).save('/tmp/up/printer.jpg', 'JPEG')
Image.new('RGB', (900, 700), (60, 90, 200)).save('/tmp/up/entrance.png', 'PNG')
open('/tmp/up/sop.pdf', 'wb').write(b'%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
TAG = random.randint(1000, 9999)
LAB = f'<img src=x onerror=alert(1)> Lab {TAG}'

async def poll(pg, expr, timeout=10000):
    for _ in range(timeout // 200):
        if await pg.evaluate(expr): return True
        await asyncio.sleep(0.2)
    raise TimeoutError('condition not met: ' + expr)

async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch()
        problems, alerts = [], []
        async def newpage(w=1366, h=900, scale=1):
            ctx = await br.new_context(viewport={'width': w, 'height': h}, device_scale_factor=scale,
                                       extra_http_headers={'X-Forwarded-For': f'49.{random.randint(1,250)}.{random.randint(1,250)}.{random.randint(1,250)}'})
            pg = await ctx.new_page()
            pg.on('pageerror', lambda e: problems.append('pageerror: ' + str(e)))
            pg.on('console', lambda m: problems.append('console: ' + m.text) if m.type == 'error' and 'ERR_TUNNEL' not in m.text and 'fonts.g' not in m.text else None)
            async def on_dialog(d):
                if d.type == 'alert': alerts.append(d.message)
                await d.accept()
            pg.on('dialog', lambda d: asyncio.ensure_future(on_dialog(d)))
            return pg

        # ---------- owner registers and lists a machine ----------
        pg = await newpage()
        await pg.goto(B + '/#/list')
        await pg.wait_for_selector('.modal.on')
        await pg.click('a:has-text("Create an account")')
        check('sign-up from "List your equipment" pre-ticks the owner box', await pg.is_checked('#regOwner'))
        await pg.fill('#regName', 'Ramesh Kumar'); await pg.fill('#regEmail', f'ramesh{TAG}@example.com')
        await pg.fill('#regPassword', 'Bronze-Spindle-Harbor-27'); await pg.click('#regBtn')
        await pg.wait_for_selector('#wName', timeout=8000)
        check('owner lands in the listing wizard after sign-up', True)
        await pg.fill('#wName', LAB); await pg.fill('#wAddr', 'Plot 9, Autonagar Industrial Estate')
        await pg.fill('#wDist', 'Visakhapatnam'); await pg.fill('#wPin', '530012')
        await pg.click('#wNext'); await pg.wait_for_timeout(300)
        check('wizard asks for the map position before continuing', 'location' in (await pg.inner_text('#wMsg')).lower(), await pg.inner_text('#wMsg'))
        await pg.fill('#wLat', '17.69'); await pg.fill('#wLng', '83.21'); await pg.fill('#wPhone', '+91 98480 12345')
        await pg.click('#wNext'); await pg.wait_for_selector('#wMake')
        await pg.fill('#wMake', 'Bambu Lab'); await pg.fill('#wModel', f'X1C-{TAG}')
        await pg.fill('#wX', '256'); await pg.fill('#wY', '256'); await pg.fill('#wZ', '256'); await pg.fill('#wRate', '220')
        await pg.click('#wNext'); await pg.wait_for_timeout(300)
        check('wizard insists on at least one material', 'material' in (await pg.inner_text('#wMsg')).lower())
        await pg.check('.wMat[value="pla"]'); await pg.check('.wMat[value="petg"]')
        await pg.click('#wNext'); await pg.wait_for_selector('.wFile', timeout=8000)
        check('draft saved and photos step opens', True)
        await pg.set_input_files('.wFile[data-kind="machine"]', '/tmp/up/printer.jpg')
        await pg.wait_for_selector('#wPhotos figure img', timeout=10000)
        await pg.set_input_files('.wFile[data-kind="location"]', '/tmp/up/entrance.png')
        await poll(pg, "document.querySelectorAll('#wPhotos figure').length===2", 10000)
        await poll(pg, "[...document.querySelectorAll('#wPhotos img')].every(i=>i.naturalWidth>0)", 10000)
        check('two photos uploaded and previewed (private, via the session)', True)
        await pg.screenshot(path='/home/claude/tools/ui_wizard_photos.png', full_page=True)
        await pg.click('#wNext'); await pg.wait_for_selector('#wHow')
        await pg.fill('#wHow', 'Send the STL a day before. Our operator prints and removes supports.')
        await pg.fill('#wSafety', 'Closed shoes inside the lab.'); await pg.fill('#wFormats', 'STL, 3MF'); await pg.fill('#wLead', '24')
        await pg.set_input_files('#wSop', '/tmp/up/sop.pdf'); await pg.wait_for_selector('text=Replace sop.pdf', timeout=8000)
        check('SOP PDF attached', True)
        await pg.click('#wNext'); await pg.wait_for_selector('#wSubmit')
        checks = await pg.inner_text('.navy-panel')
        check('review step shows every requirement met', checks.count('✓') == 5, checks)
        await pg.click('#wSubmit'); await pg.wait_for_selector('.listing', timeout=8000)
        txt = await pg.inner_text('#listingsView')
        check('My listings shows "Waiting for review"', 'Waiting for review' in txt, txt[:200])
        check('lab name with HTML is shown as plain text', '<img src=x onerror=alert(1)>' in txt)
        await pg.screenshot(path='/home/claude/tools/ui_listings.png', full_page=True)

        # ---------- admin approves in the console ----------
        ad = await newpage()
        await ad.goto(B + '/admin')
        await ad.fill('#emailInput', 'owner@iichub.com'); await ad.fill('#passwordInput', 'Monsoon-Lantern-Quarry-48'); await ad.click('#loginBtn')
        await ad.wait_for_selector('nav.tabs button:has-text("Listings to review")', timeout=8000)
        await ad.click('nav.tabs button:has-text("Listings to review")')
        card = ad.locator('#lList .tablewrap', has_text=f'X1C-{TAG}')
        await card.wait_for(timeout=8000)
        await poll(ad, "[...document.querySelectorAll('#lList img')].some(i=>i.naturalWidth>0)", 10000)
        check('admin sees the owner\'s photos, procedure and SOP button', 'Closed shoes' in await card.inner_text() and await card.locator('text=Download SOP').count() == 1)
        await ad.screenshot(path='/home/claude/tools/ui_admin_review.png', full_page=True)
        await card.locator('button:has-text("Ask for changes")').click(); await ad.wait_for_timeout(400)
        check('"Ask for changes" without a note is blocked in the UI', 'note' in (await ad.inner_text('#toast')).lower())
        await card.locator('button:has-text("Approve")').click()
        await ad.wait_for_selector('#toast:has-text("Approved")', timeout=8000)
        check('admin approves from the console', True)

        # ---------- public finds it ----------
        pub = await newpage()
        await pub.goto(B + '/'); await pub.wait_for_selector('.card')
        found = pub.locator('.card', has_text=f'X1C-{TAG}')
        await found.wait_for(timeout=8000)
        check('approved machine appears in public search with a "Private lab" tag', 'Private lab' in await found.inner_text())
        await poll(pub, "[...document.querySelectorAll('.card img')].some(i=>i.naturalWidth>0)", 8000)
        check('its photo shows in the results', True)
        await found.locator('text=Details').click(); await pub.wait_for_selector('.mhead h1')
        mt = await pub.inner_text('#machineView')
        check('machine page shows procedure, safety and SOP link', 'Send the STL' in mt and 'Closed shoes' in mt and 'Download the full procedure' in mt)
        check('machine page hides the street address before booking', 'Autonagar' not in mt and 'shared once your booking' in mt)
        await pub.screenshot(path='/home/claude/tools/ui_machine_page.png', full_page=True)
        check('no script from the lab name ever ran (XSS)', not alerts, alerts)

        # ---------- phone layouts ----------
        ph = await newpage(390, 844, 2)
        for name, path, sel in (('home', '/', '.card'), ('machine page', pub.url.replace(B, ''), '.mhead h1')):
            await ph.goto(B + path); await ph.wait_for_selector(sel); await ph.wait_for_timeout(400)
            w = await ph.evaluate('document.documentElement.scrollWidth')
            check(f'phone: {name} has no sideways scroll', w <= 390, w)
        await ph.screenshot(path='/home/claude/tools/ui_phone_machine.png', full_page=True)
        await ph.goto(B + '/manager'); w = await ph.evaluate('document.documentElement.scrollWidth'); check('phone: manager sign-in fits', w <= 390, w)
        await ph.goto(B + '/admin'); w = await ph.evaluate('document.documentElement.scrollWidth'); check('phone: admin sign-in fits', w <= 390, w)

        check('no JavaScript errors or blocked scripts on any screen', not problems, problems[:5])
        await br.close()
    print(f'{sum(R)}/{len(R)} passed')

asyncio.run(main())
