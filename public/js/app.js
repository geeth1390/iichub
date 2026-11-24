'use strict';

const TOKEN_KEY = 'protohub_customer_token';

let token = sessionStorage.getItem(TOKEN_KEY) || '';
let currentUser = null;
let pendingMachineId = null;
let currentMachine = null;
let selectedSlot = null;
let currentSlots = [];

const $ = id => document.getElementById(id);
const val = id => $(id).value;

const api = makeApi({
  getToken: () => token,
  onSessionEnded: () => { clearSession(); }
});

function showToast(message){
  const el=$('toast');
  el.textContent=message;
  el.classList.add('on');
  setTimeout(()=>el.classList.remove('on'),3500);
}

function openModal(html){
  $('sheet').innerHTML=html;
  $('modal').classList.add('on');
  const first=$('sheet').querySelector('input:not([type=hidden])');
  if(first) setTimeout(()=>first.focus(),30);
}
function closeM(){
  $('modal').classList.remove('on');
}
$('modal').addEventListener('click',e=>{
  if(e.target.id==='modal') closeM();
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape') closeM();
});

function setSession(result){
  token=result.token;
  sessionStorage.setItem(TOKEN_KEY,token);
}
function clearSession(){
  token='';
  currentUser=null;
  sessionStorage.removeItem(TOKEN_KEY);
  updateAccountButton();
}

function updateAccountButton(){
  $('accountBtn').textContent=currentUser
    ? 'Account · '+(currentUser.name||'Me')
    : 'Sign in';
}

async function loadSession(){
  if(!token){updateAccountButton();return;}
  try{
    currentUser=await api('/auth/me');
  }catch(e){
    clearSession();
  }
  updateAccountButton();
  if(currentUser && currentUser.must_change_password) showChangePassword(true);
}

function accountAction(){
  if(currentUser) showAccount();
  else { pendingMachineId=null; showLogin(); }
}

function msg(id,text,ok){
  const el=$(id);
  if(!el) return;
  el.textContent=text||'';
  el.className='message'+(ok?' ok':'');
}

const AFFILIATIONS=[['student','Student'],['startup','Startup'],['industry','Industry'],['individual','Individual'],['institution','Institution']];

function showLogin(note){
  openModal(`
    <div data-form>
    <div class="shead">
      <h3>Sign in</h3>
      <p>Sign in to book machines and follow your jobs.</p>
    </div>
    <div class="sbody">
      <div class="field">
        <label for="loginEmail">Email</label>
        <input id="loginEmail" type="email" autocomplete="username" maxlength="254">
      </div>
      <div class="field">
        <label for="loginPassword">Password</label>
        <input id="loginPassword" type="password" autocomplete="current-password" maxlength="128">
      </div>
      <div id="loginMessage" class="message">${escapeHtml(note||'')}</div>
      <p class="links">
        <a href="#" data-act="showRegister">Create an account</a> ·
        <a href="#" data-act="showForgot">Forgot password?</a>
      </p>
    </div>
    <div class="sfoot">
      <button class="ghost" data-act="closeM">Cancel</button>
      <button class="go" id="loginBtn" data-act="doLogin">Sign in</button>
    </div>
    </div>
  `);
}

async function doLogin(){
  const email=$('loginEmail').value.trim();
  const password=$('loginPassword').value;
  if(!email||!password){ msg('loginMessage','Enter your email and password.'); return; }
  const btn=$('loginBtn'); btn.disabled=true;
  try{
    setSession(await api('/auth/login',{method:'POST',body:{email,password}}));
    await afterSignIn('Signed in.');
  }catch(e){
    msg('loginMessage',e.message);
    btn.disabled=false;
  }
}

