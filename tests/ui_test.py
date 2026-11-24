import asyncio, re, random
from playwright.async_api import async_playwright
B='http://localhost:3300'
R=[]
TITLE=f'Sensor housing {random.randint(1000,9999)}'
def check(n,c,x=''):
    R.append(c); print(('PASS ' if c else 'FAIL ')+n+('' if c else '  -> '+str(x)[:300]))
async def main():
    async with async_playwright() as p:
        br=await p.chromium.launch()
        errs=[]
        def ctxpage(ctx):
            async def mk():
                pg=await ctx.new_page()
                pg.on('pageerror',lambda e: errs.append('pageerror '+str(e)))
                pg.on('console',lambda m: errs.append('console '+m.text) if m.type=='error' and 'ERR_TUNNEL' not in m.text else None)
                return pg
            return mk
        ip=f'49.1.{random.randint(0,255)}.{random.randint(1,250)}'
        ctx=await br.new_context(extra_http_headers={'X-Forwarded-For':ip},viewport={'width':1280,'height':900})
        pg=await ctxpage(ctx)()
        # ---------- innovator
        await pg.goto(B+'/'); await pg.wait_for_selector('.card')
        n=await pg.locator('.card').count(); check('home shows machine matches',n>0,n)
        await pg.click('#accountBtn'); await pg.click('text=Create an account')
        await pg.fill('#regName','Priya Nair'); await pg.fill('#regEmail',f'priya{random.randint(1,99999)}@example.com')
        await pg.fill('#regPassword','Jasmine-Kettle-Orbit-31'); await pg.click('#regBtn')
        await pg.wait_for_selector('#accountBtn:has-text("Priya")'); check('register via UI signs in',True)
        await pg.locator('button.book:not([disabled])').first.click()
        await pg.wait_for_selector('button.slot'); await pg.locator('button.slot').nth(1).click()
        await pg.fill('#jobTitle',TITLE); await pg.select_option('#jobMaterial','pla')
        await pg.click('#confirmBookingBtn'); await pg.wait_for_selector('text=Booking confirmed',timeout=8000)
        check('book a machine via UI',True)
        await pg.screenshot(path='/home/claude/tools/ui_booked.png')
        await pg.click('text=View My Jobs'); await pg.wait_for_selector('.job'); check('my jobs lists booking', await pg.locator('.job').count()>=1)
        await pg.click('#accountBtn') if not await pg.locator('.modal.on').count() else None
        # ---------- admin
        actx=await br.new_context(extra_http_headers={'X-Forwarded-For':f'49.2.{random.randint(0,255)}.9'},viewport={'width':1366,'height':900})
        ap=await ctxpage(actx)()
        await ap.goto(B+'/admin'); await ap.fill('#emailInput','owner@iichub.com'); await ap.fill('#passwordInput','Monsoon-Lantern-Quarry-48'); await ap.click('#loginBtn')
        await ap.wait_for_selector('nav.tabs button:has-text("Overview")',timeout=8000)
        check('super admin signs into admin console',True)
        await ap.wait_for_selector('.card'); await ap.screenshot(path='/home/claude/tools/ui_admin_overview.png',full_page=True)
        await ap.click('nav.tabs button:has-text("Accounts")'); await ap.wait_for_selector('#userTable table')
        await ap.click('text=+ New account'); await ap.fill('#fName','Kiran Staff'); await ap.fill('#fEmail',f'kiran{random.randint(1,99999)}@iichub.com')
        await ap.select_option('#fRole','centre_staff'); await ap.select_option('#fCentre','1'); await ap.click('#mBtn')
        await ap.wait_for_selector('.secret'); temp=(await ap.inner_text('.secret')).strip()
        check('admin console creates staff and shows temp password', bool(re.match(r'^\w{4}-\w{4}-\w{4}-\w{4}$',temp)), temp)
        email=await ap.eval_on_selector('.shead h3','e=>e.textContent'); email=email.split(' for ')[-1].strip()
        await ap.click('text=Done'); await ap.screenshot(path='/home/claude/tools/ui_admin_users.png',full_page=True)
        await ap.click('nav.tabs button:has-text("Centres")'); await ap.wait_for_selector('text=Private listings')
        await ap.screenshot(path='/home/claude/tools/ui_admin_centres.png')
        await ap.click('nav.tabs button:has-text("Machines")'); await ap.wait_for_selector('#machineTable table')
        await ap.locator('[data-act="editMachine"][data-arg]').nth(1).click(); await ap.wait_for_selector('#xRate')
        await ap.screenshot(path='/home/claude/tools/ui_admin_machine.png')
        await ap.click('text=Cancel')
        await ap.click('nav.tabs button:has-text("Audit")'); await ap.wait_for_selector('#auditTable table'); check('audit log renders',True)
        # ---------- manager: new staff signs in, sets password, prices job
        mctx=await br.new_context(extra_http_headers={'X-Forwarded-For':f'49.3.{random.randint(0,255)}.7'},viewport={'width':1280,'height':900})
        mp=await ctxpage(mctx)()
        await mp.goto(B+'/manager'); await mp.fill('#emailInput',email); await mp.fill('#passwordInput',temp); await mp.click('#loginBtn')
        await mp.wait_for_selector('#passwordStep:not(.hidden)'); check('staff forced to set password at first sign-in',True)
        await mp.fill('#tempInput',temp); await mp.fill('#newInput','Marigold-Piston-Glacier-90'); await mp.fill('#new2Input','Marigold-Piston-Glacier-90'); await mp.click('#setPwBtn')
        await mp.wait_for_selector('.job',timeout=8000); check('staff sees centre queue after setting password',True)
        await mp.locator(f'.job:has-text("{TITLE}") [data-act="openQuote"]').first.click(); await mp.fill('#q_min','45'); await mp.fill('#q_g','30'); await mp.click('#sendQuoteBtn')
        await mp.wait_for_selector('#toast.on'); t=await mp.inner_text('#toast'); check('staff prices a job in the console','Quote saved' in t,t)
        await mp.screenshot(path='/home/claude/tools/ui_manager.png')
        # innovator accepts
        await pg.goto(B+'/'); await pg.wait_for_selector('.card'); await pg.click('header [data-act=openMyJobs]')
        await pg.wait_for_selector('.job')
        if await pg.locator('[data-act="acceptQuote"]').count():
            pg.once('dialog',lambda d: asyncio.ensure_future(d.accept()))
            await pg.locator('[data-act="acceptQuote"]').first.click(); await pg.wait_for_selector('#toast.on')
            check('innovator accepts quote in UI','accepted' in (await pg.inner_text('#toast')).lower())
        else: check('innovator sees quote to accept',False,'no accept button (quote may be on a different job)')
        # mobile
        mob=await br.new_context(viewport={'width':375,'height':800},extra_http_headers={'X-Forwarded-For':'49.4.4.4'})
        mpg=await ctxpage(mob)()
        await mpg.goto(B+'/'); await mpg.wait_for_selector('.card')
        w=await mpg.evaluate('document.documentElement.scrollWidth'); check('no sideways scroll on phone',w<=375,w)
        await mpg.goto(B+'/admin'); w=await mpg.evaluate('document.documentElement.scrollWidth'); check('admin login fits phone',w<=375,w)
        await mpg.screenshot(path='/home/claude/tools/ui_mobile_admin.png')
        check('no JavaScript errors or blocked scripts', not errs, errs)
        await br.close()
    print(f'{sum(R)}/{len(R)} passed')
asyncio.run(main())