async function afterSignIn(text){
  currentUser=await api('/auth/me');
  updateAccountButton();
  if(currentUser.must_change_password){ showChangePassword(true); return; }
  if(['centre_staff','centre_manager'].includes(currentUser.role)){
    closeM(); showToast('Staff accounts use the manager console.'); setTimeout(()=>location.href='/manager',900); return;
  }
  if(['apis_admin','super_admin'].includes(currentUser.role)){
    closeM(); showToast('Opening the admin console…'); setTimeout(()=>location.href='/admin',900); return;
  }
  closeM();
  showToast(text);
  if(/^#\/list/.test(location.hash)) route();
  if(pendingMachineId!==null){
    const id=pendingMachineId;
    pendingMachineId=null;
    await openSlots(id);
  }
}

function showRegister(){
  openModal(`
    <div data-form>
    <div class="shead">
      <h3>Create your account</h3>
      <p>Free for students, startups and industry.</p>
    </div>
    <div class="sbody">
      <div class="field"><label for="regName">Full name</label>
        <input id="regName" type="text" autocomplete="name" maxlength="80"></div>
      <div class="field"><label for="regEmail">Email</label>
        <input id="regEmail" type="email" autocomplete="email" maxlength="254"></div>
      <div class="field"><label for="regPassword">Password (at least 10 characters)</label>
        <input id="regPassword" type="password" autocomplete="new-password" maxlength="128"></div>
      <div class="form-grid">
        <div class="field"><label for="regAff">You are</label>
          <select id="regAff">${AFFILIATIONS.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></div>
        <div class="field"><label for="regPhone">Phone (optional)</label>
          <input id="regPhone" type="tel" autocomplete="tel" maxlength="20" placeholder="+91"></div>
      </div>
      <div class="field"><label for="regInst">College / company (optional)</label>
        <input id="regInst" type="text" maxlength="120"></div>
      <label class="check"><input id="regOwner" type="checkbox" ${/^#\/list/.test(location.hash)?'checked':''}> I own equipment and want to list it on IICHUB</label>
      <div id="regMessage" class="message"></div>
      <p class="links"><a href="#" data-act="showLogin">I already have an account</a></p>
    </div>
    <div class="sfoot">
      <button class="ghost" data-act="closeM">Cancel</button>
      <button class="go" id="regBtn" data-act="doRegister">Create account</button>
    </div>
    </div>
  `);
}

async function doRegister(){
  const body={
    name:$('regName').value.trim(),
    email:$('regEmail').value.trim(),
    password:$('regPassword').value,
    affiliation:$('regAff').value,
    account_type:$('regOwner').checked?'equipment_owner':'innovator'
  };
  const phone=$('regPhone').value.trim(); if(phone) body.phone=phone;
  const inst=$('regInst').value.trim(); if(inst) body.institution=inst;
  if(body.name.length<2){ msg('regMessage','Enter your name.'); return; }
  if(!body.email){ msg('regMessage','Enter your email.'); return; }
  if(body.password.length<10){ msg('regMessage','Password must be at least 10 characters.'); return; }
  const btn=$('regBtn'); btn.disabled=true;
  try{
    const r=await api('/auth/register',{method:'POST',body});
    setSession(r);
    await afterSignIn(r.verification_sent?'Account created. Check your email to confirm it.':'Account created.');
  }catch(e){
    msg('regMessage',e.message);
    btn.disabled=false;
  }
}

function showForgot(){
  openModal(`
    <div data-form>
    <div class="shead"><h3>Reset your password</h3>
      <p>We'll email you a link to choose a new password.</p></div>
    <div class="sbody">
      <div class="field"><label for="fgEmail">Email</label>
        <input id="fgEmail" type="email" autocomplete="username" maxlength="254"></div>
      <div id="fgMessage" class="message"></div>
    </div>
    <div class="sfoot">
      <button class="ghost" data-act="showLogin">Back</button>
      <button class="go" id="fgBtn" data-act="doForgot">Send link</button>
    </div>
    </div>`);
}

async function doForgot(){
  const email=$('fgEmail').value.trim();
  if(!email){ msg('fgMessage','Enter your email.'); return; }
  $('fgBtn').disabled=true;
  try{
    const r=await api('/auth/forgot-password',{method:'POST',body:{email}});
    msg('fgMessage',r.message,true);
  }catch(e){ msg('fgMessage',e.message); $('fgBtn').disabled=false; }
}

function showReset(resetToken){
  openModal(`
    <div data-form>
    <div class="shead"><h3>Choose a new password</h3></div>
    <div class="sbody">
      <input type="hidden" id="rsToken" value="${escapeHtml(resetToken)}">
      <div class="field"><label for="rsPassword">New password (at least 10 characters)</label>
        <input id="rsPassword" type="password" autocomplete="new-password" maxlength="128"></div>
      <div class="field"><label for="rsPassword2">Type it again</label>
        <input id="rsPassword2" type="password" autocomplete="new-password" maxlength="128"></div>
      <div id="rsMessage" class="message"></div>
    </div>
    <div class="sfoot"><button class="go" id="rsBtn" data-act="doReset">Save password</button></div>
    </div>`);
}

async function doReset(){
  const p=$('rsPassword').value;
  if(p!==$('rsPassword2').value){ msg('rsMessage','The two passwords are different.'); return; }
  $('rsBtn').disabled=true;
  try{
    await api('/auth/reset-password',{method:'POST',body:{token:$('rsToken').value,password:p}});
    showLogin('Password changed. Sign in with your new password.');
  }catch(e){ msg('rsMessage',e.message); $('rsBtn').disabled=false; }
}

function showChangePassword(forced){
  openModal(`
    <div data-form>
    <div class="shead"><h3>${forced?'Set your own password':'Change password'}</h3>
      <p>${forced?'You signed in with a temporary password. Choose a new one to continue.':'You will stay signed in on this device; other devices are signed out.'}</p></div>
    <div class="sbody">
      <div class="field"><label for="cpCurrent">${forced?'Temporary':'Current'} password</label>
        <input id="cpCurrent" type="password" autocomplete="current-password" maxlength="128"></div>
      <div class="field"><label for="cpNew">New password (at least 10 characters)</label>
        <input id="cpNew" type="password" autocomplete="new-password" maxlength="128"></div>
      <div class="field"><label for="cpNew2">Type it again</label>
        <input id="cpNew2" type="password" autocomplete="new-password" maxlength="128"></div>
      <div id="cpMessage" class="message"></div>
    </div>
    <div class="sfoot">
      ${forced?'<button class="ghost" data-act="signOut">Sign out</button>':'<button class="ghost" data-act="showAccount">Back</button>'}
      <button class="go" id="cpBtn" data-act="doChangePassword">Save password</button>
    </div>
    </div>`);
}

async function doChangePassword(){
  const n=$('cpNew').value;
  if(n!==$('cpNew2').value){ msg('cpMessage','The two new passwords are different.'); return; }
  $('cpBtn').disabled=true;
  try{
    setSession(await api('/auth/change-password',{method:'POST',body:{current_password:$('cpCurrent').value,new_password:n}}));
    await afterSignIn('Password saved.');
  }catch(e){ msg('cpMessage',e.message); $('cpBtn').disabled=false; }
}

function showAccount(){
  const u=currentUser;
  const needsVerify=u.email_required && !u.email_verified;
  openModal(`
    <div class="shead"><h3>${escapeHtml(u.name)}</h3><p>${escapeHtml(u.email)}</p></div>
    <div class="sbody">
      ${needsVerify?`<div class="message">Please confirm your email address before booking.
        <a href="#" data-act="resendVerify">Send the link again</a></div>`:''}
      ${u.role==='equipment_owner'?'<p class="links"><a href="#/listings" data-act="closeM">My listings</a> · <a href="#/list/new" data-act="closeM">List a machine</a></p>':''}
      <p class="links">
        <a href="#" data-act="openMyJobs">My jobs</a> ·
        <a href="#" data-act="showChangePassword">Change password</a> ·
        <a href="#" data-act="signOutAll">Sign out on all devices</a>
      </p>
      <div id="acMessage" class="message"></div>
    </div>
    <div class="sfoot">
      <button class="ghost" data-act="closeM">Close</button>
      <button class="go" data-act="signOut">Sign out</button>
    </div>`);
}

async function resendVerify(){
  try{
    const r=await api('/auth/resend-verification',{method:'POST',body:{}});
    msg('acMessage',r.already?'Your email is already confirmed.':r.sent?'Link sent. Check your inbox.':'Email is not set up yet.',true);
  }catch(e){ msg('acMessage',e.message); }
}

function signOut(){
  clearSession();
  closeM();
  showToast('Signed out.');
}

async function signOutAll(){
  if(!confirm('Sign out of IICHUB on every device?')) return;
  try{ await api('/auth/logout-all',{method:'POST',body:{}}); }catch{}
  signOut();
}

function accountRequired(machineId){
  pendingMachineId=machineId;
  showLogin();
}

// Links from emails: /#verify=… and /#reset=…
async function handleLinkHash(){
  const h=location.hash.slice(1);
  if(!h) return;
  const [kind,value]=h.split('=');
  if(kind==='reset'&&value){ history.replaceState(null,'',location.pathname); showReset(value); }
  else if(kind==='verify'&&value){
    history.replaceState(null,'',location.pathname);
    try{
      await api('/auth/verify-email',{method:'POST',body:{token:value}});
      if(currentUser) currentUser=await api('/auth/me');
      showToast('Email confirmed. You can book machines now.');
    }catch(e){ showToast(e.message); }
  }
  else if(kind==='jobs'){ history.replaceState(null,'',location.pathname); if(currentUser) openMyJobs(); else showLogin(); }
}

// ===================================================================
// Screens: search, results, machine page, booking, jobs, listings
// ===================================================================
let META = { processes: [], materials: [], states: [], totals: null };
let procFilter = '';
let lastRows = [];

const ICONS = {
  fdm: 'M4 20h16M7 20V9h10v11M9 9V5h6v4M12 13v3',
  sla: 'M8 3h8l-1 6H9zM9 9l-3 11h12L15 9M10 15h4',
  sls: 'M5 20h14M6 20l2-10h8l2 10M9 10V6h6v4M10 14h4',
  laser_cut: 'M4 4h16v6H4zM12 10v4M9 20l3-6 3 6M7 7h2',
  cnc_mill: 'M5 3h14v5H5zM12 8v6M9 14h6l-1 3h-4zM4 21h16',
  pcb: 'M4 4h16v16H4zM8 8h3v3H8zM14 14h2v2h-2zM11 9.5h5V14M8 11v5h6',
  all: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'
};
const TINTS = { fdm: '#FFE4D3', sla: '#E3E8FF', sls: '#F3E8FF', laser_cut: '#FFF3C4', cnc_mill: '#DFF5E8', pcb: '#E0F2FE', all: '#F2F4F7' };
const icon = (code, size = 22, stroke = 1.8) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#0B1B3F" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[code] || ICONS.fdm}"/></svg>`;
const money = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

async function loadMeta(){
  try{
    META = await api('/meta');
    const t = META.totals;
    if(t) $('heroStats').textContent = `${t.machines} machines · ${t.centres} centres · ${t.states} states`;
  }catch{}
  renderTiles();
}

function renderTiles(){
  const procs = [{ code: '', label: 'All machines', layman_label: 'Everything' }, ...META.processes];
  $('procTiles').innerHTML = procs.map(p => {
    const code = p.code || 'all';
    return `<button class="tile ${procFilter === p.code ? 'on' : ''}" data-act="pickProc" data-arg="${escapeHtml(p.code)}" aria-pressed="${procFilter === p.code}">
      <span class="ic" style="background:${TINTS[code] || '#F2F4F7'}">${icon(code)}</span>
      <b>${escapeHtml(p.label.replace(/ Printing| Prototyping/,''))}</b>
      <small>${escapeHtml(p.layman_label || '')}</small>
    </button>`;
  }).join('');
}

function pickProc(code){
  procFilter = code ? String(code) : '';
  renderTiles();
  run();
}

async function run(){
  const x = Number(val('x')), y = Number(val('y')), z = Number(val('z'));
  const mat = val('mat'), tol = val('tol'), loc = val('loc');
  const [lat, lng] = loc ? loc.split(',').map(Number) : [null, null];
  if(!(x > 0 && y > 0 && z > 0)){ renderMessage('Enter all three part dimensions.'); return; }
  $('list').innerHTML = '<div class="empty">Searching the machine network…</div>';
  const q = new URLSearchParams({ x, y, z, qty: 1 });
  if(lat !== null){ q.set('lat', lat); q.set('lng', lng); }
  if(mat) q.set('mat', mat);
  if(tol) q.set('tol', tol);
  if(procFilter) q.set('proc', procFilter);
  try{
    const rows = await api('/machines?' + q.toString());
    lastRows = rows;
    renderMachines(rows);
    loadFreeDays(rows.slice(0, 30).map(r => Number(r.machine_id)));
  }catch(e){
    renderMessage('Could not load machines: ' + e.message);
  }
  loadNearby(lat, lng, loc ? $('loc').selectedOptions[0].textContent : '');
}

function renderMessage(message){
  $('count').textContent = '';
  $('rtitle').textContent = 'Machines that can make this';
  $('list').innerHTML = `<div class="empty"><b>${escapeHtml(message)}</b></div>`;
}

function renderMachines(rows){
  $('count').textContent = rows.length ? (val('loc') ? 'Nearest first' : 'Best fit first') : '';
  $('rtitle').textContent = rows.length ? `${rows.length} machine${rows.length === 1 ? '' : 's'} can make this` : 'Machines that can make this';
  if(!rows.length){
    renderMessage('No machine matches these requirements. Try a smaller size, another material, or "Not fussy" precision.');
    return;
  }
  const cheapest = Math.min(...rows.filter(r => r.status === 'available').map(r => Number(r.rate_per_hour)));
  $('list').innerHTML = rows.map((m, i) => {
    const id = Number(m.machine_id);
    const available = m.status === 'available' || m.status === 'in_use';
    const tags = [];
    if(i === 0 && available) tags.push('<span class="tag">Best match</span>');
    else if(available && Number(m.rate_per_hour) === cheapest) tags.push('<span class="tag">Lowest price</span>');
    if(m.tolerance_mm && Number(m.tolerance_mm) <= 0.05) tags.push('<span class="tag">Fine detail</span>');
    if(m.owner_type === 'private') tags.push('<span class="tag private">Private lab · verified</span>');
    if(!available) tags.push(`<span class="tag warn">${escapeHtml(String(m.status).replace('_',' '))}</span>`);
    const dist = m.distance_km == null ? '' : `<span class="muted small">${Number(m.distance_km).toFixed(0)} km away</span>`;
    const size = m.max_x_mm ? `fits ${Number(m.max_x_mm)}×${Number(m.max_y_mm)}×${Number(m.max_z_mm)} mm` : '';
    const thumb = m.photo_id
      ? `<img src="/photos/${Number(m.photo_id)}" alt="Photo of ${escapeHtml(m.machine)}" loading="lazy">`
      : icon(m.process_code, 46, 1.4);
    return `<article class="card ${available ? '' : 'maint'}">
      <div class="thumb" style="background:${TINTS[m.process_code] || '#F2F4F7'}">${thumb}</div>
      <div class="cbody">
        <div class="tags">${tags.join('')}${dist}</div>
        <div class="cname">${escapeHtml(m.machine || 'Machine')}</div>
        <div class="cmeta">${escapeHtml(m.process_label || '')} · ${escapeHtml(m.centre_name || '')}, ${escapeHtml(m.district || '')}</div>
        <div class="specs">${size ? `<span>${escapeHtml(size)}</span>` : ''}${m.tolerance_mm ? `<span>±${Number(m.tolerance_mm)} mm</span>` : ''}${Number(m.in_stock_g) > 0 ? `<span>${Math.round(m.in_stock_g)} g in stock</span>` : ''}</div>
        <div class="week" id="wk-${id}"><span class="lbl">Free this week</span><span class="bars">${'<span></span>'.repeat(7)}</span></div>
      </div>
      <div class="right">
        <div class="rate">${money(m.rate_per_hour)}<small>per hour</small></div>
        <div class="actions">
          <a class="btn ghost sm" href="#/machine/${id}">Details</a>
          <button class="book" ${available ? '' : 'disabled'} data-act="openSlots" data-arg="${id}">${available ? 'Book a slot' : 'Unavailable'}</button>
        </div>
      </div>
    </article>`;
  }).join('');
}

async function loadFreeDays(ids){
  if(!ids.length) return;
  try{
    const r = await api('/machines/free-days?ids=' + ids.join(','));
    const start = new Date(r.from + 'T00:00:00+05:30');
    const days = [...Array(7)].map((_, i) => {
      const d = new Date(start.getTime() + i * 864e5);
      return { key: new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10), name: d.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'Asia/Kolkata' }) };
    });
    ids.forEach(id => {
      const el = document.getElementById('wk-' + id);
      if(!el) return;
      const free = new Set(r.days[id] || []);
      el.querySelector('.bars').innerHTML = days.map(d =>
        `<span class="${free.has(d.key) ? 'free' : ''}" title="${d.name}: ${free.has(d.key) ? 'free slots' : 'full or closed'}"></span>`).join('');
      el.setAttribute('aria-label', `Free on ${days.filter(d => free.has(d.key)).map(d => d.name).join(', ') || 'no days this week'}`);
    });
  }catch{}
}

async function loadNearby(lat, lng, city){
  const panel = $('nearPanel');
  if(lat === null){ panel.hidden = true; return; }
  panel.hidden = false;
  $('nearTitle').textContent = `Centres near ${city}`;
  try{
    const rows = await api(`/centres/near?lat=${lat}&lng=${lng}&limit=5`);
    $('nearList').innerHTML = rows.map(c => `<div class="near-row">
      <div><b>${escapeHtml(c.name)}</b><small>${escapeHtml(c.processes || '')}</small></div>
      <span>${Number(c.distance_km).toFixed(0)} km</span></div>`).join('') || '<p class="muted small">No centres yet.</p>';
  }catch{ $('nearList').innerHTML = ''; }
}

// ---------------- machine page ----------------
async function showMachine(id){
  const box = $('machineView');
  box.innerHTML = '<div class="empty">Loading…</div>';
  try{
    const m = await api(`/machines/${id}/profile`);
    currentMachine = m;
    const photos = m.photos || [];
    const code = (META.processes.find(p => p.layman_label === m.does_what) || {}).code || 'fdm';
    const days = (m.working_days || []).map(d => ['','Mon','Tue','Wed','Thu','Fri','Sat','Sun'][d]).join(', ');
    const hrs = `${String(m.opens_at || '').slice(0,5)}–${String(m.closes_at || '').slice(0,5)}`;
    const where = m.address_hidden
      ? `${escapeHtml(m.centre_name)} · ${escapeHtml(m.district || '')}`
      : `${escapeHtml(m.centre_name)} · ${escapeHtml(m.address || '')}${m.pincode ? ' ' + escapeHtml(m.pincode) : ''}`;
    box.innerHTML = `
      <a class="back" href="#/">← Back to results</a>
      <div class="mgrid">
        <div>
          <div class="gallery-main" id="gMain" style="background:${TINTS[code] || '#FFE4D3'}">
            ${photos.length ? `<img src="/photos/${Number(photos[0].id)}" alt="${escapeHtml(photos[0].caption || m.machine)}">` : icon(code, 72, 1.2)}
          </div>
          <div class="credit" id="gCredit">${photos[0] && photos[0].caption ? escapeHtml(photos[0].caption) : ''}</div>
          ${photos.length > 1 ? `<div class="thumbs">${photos.slice(0, 8).map((p, i) => `<button class="${i ? '' : 'on'}" data-act="pickPhoto" data-arg="${Number(p.id)}" aria-label="Show photo ${i + 1}"><img src="/photos/${Number(p.id)}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}
        </div>
        <div class="mhead">
          <div class="tags">
            ${m.owner_type === 'private' ? '<span class="pill ok">Verified by IICHUB</span><span class="pill">Private lab</span>' : '<span class="pill ok">Government / partner centre</span>'}
            <span class="pill ${m.status === 'available' ? 'ok' : 'wait'}">${escapeHtml(String(m.status).replace('_',' '))}</span>
          </div>
          <h1>${escapeHtml(m.machine)}</h1>
          <div class="muted">${where}</div>
          <div class="specs">
            <span>${escapeHtml(m.does_what || '')}</span>
            ${m.max_x_mm ? `<span>${Number(m.max_x_mm)} × ${Number(m.max_y_mm)} × ${Number(m.max_z_mm)} mm</span>` : ''}
            ${m.tolerance_mm ? `<span>±${Number(m.tolerance_mm)} mm</span>` : ''}
            ${(m.materials || []).map(x => `<span>${escapeHtml(x.label)}</span>`).join('')}
          </div>
          <div class="pricebox">
            <div><span class="big">${money(m.rate_per_hour)}</span> <span class="muted">per hour · setup ${money(m.setup_fee)} · minimum ${money(m.min_charge)}</span></div>
            <button class="book" data-act="openSlots" data-arg="${Number(m.machine_id)}">See free slots and book</button>
            <div class="lock">${m.address_hidden ? 'The exact address and phone number are shared once your booking is confirmed.' : `Open ${escapeHtml(days)} · ${escapeHtml(hrs)}`}</div>
          </div>
        </div>
      </div>
      <div class="info3">
        <div class="panel"><h3>How a job runs</h3><p>${escapeHtml(m.how_to_use || 'The centre will explain the steps when it sends your quote.')}${m.prep_notes ? '\n\n' + escapeHtml(m.prep_notes) : ''}</p></div>
        <div class="panel safety"><h3>Safety rules</h3><p>${escapeHtml(m.safety_notes || 'Follow the instructions of the centre staff at all times.')}</p></div>
        <div class="panel"><h3>Good to know</h3>
          <div class="kv"><span>Files accepted</span><b>${escapeHtml((m.file_formats || []).join(', ') || 'Ask the centre')}</b></div>
          <div class="kv"><span>Turnaround</span><b>${m.typical_lead_hrs ? 'About ' + Number(m.typical_lead_hrs) + ' hours' : 'Given with the quote'}</b></div>
          <div class="kv"><span>Who runs it</span><b>${m.requires_operator ? 'Centre operator' : 'You, after a briefing'}</b></div>
          ${m.success_rate_pct != null ? `<div class="kv"><span>Jobs completed well</span><b>${Number(m.success_rate_pct)}%</b></div>` : ''}
          ${m.sop ? `<p style="margin-top:10px"><a href="/machines/${Number(m.machine_id)}/sop">Download the full procedure (PDF)</a></p>` : ''}
        </div>
      </div>`;
  }catch(e){
    box.innerHTML = `<a class="back" href="#/">← Back</a><div class="empty">${escapeHtml(e.message)}</div>`;
  }
}

function pickPhoto(id){
  const main = $('gMain');
  main.innerHTML = `<img src="/photos/${Number(id)}" alt="">`;
  const ph = ((currentMachine && currentMachine.photos) || []).find(p => Number(p.id) === Number(id));
  $('gCredit').textContent = ph && ph.caption ? ph.caption : '';
  document.querySelectorAll('.thumbs button').forEach(b => b.classList.toggle('on', Number(b.dataset.arg) === Number(id)));
}

// ---------------- booking ----------------
function formatDate(iso){ return new Date(iso).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }); }
function formatTime(iso){ return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }); }
function dateKey(iso){ return new Date(new Date(iso).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10); }

async function openSlots(machineId){
  if(!currentUser){ accountRequired(machineId); return; }
  if(!['innovator','equipment_owner'].includes(currentUser.role)){ showToast('Bookings are made from an innovator account.'); return; }
  openModal('<div class="shead"><h3>Loading free slots…</h3></div><div class="sbody">Please wait.</div>');
  try{
    const [profile, slots] = await Promise.all([
      api(`/machines/${machineId}/profile`),
      api(`/machines/${machineId}/slots?days=7&mins=60`)
    ]);
    currentMachine = profile;
    currentSlots = slots.filter(s => s.slot_start && new Date(s.slot_start).getTime() > Date.now());
    selectedSlot = null;
    renderBookingForm();
  }catch(e){
    openModal(`<div class="shead"><h3>Could not load booking details</h3></div>
      <div class="sbody"><div class="message">${escapeHtml(e.message)}</div></div>
      <div class="sfoot"><button class="ghost" data-act="closeM">Close</button></div>`);
  }
}

function renderBookingForm(){
  const m = currentMachine;
  const keep = { title: $('jobTitle') ? $('jobTitle').value : '', mat: $('jobMaterial') ? $('jobMaterial').value : '', qty: $('jobQty') ? $('jobQty').value : '1' };
  const groups = {};
  currentSlots.forEach((s, index) => { (groups[dateKey(s.slot_start)] = groups[dateKey(s.slot_start)] || []).push({ ...s, index }); });
  const days = Object.values(groups);
  const mats = (m.materials || []);
  const slotsHtml = days.length ? days.map(day => `
      <div class="dlabel">${escapeHtml(formatDate(day[0].slot_start))}</div>
      <div class="slots">${day.map(s => `<button class="slot ${selectedSlot === s.index ? 'sel' : ''}" data-act="selectSlot" data-arg="${s.index}" aria-pressed="${selectedSlot === s.index}">${escapeHtml(formatTime(s.slot_start))}</button>`).join('')}</div>`).join('')
    : '<div class="empty">No free slots in the next 7 days. Try another machine.</div>';
  openModal(`
    <div class="shead">
      <h3>Book ${escapeHtml(m.machine || 'machine')}</h3>
      <p>${escapeHtml(m.centre_name || '')} · ${money(m.rate_per_hour)}/hour · setup ${money(m.setup_fee)}</p>
    </div>
    <div class="sbody" data-form>
      <div class="field"><label for="jobTitle">What are you making?</label>
        <input id="jobTitle" type="text" maxlength="120" placeholder="e.g. Drone motor bracket" value="${escapeHtml(keep.title)}"></div>
      <div class="form-grid">
        <div class="field"><label for="jobMaterial">Material</label>
          <select id="jobMaterial"><option value="">Choose later</option>${mats.map(x => `<option value="${escapeHtml(x.code)}" ${keep.mat === x.code ? 'selected' : ''}>${escapeHtml(x.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="jobQty">Quantity</label>
          <input id="jobQty" type="number" min="1" max="100000" value="${escapeHtml(keep.qty)}"></div>
      </div>
      <div class="muted small">Free 1-hour slots · Indian time</div>
      ${slotsHtml}
      <div id="bookingMessage" class="message"></div>
    </div>
    <div class="sfoot">
      <div class="est">From<br><b>${money(m.min_charge)}+</b><br><span>The centre sends a quote before any work starts.</span></div>
      <button class="ghost" data-act="closeM">Cancel</button>
      <button class="go" id="confirmBookingBtn" data-act="confirmBooking" ${days.length ? '' : 'disabled'}>Confirm booking</button>
    </div>`);
}

function selectSlot(index){ selectedSlot = Number(index); renderBookingForm(); }

async function confirmBooking(){
  if(selectedSlot === null){ $('bookingMessage').textContent = 'Please pick a free time slot.'; return; }
  const title = $('jobTitle').value.trim(), material = $('jobMaterial').value, qty = Number($('jobQty').value);
  if(!title){ $('bookingMessage').textContent = 'Tell us what you are making.'; return; }
  if(!Number.isInteger(qty) || qty < 1){ $('bookingMessage').textContent = 'Enter a valid quantity.'; return; }
  const slot = currentSlots[selectedSlot];
  const button = $('confirmBookingBtn');
  button.disabled = true; button.textContent = 'Saving…';
  try{
    const result = await api('/bookings', { method: 'POST', body: {
      machine_id: Number(currentMachine.machine_id), slot_start: slot.slot_start, slot_end: slot.slot_end,
      title, ...(material ? { material } : {}), qty } });
    $('sheet').innerHTML = `<div class="done">
        <div class="tick" aria-hidden="true">✓</div>
        <h3>Booking confirmed</h3>
        <p>${escapeHtml(currentMachine.machine || '')} · ${escapeHtml(currentMachine.centre_name || '')}</p>
        <p>${escapeHtml(formatDate(slot.slot_start))} at ${escapeHtml(formatTime(slot.slot_start))}</p>
        <div class="jobno">Job number: ${escapeHtml(result.job_id)}<br>Status: waiting for the centre's quote</div>
        <p>You'll see the quote in My jobs. Nothing is charged until you accept it.</p>
        <div class="sfoot" style="justify-content:center">
          <button class="ghost" data-act="closeM">Close</button>
          <button class="go" data-act="openMyJobs">View My Jobs</button>
        </div>
      </div>`;
    showToast('Booking saved.');
    loadFreeDays(lastRows.slice(0, 30).map(r => Number(r.machine_id)));
  }catch(e){
    $('bookingMessage').textContent = e.message;
    button.disabled = false; button.textContent = 'Confirm booking';
    if(e.status === 409){ try{ currentSlots = (await api(`/machines/${currentMachine.machine_id}/slots?days=7&mins=60`)).filter(s => new Date(s.slot_start) > new Date()); selectedSlot = null; renderBookingForm(); $('bookingMessage').textContent = e.message; }catch{} }
  }
}

// ---------------- my jobs ----------------
const JOB_STATUS = {
  quote_pending: ['Waiting for quote', 'wait'], quote_sent: ['Quote ready', 'wait'], quote_accepted: ['Quote accepted', 'ok'],
  queued: ['In the queue', 'ok'], setup: ['Being set up', 'ok'], running: ['Being made', 'ok'], qc: ['Quality check', 'ok'],
  ready: ['Ready to collect', 'ok'], collected: ['Collected', 'ok'], failed: ['Failed', 'bad'], cancelled: ['Cancelled', 'draft']
};

async function openMyJobs(){
  if(!currentUser){ pendingMachineId = null; showLogin('Sign in to see your jobs.'); return; }
  openModal('<div class="shead"><h3>My jobs</h3></div><div class="sbody">Loading your jobs…</div>');
  try{ renderMyJobs(await api('/my/jobs')); }
  catch(e){ openModal(`<div class="shead"><h3>My jobs</h3></div><div class="sbody"><div class="message">${escapeHtml(e.message)}</div></div><div class="sfoot"><button class="ghost" data-act="closeM">Close</button></div>`); }
}

function renderMyJobs(jobs){
  const content = jobs.length ? jobs.map(job => {
    const st = String(job.status || '');
    const [label, cls] = JOB_STATUS[st] || [st, 'draft'];
    const hasQuote = job.quote !== null && job.quote !== undefined;
    const canAccept = st === 'quote_sent' && hasQuote;
    const canCancel = ['quote_pending','quote_sent','quote_accepted'].includes(st);
    const when = job.slot_start ? `${formatDate(job.slot_start)} at ${formatTime(job.slot_start)}` : '';
    return `<div class="job">
      <div class="job-top"><div><div class="job-title">${escapeHtml(job.title || 'Untitled job')}</div>
        <div class="job-meta">${escapeHtml(job.machine || '')} · ${escapeHtml(job.centre || '')}</div></div>
        <span class="status pill ${cls}">${escapeHtml(label)}</span></div>
      <div class="job-meta">Qty ${escapeHtml(job.quantity)}${when ? ' · ' + escapeHtml(when) : ''}</div>
      ${job.centre_address && !['cancelled'].includes(st) ? `<div class="job-meta">Address: ${escapeHtml(job.centre_address)}${job.centre_phone ? ' · ' + escapeHtml(job.centre_phone) : ''}</div>` : ''}
      <div class="job-meta">${hasQuote ? `<b style="color:#0B1B3F">Quote: ₹${Number(job.quote).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</b>` : 'Waiting for the centre to send a quote.'}</div>
      ${canAccept || canCancel ? `<div class="job-actions">
        ${canAccept ? `<button class="book" data-act="acceptQuote" data-arg="${Number(job.id)}">Accept quote</button>` : ''}
        ${canCancel ? `<button class="ghost" data-act="cancelJob" data-arg="${Number(job.id)}">Cancel booking</button>` : ''}</div>` : ''}
    </div>`;
  }).join('') : '<div class="empty"><b>No jobs yet.</b><br>Book a machine and it will appear here.</div>';
  openModal(`<div class="shead"><h3>My jobs</h3><p>Signed in as ${escapeHtml(currentUser.name || currentUser.email)}</p></div>
    <div class="sbody">${content}</div>
    <div class="sfoot"><button class="ghost" data-act="closeM">Close</button><button class="go" data-act="openMyJobs">Refresh</button></div>`);
}

async function acceptQuote(jobId){
  if(!confirm('Accept this quote? The centre will start your job.')) return;
  try{ await api(`/jobs/${jobId}/accept`, { method: 'POST', body: {} }); showToast('Quote accepted.'); await openMyJobs(); }
  catch(e){ showToast(e.message); }
}
async function cancelJob(jobId){
  if(!confirm('Cancel this booking? The time slot will be released.')) return;
  try{ await api(`/jobs/${jobId}/cancel`, { method: 'POST', body: {} }); showToast('Booking cancelled.'); await openMyJobs(); }
  catch(e){ showToast(e.message); }
}

// ---------------- photos that need a session (owner previews) ----------------
async function authedImg(img, id){
  try{
    const r = await fetch(`/photos/${Number(id)}`, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    if(!r.ok) return;
    img.src = URL.createObjectURL(await r.blob());
  }catch{}
}
function hydrateImages(root){
  root.querySelectorAll('img[data-photo]').forEach(img => authedImg(img, img.dataset.photo));
}

// ---------------- list your equipment (owners) ----------------
const STEPS = ['Location', 'Device', 'Photos', 'Procedure', 'Review'];
let wiz = null; // { step, centreId, machineId, data, listing }

function blankWizard(){
  return { step: 0, centreId: null, machineId: null, verification: 'draft', review_note: null, photos: [], sop: null,
    c: { name: '', address: '', district: '', state_code: 'AP', pincode: '', lat: '', lng: '', phone: '', opens_at: '09:00', closes_at: '18:00', working_days: [1,2,3,4,5,6] },
    m: { process_code: 'fdm', make: '', model: '', rate_per_hour: '', setup_fee: '', min_charge: '', max_x_mm: '', max_y_mm: '', max_z_mm: '', tolerance_mm: '', materials: [] },
    g: { how_to_use: '', prep_notes: '', safety_notes: '', file_formats: '', requires_operator: true, typical_lead_hrs: '' } };
}

async function showList(editId){
  if(!currentUser){ showLogin('Sign in or create an account to list your equipment. Tick "I own equipment" when you sign up.'); return; }
  if(currentUser.role !== 'equipment_owner'){
    $('listView').innerHTML = `<div class="wiz-head"><h1>List your equipment</h1></div><div class="empty">Listing is for equipment-owner accounts. ${['innovator'].includes(currentUser.role) ? 'Sign out and create a new account with "I own equipment" ticked, or ask the IICHUB team to convert your account.' : ''}</div>`;
    return;
  }
  if(!META.materials.length) await loadMeta();
  if(editId){
    const listings = await api('/owner/listings');
    const l = listings.find(x => Number(x.id) === Number(editId));
    if(!l){ showToast('Listing not found.'); location.hash = '#/listings'; return; }
    const mc = l.machines[0] || {};
    wiz = blankWizard();
    Object.assign(wiz, { centreId: Number(l.id), machineId: mc.id ? Number(mc.id) : null, verification: l.verification, review_note: l.review_note, photos: mc.photos || [], sop: mc.sop || null });
    for(const k of Object.keys(wiz.c)) if(l[k] !== undefined && l[k] !== null) wiz.c[k] = k.endsWith('_at') ? String(l[k]).slice(0, 5) : l[k];
    for(const k of Object.keys(wiz.m)) if(mc[k] !== undefined && mc[k] !== null) wiz.m[k] = mc[k];
    const g = mc.guide || {};
    for(const k of Object.keys(wiz.g)) if(g[k] !== undefined && g[k] !== null) wiz.g[k] = k === 'file_formats' ? (g[k] || []).join(', ') : g[k];
  }else if(!wiz || wiz.centreId){
    wiz = blankWizard();
  }
  renderWizard();
}

function wizInput(id, label, value, attrs = '', hint = ''){
  return `<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${escapeHtml(value ?? '')}" ${attrs}>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
}
function wizText(id, label, value, hint = ''){
  return `<div class="field"><label for="${id}">${label}</label><textarea id="${id}" maxlength="2000">${escapeHtml(value ?? '')}</textarea>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
}

function renderWizard(){
  const w = wiz, st = w.step;
  const stepper = STEPS.map((s, i) => `<li><button class="${i === st ? 'on' : i < st ? 'done' : ''}" data-act="wizGo" data-arg="${i}" ${i > 1 && !w.machineId ? 'disabled' : ''}><span class="n">${i < st ? '✓' : i + 1}</span><span class="t">${s}</span></button></li>`).join('');
  let body = '';
  if(st === 0){
    body = `<h2>Where is it?</h2><p class="muted">Innovators see the area and distance. The exact address is shared only after you confirm their booking.</p>
      ${wizInput('wName', 'Lab or workshop name', w.c.name, 'maxlength="120" autocomplete="organization"')}
      ${wizInput('wAddr', 'Full address', w.c.address, 'maxlength="300" autocomplete="street-address"')}
      <div class="grid3">
        ${wizInput('wDist', 'District / city', w.c.district, 'maxlength="80"')}
        <div class="field"><label for="wState">State</label><select id="wState">${META.states.map(s => `<option value="${escapeHtml(s.code)}" ${s.code === w.c.state_code ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select></div>
        ${wizInput('wPin', 'PIN code', w.c.pincode, 'inputmode="numeric" maxlength="6" pattern="[1-9][0-9]{5}" autocomplete="postal-code"')}
      </div>
      <div class="grid3">
        ${wizInput('wLat', 'Latitude', w.c.lat, 'inputmode="decimal"')}
        ${wizInput('wLng', 'Longitude', w.c.lng, 'inputmode="decimal"')}
        <div class="field"><span class="flabel">&nbsp;</span><button class="btn ghost block" data-act="wizLocate" type="button">Use my current location</button></div>
      </div>
      <p class="hint muted small" style="margin:-6px 0 14px">Tip: in Google Maps, right-click your lab and click the numbers to copy them.</p>
      <div class="grid3">
        ${wizInput('wPhone', 'Contact phone', w.c.phone, 'inputmode="tel" maxlength="20" autocomplete="tel"')}
        ${wizInput('wOpen', 'Opens', w.c.opens_at, 'type="time"')}
        ${wizInput('wClose', 'Closes', w.c.closes_at, 'type="time"')}
      </div>
      <span class="flabel">Open on</span>
      <div class="chips">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((d, i) => `<label><input type="checkbox" class="wDay" value="${i + 1}" ${w.c.working_days.includes(i + 1) ? 'checked' : ''}> ${d}</label>`).join('')}</div>`;
  }else if(st === 1){
    body = `<h2>About the device</h2><p class="muted">This decides which jobs are matched to your machine.</p>
      <div class="grid3">
        <div class="field"><label for="wProc">Process</label><select id="wProc">${META.processes.map(p => `<option value="${escapeHtml(p.code)}" ${p.code === w.m.process_code ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}</select></div>
        ${wizInput('wMake', 'Make', w.m.make, 'maxlength="60" placeholder="e.g. Bambu Lab"')}
        ${wizInput('wModel', 'Model', w.m.model, 'maxlength="60" placeholder="e.g. X1 Carbon"')}
      </div>
      <span class="flabel">Largest part it can make (mm)</span>
      <div class="grid3">
        ${wizInput('wX', 'Length (X)', w.m.max_x_mm, 'type="number" min="1"')}
        ${wizInput('wY', 'Width (Y)', w.m.max_y_mm, 'type="number" min="1"')}
        ${wizInput('wZ', 'Height (Z)', w.m.max_z_mm, 'type="number" min="1"')}
      </div>
      <div class="grid3">
        ${wizInput('wRate', 'Rate per hour (₹)', w.m.rate_per_hour, 'type="number" min="0"')}
        ${wizInput('wSetup', 'Setup fee (₹, optional)', w.m.setup_fee, 'type="number" min="0"')}
        ${wizInput('wTol', 'Precision ± mm (optional)', w.m.tolerance_mm, 'type="number" min="0" step="0.01"')}
      </div>
      <span class="flabel">Materials you offer</span>
      <div class="chips">${META.materials.map(x => `<label><input type="checkbox" class="wMat" value="${escapeHtml(x.code)}" ${w.m.materials.includes(x.code) ? 'checked' : ''}> ${escapeHtml(x.label)}</label>`).join('')}</div>`;
  }else if(st === 2){
    const zone = (kind, label, req, hint) => `<div class="drop"><span class="flabel">${label} <span class="muted" style="font-weight:500">${req ? '· required' : '· optional'}</span></span>
      <label class="zone ${req ? 'req' : ''}">${icon('all', 26, 1.6)} Add photos<input type="file" accept="image/jpeg,image/png,image/webp" multiple data-kind="${kind}" class="wFile" aria-label="Add ${label} photos"></label>
      <span class="muted small">${hint}</span></div>`;
    body = `<h2>Photos</h2><p class="muted">Clear photos get more bookings. JPG, PNG or WebP, up to 5 MB each, at most 8. Location data inside photos is removed automatically.</p>
      <div class="grid3">${zone('machine', 'The device', true, 'Front and side, in good light')}${zone('location', 'Lab entrance', false, 'Helps people find you')}${zone('sample_output', 'Sample output', false, 'Parts you have made')}</div>
      <div id="wUpMsg" class="message"></div>
      <div class="pgrid" id="wPhotos">${w.photos.map(p => `<figure><img data-photo="${Number(p.id)}" alt="${escapeHtml(p.kind)} photo"><figcaption>${escapeHtml({ machine: 'Device', location: 'Entrance', sample_output: 'Sample' }[p.kind] || p.kind)}</figcaption><button class="rm" data-act="wizDelPhoto" data-arg="${Number(p.id)}" aria-label="Remove photo">×</button></figure>`).join('')}</div>`;
  }else if(st === 3){
    body = `<h2>Operating procedure</h2><p class="muted">Shown on your machine page so innovators arrive prepared.</p>
      ${wizText('wHow', 'How a job runs on this machine', w.g.how_to_use, 'For example: what to send, who operates the machine, when to collect.')}
      ${wizText('wPrep', 'Preparation (optional)', w.g.prep_notes)}
      ${wizText('wSafety', 'Safety rules', w.g.safety_notes, 'What visitors must wear or avoid, and who may touch the machine.')}
      <div class="grid2">
        ${wizInput('wFormats', 'Accepted file types', w.g.file_formats, 'placeholder="STL, 3MF, OBJ"', 'Separate with commas.')}
        ${wizInput('wLead', 'Typical turnaround (hours)', w.g.typical_lead_hrs, 'type="number" min="0"')}
      </div>
      <label class="check"><input type="checkbox" id="wOp" ${w.g.requires_operator ? 'checked' : ''}> Only our trained operator runs this machine</label>
      <div class="drop" style="max-width:360px"><span class="flabel">Detailed SOP document <span class="muted" style="font-weight:500">· optional PDF, up to 5 MB</span></span>
        <label class="zone" style="min-height:70px">${w.sop ? 'Replace ' + escapeHtml(w.sop.filename) : 'Attach PDF'}<input type="file" accept="application/pdf" id="wSop" aria-label="Attach SOP PDF"></label></div>
      <div id="wSopMsg" class="message"></div>`;
  }else{
    const ok = checks();
    body = `<h2>Review and submit</h2><p class="muted">Our team checks every listing. You'll see the result in My listings.</p>
      <div class="kv"><span>Lab</span><b>${escapeHtml(w.c.name)}</b></div>
      <div class="kv"><span>Address</span><b>${escapeHtml(w.c.address)}, ${escapeHtml(w.c.district)} ${escapeHtml(w.c.pincode)}</b></div>
      <div class="kv"><span>Device</span><b>${escapeHtml(w.m.make)} ${escapeHtml(w.m.model)}</b></div>
      <div class="kv"><span>Build size</span><b>${escapeHtml(w.m.max_x_mm)} × ${escapeHtml(w.m.max_y_mm)} × ${escapeHtml(w.m.max_z_mm)} mm</b></div>
      <div class="kv"><span>Rate</span><b>${money(w.m.rate_per_hour)} per hour</b></div>
      <div class="kv"><span>Photos</span><b>${w.photos.length}</b></div>
      <div class="kv"><span>Procedure document</span><b>${w.sop ? escapeHtml(w.sop.filename) : 'None'}</b></div>
      ${['draft','changes_requested','rejected'].includes(w.verification) ? '' : `<div class="note">This listing is ${escapeHtml(w.verification === 'pending' ? 'waiting for review' : w.verification)}.</div>`}
      <div id="wSubmitMsg" class="message"></div>
      ${ok.every(c => c[1]) && ['draft','changes_requested','rejected'].includes(w.verification) ? '' : ''}`;
  }
  const last = st === 4;
  const canSubmit = ['draft','changes_requested','rejected'].includes(w.verification);
  $('listView').innerHTML = `
    <div class="wiz-head"><a class="back" href="#/listings">← My listings</a><h1>${w.centreId ? 'Edit listing' : 'List your equipment'}</h1>
      <p class="muted">Every listing is checked by the IICHUB team before innovators can book it.</p>
      ${w.review_note && w.verification === 'changes_requested' ? `<div class="note"><b>Changes requested:</b> ${escapeHtml(w.review_note)}</div>` : ''}</div>
    <ol class="stepper">${stepper}</ol>
    <div class="wiz">
      <div class="wiz-card" data-form>${body}
        <div id="wMsg" class="message"></div>
        <div class="wiz-nav">
          <button class="btn ghost" data-act="wizBack" ${st === 0 ? 'disabled' : ''}>Back</button>
          ${last ? `<button class="btn primary" id="wSubmit" data-act="wizSubmit" ${canSubmit ? '' : 'disabled'}>Submit for review</button>`
                 : `<button class="btn primary" id="wNext" data-act="wizNext">${st === 1 && !w.machineId ? 'Save and continue' : 'Continue'}</button>`}
        </div>
      </div>
      <aside class="navy-panel"><h3>Before you submit</h3><ul>${checks().map(([t, ok]) => `<li><span class="${ok ? 'y' : 'n'}" aria-hidden="true">${ok ? '✓' : '○'}</span><span>${t}${ok ? '' : ' <span class="sr">(missing)</span>'}</span></li>`).join('')}</ul>
        <p class="small" style="margin-top:12px;color:rgba(255,255,255,.8)">Your full address and phone stay private until you confirm a booking.</p></aside>
    </div>`;
  document.querySelectorAll('.wFile').forEach(inp => inp.addEventListener('change', () => wizUpload(inp)));
  const sop = $('wSop'); if(sop) sop.addEventListener('change', () => wizUploadSop(sop));
  hydrateImages($('listView'));
}

function checks(){
  const w = wiz;
  return [
    ['Location and contact', Boolean(w.c.name && w.c.address && w.c.pincode && w.c.lat)],
    ['Device, size and rate', Boolean(w.machineId && w.m.make && w.m.rate_per_hour !== '')],
    ['Materials you offer', w.m.materials.length > 0],
    ['At least one device photo', w.photos.some(p => p.kind === 'machine')],
    ['How a job runs and safety rules', Boolean(String(w.g.how_to_use).trim() && String(w.g.safety_notes).trim())]
  ];
}

function readStep(){
  const w = wiz, n = (id) => { const v = $(id).value.trim(); return v === '' ? '' : Number(v); };
  if(w.step === 0){
    Object.assign(w.c, { name: $('wName').value.trim(), address: $('wAddr').value.trim(), district: $('wDist').value.trim(),
      state_code: $('wState').value, pincode: $('wPin').value.trim(), lat: n('wLat'), lng: n('wLng'), phone: $('wPhone').value.trim(),
      opens_at: $('wOpen').value, closes_at: $('wClose').value,
      working_days: [...document.querySelectorAll('.wDay:checked')].map(x => Number(x.value)) });
  }else if(w.step === 1){
    Object.assign(w.m, { process_code: $('wProc').value, make: $('wMake').value.trim(), model: $('wModel').value.trim(),
      max_x_mm: n('wX'), max_y_mm: n('wY'), max_z_mm: n('wZ'), rate_per_hour: n('wRate'), setup_fee: n('wSetup'), tolerance_mm: n('wTol'),
      materials: [...document.querySelectorAll('.wMat:checked')].map(x => x.value) });
  }else if(w.step === 3){
    Object.assign(w.g, { how_to_use: $('wHow').value.trim(), prep_notes: $('wPrep').value.trim(), safety_notes: $('wSafety').value.trim(),
      file_formats: $('wFormats').value, typical_lead_hrs: n('wLead'), requires_operator: $('wOp').checked });
  }
}

function payloads(){
  const w = wiz, c = { ...w.c }, m = { ...w.m }, g = { ...w.g };
  if(!c.phone) c.phone = null;
  if(!c.state_code) delete c.state_code;
  for(const k of ['setup_fee', 'tolerance_mm']) if(m[k] === '') { if(k === 'setup_fee') m[k] = 0; else m[k] = null; }
  g.file_formats = String(g.file_formats || '').split(/[,\s]+/).map(x => x.replace(/^\./, '').trim()).filter(Boolean).slice(0, 12);
  if(g.typical_lead_hrs === '') g.typical_lead_hrs = null;
  delete m.min_charge;
  return { c, m, g };
}

function wizError(e){ $('wMsg').textContent = e.message; }

async function saveStep(){
  const w = wiz;
  readStep();
  const { c, m, g } = payloads();
  if(w.step === 0){
    if(!c.name || !c.address || !c.district) throw new Error('Fill in the lab name, address and district.');
    if(!/^[1-9][0-9]{5}$/.test(c.pincode)) throw new Error('Enter a valid 6-digit PIN code.');
    if(!(c.lat >= 6 && c.lat <= 38 && c.lng >= 68 && c.lng <= 98)) throw new Error('Set the location: use "Use my current location", or copy the latitude and longitude from Google Maps.');
    if(!c.working_days.length) throw new Error('Pick at least one day you are open.');
    if(w.centreId) await api(`/owner/listings/${w.centreId}`, { method: 'PATCH', body: { centre: c } });
  }else if(w.step === 1){
    if(!m.make || !m.model) throw new Error('Enter the make and model.');
    if(!(m.max_x_mm > 0 && m.max_y_mm > 0 && m.max_z_mm > 0)) throw new Error('Enter the largest part size (all three).');
    if(m.rate_per_hour === '' || m.rate_per_hour < 0) throw new Error('Enter your rate per hour.');
    if(!m.materials.length) throw new Error('Tick at least one material you offer.');
    if(!w.centreId){
      const r = await api('/owner/listings', { method: 'POST', body: { centre: c, machine: m } });
      w.centreId = r.centre_id; w.machineId = r.machine_id; w.verification = r.verification;
      showToast('Draft saved. Next, add photos.');
    }else{
      await api(`/owner/listings/${w.centreId}`, { method: 'PATCH', body: { machine_id: w.machineId, machine: m } });
    }
  }else if(w.step === 3){
    if(w.machineId) await api(`/owner/listings/${w.centreId}`, { method: 'PATCH', body: { machine_id: w.machineId, guide: g } });
  }
}

async function wizNext(){
  const btn = $('wNext'); if(btn) btn.disabled = true;
  try{ await saveStep(); wiz.step = Math.min(4, wiz.step + 1); renderWizard(); window.scrollTo({ top: 0 }); }
  catch(e){ wizError(e); if(btn) btn.disabled = false; }
}
async function wizBack(){ try{ readStep(); }catch{} wiz.step = Math.max(0, wiz.step - 1); renderWizard(); }
async function wizGo(i){
  i = Number(i);
  if(i === wiz.step) return;
  if(i > wiz.step){ try{ await saveStep(); }catch(e){ wizError(e); return; } }
  else { try{ readStep(); }catch{} }
  if(i > 1 && !wiz.machineId){ wizError(new Error('Save the device details first.')); return; }
  wiz.step = i; renderWizard();
}
function wizLocate(){
  if(!navigator.geolocation){ wizError(new Error('Your browser cannot share its location. Enter the numbers instead.')); return; }
  navigator.geolocation.getCurrentPosition(p => {
    $('wLat').value = p.coords.latitude.toFixed(6); $('wLng').value = p.coords.longitude.toFixed(6);
  }, () => wizError(new Error('Could not get your location. Allow location access, or enter the numbers instead.')), { timeout: 10000 });
}

async function wizUpload(input){
  const files = [...input.files]; input.value = '';
  const msg = $('wUpMsg'); msg.className = 'message'; msg.textContent = '';
  for(const f of files){
    if(f.size > 5 * 1024 * 1024){ msg.textContent = `${f.name}: photos must be 5 MB or smaller.`; continue; }
    msg.className = 'message ok'; msg.textContent = `Uploading ${f.name}…`;
    try{
      const r = await fetch(`/owner/machines/${wiz.machineId}/photos?kind=${encodeURIComponent(input.dataset.kind)}`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': f.type || 'application/octet-stream' }, body: f });
      const d = await r.json().catch(() => ({}));
      if(!r.ok) throw new Error(d.error || 'Upload failed.');
      wiz.photos.push({ id: d.id, kind: input.dataset.kind });
      msg.textContent = 'Photo added.';
    }catch(e){ msg.className = 'message'; msg.textContent = `${f.name}: ${e.message}`; break; }
  }
  const keep = msg.textContent, cls = msg.className;
  renderWizard(); $('wUpMsg').textContent = keep; $('wUpMsg').className = cls;
}
async function wizDelPhoto(id){
  if(!confirm('Remove this photo?')) return;
  try{ await api(`/owner/photos/${id}`, { method: 'DELETE' }); wiz.photos = wiz.photos.filter(p => Number(p.id) !== Number(id)); renderWizard(); }
  catch(e){ showToast(e.message); }
}
async function wizUploadSop(input){
  const f = input.files[0]; if(!f) return;
  const msg = $('wSopMsg');
  readStep();
  try{
    const r = await fetch(`/owner/machines/${wiz.machineId}/sop`, { method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/pdf', 'X-Filename': f.name.replace(/[^\x20-\x7E]/g, '') }, body: f });
    const d = await r.json().catch(() => ({}));
    if(!r.ok) throw new Error(d.error || 'Upload failed.');
    wiz.sop = { filename: d.filename, size: d.size };
    renderWizard(); showToast('Procedure document attached.');
  }catch(e){ msg.textContent = e.message; }
}
async function wizSubmit(){
  const btn = $('wSubmit'); btn.disabled = true;
  try{
    await api(`/owner/listings/${wiz.centreId}/submit`, { method: 'POST', body: {} });
    wiz.verification = 'pending';
    showToast('Submitted. We will review it soon.');
    location.hash = '#/listings';
  }catch(e){ $('wSubmitMsg').textContent = e.message; btn.disabled = false; }
}

// ---------------- my listings (owners) ----------------
const LISTING_STATUS = {
  draft: ['Draft', 'draft'], pending: ['Waiting for review', 'wait'], changes_requested: ['Changes requested', 'wait'],
  verified: ['Live', 'ok'], rejected: ['Not approved', 'bad'], suspended: ['Suspended', 'bad']
};
async function showListings(){
  const box = $('listingsView');
  if(!currentUser){ showLogin('Sign in to see your listings.'); box.innerHTML = ''; return; }
  if(currentUser.role !== 'equipment_owner'){ box.innerHTML = '<div class="empty">Only equipment-owner accounts have listings.</div>'; return; }
  box.innerHTML = '<div class="empty">Loading…</div>';
  try{
    const rows = await api('/owner/listings');
    box.innerHTML = `<div class="wiz-head" style="display:flex;justify-content:space-between;align-items:end;gap:12px;flex-wrap:wrap">
        <div><h1>My listings</h1><p class="muted">Your machines on IICHUB and their review status.</p></div>
        <a class="btn primary" href="#/list/new">+ List another machine</a></div>
      ${rows.length ? rows.map(l => {
        const m = l.machines[0] || {};
        const [label, cls] = LISTING_STATUS[l.verification] || [l.verification, 'draft'];
        const photo = (m.photos || []).find(p => p.kind === 'machine') || (m.photos || [])[0];
        return `<div class="listing">
          <div class="thumb">${photo ? `<img data-photo="${Number(photo.id)}" alt="">` : icon(m.process_code, 40, 1.4)}</div>
          <div style="flex:1;min-width:220px">
            <span class="pill ${cls}">${escapeHtml(label)}</span>
            <div class="cname" style="margin-top:6px">${escapeHtml((m.make || '') + ' ' + (m.model || ''))}</div>
            <div class="cmeta">${escapeHtml(l.name)} · ${escapeHtml(l.district)} · ${money(m.rate_per_hour)}/hour</div>
            ${l.review_note && ['changes_requested','rejected'].includes(l.verification) ? `<div class="note"><b>Note from IICHUB:</b> ${escapeHtml(l.review_note)}</div>` : ''}
          </div>
          <div class="actions">
            ${l.verification === 'verified' && m.id ? `<a class="btn ghost sm" href="#/machine/${Number(m.id)}">View public page</a>` : ''}
            <a class="btn ${['draft','changes_requested'].includes(l.verification) ? 'primary' : 'ghost'} sm" href="#/list/${Number(l.id)}">${l.verification === 'draft' ? 'Continue' : 'Edit'}</a>
          </div></div>`;
      }).join('') : '<div class="empty"><b>No listings yet.</b><br><a href="#/list/new">List your first machine</a></div>'}`;
    hydrateImages(box);
  }catch(e){ box.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; }
}

// ---------------- routing ----------------
function showView(name){
  ['home','machine','list','listings','how'].forEach(v => { $('view-' + v).hidden = v !== name; });
  closeMenu();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function toggleMenu(){
  const open = !$('navlinks').classList.contains('open');
  $('navlinks').classList.toggle('open', open);
  $('menuBtn').setAttribute('aria-expanded', String(open));
}
function closeMenu(){
  $('navlinks').classList.remove('open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
}
async function route(){
  const h = location.hash || '#/';
  if(/^#(reset|verify)=/.test(h) || h === '#jobs'){ await handleLinkHash(); history.replaceState(null, '', '#/'); showView('home'); return; }
  let m;
  if((m = h.match(/^#\/machine\/(\d+)/))){ showView('machine'); await showMachine(Number(m[1])); }
  else if(h === '#/list/new'){ wiz = null; showView('list'); await showList(); }
  else if((m = h.match(/^#\/list\/(\d+)/))){ showView('list'); await showList(Number(m[1])); }
  else if(h === '#/list'){ showView('list'); await showList(); }
  else if(h === '#/listings'){ showView('listings'); await showListings(); }
  else if(h === '#/how'){ showView('how'); }
  else { showView('home'); }
}
window.addEventListener('hashchange', route);
// Clicking a link to the page you're already on still takes you there.
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#/"]');
  if(a && a.getAttribute('href') === location.hash && !a.dataset.act){ e.preventDefault(); route(); }
});
['loc','mat','tol'].forEach(id => $(id).addEventListener('change', run));
$('searchForm').addEventListener('submit', e => { e.preventDefault(); run(); });

window.ACTIONS = {
  run, pickProc, pickPhoto, toggleMenu, openSlots, selectSlot, confirmBooking, openMyJobs, acceptQuote, cancelJob, closeM,
  accountAction, showLogin, doLogin, showRegister, doRegister, showForgot, doForgot, doReset,
  showChangePassword: () => showChangePassword(false), doChangePassword, showAccount, resendVerify, signOut, signOutAll,
  wizNext, wizBack, wizGo, wizLocate, wizDelPhoto, wizSubmit
};

async function init(){
  await loadSession();
  await loadMeta();
  await route();
  await run();
}
init();
