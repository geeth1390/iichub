'use strict';
// ProtoHub admin console. The server enforces every permission; this
// screen only hides what a role can't use.

const TOKEN_KEY = 'protohub_admin_token';
let token = sessionStorage.getItem(TOKEN_KEY) || '';
let me = null;
let META = { processes: [], materials: [], states: [] };
let CENTRES = [];
let USERS = [];
let MACHINES = [];
let tab = 'overview';

const $ = (id) => document.getElementById(id);
const esc = escapeHtml;
const api = makeApi({ getToken: () => token, onSessionEnded: () => logout('Your session ended. Please sign in again.') });

const ROLE_LABEL = {
  super_admin: 'Super admin', apis_admin: 'Admin', centre_manager: 'Centre manager',
  centre_staff: 'Centre staff', equipment_owner: 'Equipment owner', innovator: 'Innovator',
};
const MANAGEABLE = {
  super_admin: ['super_admin', 'apis_admin', 'centre_manager', 'centre_staff', 'equipment_owner', 'innovator'],
  apis_admin: ['centre_manager', 'centre_staff', 'equipment_owner', 'innovator'],
  centre_manager: ['centre_staff'],
};
const CENTRE_ROLES = ['centre_staff', 'centre_manager'];
const MACHINE_STATUS = ['available', 'in_use', 'maintenance', 'broken', 'offline', 'retired'];
const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const isAdmin = () => me && ['super_admin', 'apis_admin'].includes(me.role);
const isSuper = () => me && me.role === 'super_admin';

// ---------------------------------------------------------------- helpers
let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 3500);
}
function openModal(html) {
  $('sheet').innerHTML = html;
  $('modal').classList.add('on');
  const f = $('sheet').querySelector('input:not([type=hidden]):not([type=checkbox]),select');
  if (f) setTimeout(() => f.focus(), 30);
}
function closeM() { $('modal').classList.remove('on'); }
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeM(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeM(); });

function fmtDate(v) {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function money(v) { return v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function opt(value, label, selected) {
  return `<option value="${esc(value)}"${String(value) === String(selected ?? '') ? ' selected' : ''}>${esc(label)}</option>`;
}
function field(id, label, input, hint) {
  return `<div class="field"><label for="${id}">${esc(label)}</label>${input}${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
}
function inp(id, value = '', type = 'text', extra = '') {
  return `<input id="${id}" type="${type}" value="${esc(value ?? '')}" ${extra}>`;
}
function v(id) { const el = $(id); return el ? el.value.trim() : ''; }
function nv(id) { const s = v(id); return s === '' ? undefined : Number(s); }
function setMsg(text, ok) { const el = $('mMsg'); if (el) { el.textContent = text || ''; el.className = 'message' + (ok ? ' ok' : ''); } }
async function run(btnId, fn) {
  const b = $(btnId);
  if (b) b.disabled = true;
  try { await fn(); } catch (e) { setMsg(e.message); } finally { if (b) b.disabled = false; }
}

// ---------------------------------------------------------------- sign in
function showLogin(message = '') {
  $('loginScreen').classList.remove('hidden');
  $('emailStep').classList.remove('hidden');
  $('passwordStep').classList.add('hidden');
  $('loginMessage').textContent = message;
}
async function doLogin() {
  const email = $('emailInput').value.trim();
  const password = $('passwordInput').value;
  if (!email || !password) { $('loginMessage').textContent = 'Enter your email and password.'; return; }
  $('loginBtn').disabled = true;
  try {
    const r = await api('/auth/login', { method: 'POST', body: { email, password } });
    token = r.token; sessionStorage.setItem(TOKEN_KEY, token);
    $('passwordInput').value = '';
    await start();
  } catch (e) { $('loginMessage').textContent = e.message; }
  finally { $('loginBtn').disabled = false; }
}
async function doSetPassword() {
  const n = $('newInput').value;
  if (n !== $('new2Input').value) { $('loginMessage').textContent = 'The two new passwords are different.'; return; }
  $('setPwBtn').disabled = true;
  try {
    const r = await api('/auth/change-password', { method: 'POST', body: { current_password: $('tempInput').value, new_password: n } });
    token = r.token; sessionStorage.setItem(TOKEN_KEY, token);
    ['tempInput', 'newInput', 'new2Input'].forEach((id) => { $(id).value = ''; });
    await start();
  } catch (e) { $('loginMessage').textContent = e.message; }
  finally { $('setPwBtn').disabled = false; }
}
function logout(message) {
  if (token && typeof message !== 'string') api('/auth/logout-all', { method: 'POST', body: {} }).catch(() => {});
  token = ''; me = null; sessionStorage.removeItem(TOKEN_KEY);
  showLogin(typeof message === 'string' ? message : '');
}

async function start() {
  try {
    me = await api('/auth/me');
  } catch (e) { if (e.status !== 401) showLogin(e.message); return; }
  if (me.must_change_password) {
    $('loginScreen').classList.remove('hidden');
    $('emailStep').classList.add('hidden');
    $('passwordStep').classList.remove('hidden');
    $('loginMessage').textContent = 'Welcome! You signed in with a temporary password. Choose your own to continue.';
    return;
  }
  if (!MANAGEABLE[me.role]) {
    token = ''; sessionStorage.removeItem(TOKEN_KEY);
    showLogin('This account has no admin access.');
    return;
  }
  $('loginScreen').classList.add('hidden');
  $('meName').textContent = me.name;
  $('meRole').textContent = ROLE_LABEL[me.role] + (me.centre_name ? ' · ' + me.centre_name : '');
  META = await api('/meta');
  CENTRES = await api('/admin/centres');
  if (!isAdmin()) tab = 'users';
  renderTabs();
  show(tab);
}

// ---------------------------------------------------------------- tabs
function renderTabs() {
  const tabs = isAdmin()
    ? [['overview', 'Overview'], ['users', 'Accounts'], ['centres', 'Centres & listings'], ['machines', 'Machines']]
    : [['users', 'Staff accounts']];
  if (isSuper()) tabs.push(['audit', 'Audit log']);
  tabs.push(['account', 'My account']);
  $('tabs').innerHTML = tabs.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-act="show" data-arg="${k}">${l}</button>`).join('');
}
async function show(name) {
  tab = name;
  renderTabs();
  $('view').innerHTML = '<div class="empty">Loading…</div>';
  try {
    await ({ overview: viewOverview, users: viewUsers, centres: viewCentres, machines: viewMachines, audit: viewAudit, account: viewAccount }[name])();
  } catch (e) {
    $('view').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------- overview
async function viewOverview() {
  const [o, n] = await Promise.all([api('/admin/overview'), api('/national')]);
  const r = o.users_by_role;
  const cards = [
    ['Pending listings', o.pending_listings, o.pending_listings ? 'alert' : ''],
    ['Centres (live)', `${o.centres.n} (${o.centres.live})`],
    ['Machines', n.machines],
    ['Avg utilisation', Math.round((n.avg_utilisation || 0) * 100) + '%'],
    ['Innovators', r.innovator || 0],
    ['Equipment owners', r.equipment_owner || 0],
    ['Centre staff + managers', (r.centre_staff || 0) + (r.centre_manager || 0)],
    ['Admins + super admins', (r.apis_admin || 0) + (r.super_admin || 0)],
    ['Jobs awaiting quote', o.jobs_by_status.quote_pending || 0],
    ['Jobs in progress', ['quote_accepted', 'queued', 'setup', 'running', 'qc', 'ready'].reduce((a, k) => a + (o.jobs_by_status[k] || 0), 0)],
    ['Jobs collected', o.jobs_by_status.collected || 0],
    ['Idle cost / year', money(n.idle_cost_year)],
  ];
  $('view').innerHTML = `<h2>Overview</h2><p class="sub">The whole network at a glance.</p>
    <div class="cards">${cards.map(([l, val, c]) => `<div class="card ${c || ''}"><b>${esc(val)}</b><span>${esc(l)}</span></div>`).join('')}</div>
    ${o.pending_listings ? '<p><button class="btn primary" data-act="show" data-arg="centres">Review pending listings</button></p>' : ''}`;
}

// ---------------------------------------------------------------- accounts
async function viewUsers() {
  $('view').innerHTML = `<h2>${isAdmin() ? 'Accounts' : 'Staff accounts'}</h2>
    <p class="sub">${isAdmin() ? 'Create staff, managers' + (isSuper() ? ', admins' : '') + ' and owners. New accounts get a one-time temporary password.' : 'Add and manage staff for your centre.'}</p>
    <div class="toolbar" data-form>
      <input id="uq" class="grow" placeholder="Search name or email" maxlength="100">
      ${isAdmin() ? `<select id="urole"><option value="">All roles</option>${Object.keys(ROLE_LABEL).map((k) => opt(k, ROLE_LABEL[k])).join('')}</select>` : ''}
      <button class="btn ghost go" data-act="loadUsers">Search</button>
      <button class="btn primary" data-act="newUser">+ New account</button>
    </div>
    <div class="tablewrap" id="userTable"><div class="empty">Loading…</div></div>`;
  $('uq').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadUsers(); });
  if ($('urole')) $('urole').addEventListener('change', loadUsers);
  await loadUsers();
}
async function loadUsers() {
  const q = new URLSearchParams();
  if (v('uq')) q.set('q', v('uq'));
  if ($('urole') && v('urole')) q.set('role', v('urole'));
  USERS = await api('/admin/users?' + q);
  $('userTable').innerHTML = USERS.length ? `<table><thead><tr>
      <th>Name</th><th>Email</th><th>Role</th><th>Centre</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>
    ${USERS.map((u) => `<tr>
      <td>${esc(u.name)}${Number(u.id) === me.id ? ' <span class="muted">(you)</span>' : ''}</td>
      <td>${esc(u.email)}${u.phone ? `<div class="muted">${esc(u.phone)}</div>` : ''}</td>
      <td><span class="pill ${esc(u.role)}">${esc(ROLE_LABEL[u.role] || u.role)}</span></td>
      <td>${esc(u.centre_name || '—')}</td>
      <td>${u.is_active ? (u.locked ? '<span class="pill off">locked</span>' : u.must_change_password ? '<span class="pill pending">temp password</span>' : '<span class="pill live">active</span>') : '<span class="pill off">disabled</span>'}</td>
      <td class="muted">${fmtDate(u.last_login_at)}</td>
      <td class="actions">${u.can_manage ? `<button class="btn sm ghost" data-act="editUser" data-arg="${Number(u.id)}">Edit</button>
        <button class="btn sm ghost" data-act="resetUser" data-arg="${Number(u.id)}">Reset password</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>` : '<div class="empty">No accounts match.</div>';
}
function roleOptions(selected) {
  return (MANAGEABLE[me.role] || []).map((r) => opt(r, ROLE_LABEL[r], selected)).join('');
}
function centreOptions(selected) {
  const list = isAdmin() ? CENTRES.filter((c) => c.owner_type !== 'private') : CENTRES;
  return '<option value="">— none —</option>' + list.map((c) => opt(c.id, c.name, selected)).join('');
}
function toggleCentre() {
  const needs = CENTRE_ROLES.includes(v('fRole'));
  $('centreBox').classList.toggle('hidden', !needs || !isAdmin());
}
function newUser() {
  openModal(`<div data-form><div class="shead"><h3>New account</h3>
      <p>A temporary password is shown once. Give it to the person privately; they must change it at first sign-in.</p></div>
    <div class="sbody">
      <div class="grid2">${field('fName', 'Full name', inp('fName', '', 'text', 'maxlength="80"'))}
      ${field('fEmail', 'Email', inp('fEmail', '', 'email', 'maxlength="254"'))}</div>
      <div class="grid2">${field('fRole', 'Role', `<select id="fRole">${roleOptions(isAdmin() ? 'centre_staff' : 'centre_staff')}</select>`)}
      ${field('fPhone', 'Phone (optional)', inp('fPhone', '', 'tel', 'maxlength="20"'))}</div>
      <div id="centreBox">${field('fCentre', 'Centre', `<select id="fCentre">${centreOptions(me.centre_id)}</select>`)}</div>
      <div id="mMsg" class="message"></div>
    </div>
    <div class="sfoot"><button class="btn ghost" data-act="closeM">Cancel</button>
      <button class="btn go" id="mBtn" data-act="saveNewUser">Create account</button></div></div>`);
  $('fRole').addEventListener('change', toggleCentre);
  toggleCentre();
}
function saveNewUser() {
  return run('mBtn', async () => {
    const body = { name: v('fName'), email: v('fEmail'), role: v('fRole') };
    if (v('fPhone')) body.phone = v('fPhone');
    if (CENTRE_ROLES.includes(body.role) && isAdmin()) body.centre_id = nv('fCentre') ?? null;
    const r = await api('/admin/users', { method: 'POST', body });
    showTemp(`Account created for ${r.user.email}`, r.temp_password);
    loadUsers();
  });
}
function showTemp(title, temp) {
  openModal(`<div class="shead"><h3>${esc(title)}</h3>
      <p>This temporary password is shown only once. Share it privately (not by group chat or public email). It must be changed at first sign-in.</p></div>
    <div class="sbody"><div class="secret">${esc(temp)}</div>
      <p class="muted">Sign-in page: ${esc(location.origin)}/manager for centre staff, ${esc(location.origin)}/admin for admins, ${esc(location.origin)} for everyone else.</p></div>
    <div class="sfoot"><button class="btn go" data-act="closeM">Done</button></div>`);
}
function editUser(id) {
  const u = USERS.find((x) => Number(x.id) === id);
  if (!u) return;
  openModal(`<div data-form><div class="shead"><h3>Edit ${esc(u.name)}</h3><p>${esc(u.email)}</p></div>
    <div class="sbody">
      <div class="grid2">${field('fName', 'Full name', inp('fName', u.name, 'text', 'maxlength="80"'))}
      ${field('fPhone', 'Phone', inp('fPhone', u.phone || '', 'tel', 'maxlength="20"'))}</div>
      <div class="grid2">${field('fRole', 'Role', `<select id="fRole">${roleOptions(u.role)}</select>`)}
      <div id="centreBox">${field('fCentre', 'Centre', `<select id="fCentre">${centreOptions(u.centre_id)}</select>`)}</div></div>
      <label class="check"><input id="fActive" type="checkbox" ${u.is_active ? 'checked' : ''}> Account is active (untick to block sign-in)</label>
      <p class="muted">Changing the role, centre or status signs the person out everywhere.</p>
      <div id="mMsg" class="message"></div>
    </div>
    <div class="sfoot"><button class="btn ghost" data-act="closeM">Cancel</button>
      <button class="btn go" id="mBtn" data-act="saveUser" data-arg="${id}">Save</button></div></div>`);
  $('fRole').addEventListener('change', toggleCentre);
  toggleCentre();
}
function saveUser(id) {
  return run('mBtn', async () => {
    const body = { name: v('fName'), role: v('fRole'), is_active: $('fActive').checked, phone: v('fPhone') || null };
    if (isAdmin()) body.centre_id = CENTRE_ROLES.includes(body.role) ? (nv('fCentre') ?? null) : null;
    await api('/admin/users/' + id, { method: 'PATCH', body });
    closeM(); toast('Account saved'); loadUsers();
  });
}
async function resetUser(id) {
  const u = USERS.find((x) => Number(x.id) === id);
  if (!u || !confirm(`Reset the password for ${u.email}? They will be signed out and must use the new temporary password.`)) return;
  try {
    const r = await api(`/admin/users/${id}/reset-password`, { method: 'POST', body: {} });
    showTemp(`New temporary password for ${u.email}`, r.temp_password);
    loadUsers();
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------- centres
async function viewCentres() {
  CENTRES = await api('/admin/centres');
  const pending = CENTRES.filter((c) => c.owner_type === 'private');
  const own = CENTRES.filter((c) => c.owner_type !== 'private');
  $('view').innerHTML = `<h2>Centres & listings</h2>
    <p class="sub">Government and partner centres you run, and machines listed by private owners. Private listings stay hidden from search until approved.</p>
    <div class="section"><div class="toolbar"><b>Private listings</b></div>
    <div class="tablewrap">${pending.length ? `<table><thead><tr><th>Listing</th><th>Owner</th><th>Location</th><th>Machines</th><th>Fee</th><th>Status</th><th></th></tr></thead><tbody>
      ${pending.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.owner_name || '')}<div class="muted">${esc(c.owner_email || '')}</div></td>
        <td>${esc(c.district)}<div class="muted">${esc(c.address)}</div></td><td>${c.machines}</td><td>${Number(c.platform_fee_pct)}%</td>
        <td><span class="pill ${esc(c.verification)}">${esc(c.verification)}</span></td>
        <td class="actions"><button class="btn sm ghost" data-act="machinesFor" data-arg="${Number(c.id)}">Machines</button>
          <button class="btn sm primary" data-act="reviewListing" data-arg="${Number(c.id)}">Review</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No private listings yet.</div>'}</div></div>
    <div class="section"><div class="toolbar"><b class="grow">Centres</b><button class="btn primary" data-act="editCentre" data-arg="0">+ New centre</button></div>
    <div class="tablewrap"><table><thead><tr><th>Centre</th><th>State / zone</th><th>Hours</th><th>Machines</th><th>Status</th><th></th></tr></thead><tbody>
      ${own.map((c) => `<tr><td>${esc(c.name)}<div class="muted">${esc(c.operator || '')} · ${esc(c.owner_type)}</div></td>
        <td>${esc(c.state_name || '—')}<div class="muted">${esc(c.zone || '')} · ${esc(c.district)}</div></td>
        <td class="muted">${esc(String(c.opens_at).slice(0, 5))}–${esc(String(c.closes_at).slice(0, 5))}<br>${(c.working_days || []).map((d) => DAY[d]).join(' ')}</td>
        <td>${c.machines}</td><td>${c.is_live ? '<span class="pill live">live</span>' : '<span class="pill off">not live</span>'}</td>
        <td class="actions"><button class="btn sm ghost" data-act="machinesFor" data-arg="${Number(c.id)}">Machines</button>
          <button class="btn sm ghost" data-act="editCentre" data-arg="${Number(c.id)}">Edit</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
}
function reviewListing(id) {
  const c = CENTRES.find((x) => Number(x.id) === id);
  openModal(`<div data-form><div class="shead"><h3>${esc(c.name)}</h3><p>${esc(c.owner_name || '')} · ${esc(c.owner_email || '')}<br>${esc(c.address)}, ${esc(c.district)}</p></div>
    <div class="sbody">
      <p class="muted" style="margin-bottom:10px">Check the owner, the address and the machines before approving. Approved listings appear in search and can be booked.</p>
      <div class="grid2">${field('fVer', 'Decision', `<select id="fVer">${[['verified', 'Approve (verified)'], ['rejected', 'Reject'], ['suspended', 'Suspend'], ['pending', 'Back to pending']].map(([k, l]) => opt(k, l, c.verification === 'pending' ? 'verified' : c.verification)).join('')}</select>`)}
      ${field('fFee', 'Platform fee %', inp('fFee', c.platform_fee_pct, 'number', 'min="0" max="100" step="0.5"'), 'ProtoHub’s share of each job at this centre.')}</div>
      <div id="mMsg" class="message"></div></div>
    <div class="sfoot"><button class="btn ghost" data-act="closeM">Cancel</button>
      <button class="btn go" id="mBtn" data-act="saveListing" data-arg="${id}">Save decision</button></div></div>`);
}
function saveListing(id) {
  return run('mBtn', async () => {
    await api(`/admin/centres/${id}/verification`, { method: 'POST', body: { verification: v('fVer'), platform_fee_pct: nv('fFee') } });
    closeM(); toast('Listing updated'); viewCentres();
  });
}
function editCentre(id) {
  const c = id ? CENTRES.find((x) => Number(x.id) === id) : { opens_at: '09:00', closes_at: '17:30', working_days: [1, 2, 3, 4, 5, 6], is_live: false, owner_type: 'government' };
  openModal(`<div data-form><div class="shead"><h3>${id ? 'Edit ' + esc(c.name) : 'New centre'}</h3>
      <p>Opening hours decide which time slots innovators can book (Indian time).</p></div>
    <div class="sbody">
      ${field('cName', 'Centre name', inp('cName', c.name, 'text', 'maxlength="120"'))}
      ${field('cAddress', 'Address', inp('cAddress', c.address, 'text', 'maxlength="300"'))}
      <div class="grid3">${field('cDistrict', 'District / city', inp('cDistrict', c.district, 'text', 'maxlength="80"'))}
      ${field('cState', 'State', `<select id="cState"><option value="">—</option>${META.states.map((s) => opt(s.code, s.name, c.state_code)).join('')}</select>`)}
      ${field('cZone', 'Zone', inp('cZone', c.zone, 'text', 'maxlength="60"'))}</div>
      <div class="grid3">${field('cLat', 'Latitude', inp('cLat', c.lat, 'number', 'step="0.000001"'))}
      ${field('cLng', 'Longitude', inp('cLng', c.lng, 'number', 'step="0.000001"'))}
      ${field('cPhone', 'Phone', inp('cPhone', c.phone, 'tel', 'maxlength="30"'))}</div>
      <div class="grid3">${field('cOpen', 'Opens', inp('cOpen', String(c.opens_at).slice(0, 5), 'time'))}
      ${field('cClose', 'Closes', inp('cClose', String(c.closes_at).slice(0, 5), 'time'))}
      ${field('cOwner', 'Type', `<select id="cOwner">${['government', 'institution', 'partner'].map((k) => opt(k, k, c.owner_type)).join('')}</select>`)}</div>
      ${field('cOperator', 'Operator', inp('cOperator', c.operator, 'text', 'maxlength="60" placeholder="e.g. RTIH, T-Works"'))}
      <div class="field"><label>Working days</label><div class="days">${[1, 2, 3, 4, 5, 6, 7].map((d) => `<label><input type="checkbox" class="cDay" value="${d}" ${(c.working_days || []).includes(d) ? 'checked' : ''}> ${DAY[d]}</label>`).join('')}</div></div>
      <label class="check"><input id="cLive" type="checkbox" ${c.is_live ? 'checked' : ''}> Live — shown in search and open for bookings</label>
      <div id="mMsg" class="message"></div></div>
    <div class="sfoot"><button class="btn ghost" data-act="closeM">Cancel</button>
      <button class="btn go" id="mBtn" data-act="saveCentre" data-arg="${id}">Save centre</button></div></div>`);
}
function saveCentre(id) {
  return run('mBtn', async () => {
    const body = {
      name: v('cName'), address: v('cAddress'), district: v('cDistrict'),
      state_code: v('cState') || null, zone: v('cZone') || null, phone: v('cPhone') || null,
      lat: nv('cLat'), lng: nv('cLng'), opens_at: v('cOpen'), closes_at: v('cClose'),
      owner_type: v('cOwner'), operator: v('cOperator') || null, is_live: $('cLive').checked,
      working_days: [...document.querySelectorAll('.cDay:checked')].map((x) => Number(x.value)),
    };
    if (body.lat === undefined || body.lng === undefined) throw new Error('Enter the latitude and longitude (find them on Google Maps).');
    if (id) await api('/admin/centres/' + id, { method: 'PATCH', body });
    else await api('/admin/centres', { method: 'POST', body });
    closeM(); toast('Centre saved'); viewCentres();
  });
}

// ---------------------------------------------------------------- machines
let machineCentre = '';
function machinesFor(id) { machineCentre = String(id); show('machines'); }
async function viewMachines() {
  if (!CENTRES.length) CENTRES = await api('/admin/centres');
  $('view').innerHTML = `<h2>Machines</h2><p class="sub">Capabilities decide what each machine is matched to; rates decide quotes.</p>
    <div class="toolbar"><select id="mCentre" class="grow"><option value="">All centres</option>${CENTRES.map((c) => opt(c.id, c.name, machineCentre)).join('')}</select>
      <button class="btn primary" data-act="editMachine" data-arg="0">+ New machine</button></div>
    <div class="tablewrap" id="machineTable"><div class="empty">Loading…</div></div>`;
  $('mCentre').addEventListener('change', () => { machineCentre = v('mCentre'); loadMachines(); });
  await loadMachines();
}
async function loadMachines() {
  MACHINES = await api('/admin/machines' + (machineCentre ? '?centre_id=' + machineCentre : ''));
  $('machineTable').innerHTML = MACHINES.length ? `<table><thead><tr><th>Machine</th><th>Centre</th><th>Build size (mm)</th><th>Rate</th><th>Materials</th><th>Status</th><th></th></tr></thead><tbody>
    ${MACHINES.map((m) => `<tr><td>${esc(m.make)} ${esc(m.model)}<div class="muted">${esc(m.process_label)}${m.asset_tag ? ' · ' + esc(m.asset_tag) : ''}</div></td>
      <td>${esc(m.centre_name)}</td>
      <td class="muted">${m.max_x_mm ? `${Number(m.max_x_mm)}×${Number(m.max_y_mm)}×${Number(m.max_z_mm)}` : '—'}${m.tolerance_mm ? `<br>±${Number(m.tolerance_mm)}` : ''}</td>
      <td>${money(m.rate_per_hour)}/hr<div class="muted">setup ${money(m.setup_fee)} · min ${money(m.min_charge)}</div></td>
      <td class="muted">${(m.materials || []).map((x) => `${esc(x.code)} (${Math.round(x.in_stock_g)}g)`).join(', ') || '—'}</td>
      <td><span class="pill ${m.status === 'available' ? 'live' : 'off'}">${esc(m.status.replace('_', ' '))}</span></td>
      <td class="actions"><button class="btn sm ghost" data-act="materialFor" data-arg="${Number(m.id)}">+ Material</button>
        <button class="btn sm ghost" data-act="editMachine" data-arg="${Number(m.id)}">Edit</button></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">No machines here yet.</div>';
}
function editMachine(id) {
  const m = id ? MACHINES.find((x) => Number(x.id) === id) : { status: 'available', setup_fee: 0, min_charge: 0, student_discount_pct: 0, centre_id: machineCentre };
  openModal(`<div data-form><div class="shead"><h3>${id ? 'Edit ' + esc(m.make + ' ' + m.model) : 'New machine'}</h3></div>
    <div class="sbody">
      <div class="grid2">${field('xCentre', 'Centre', id ? `<input disabled value="${esc(m.centre_name)}">` : `<select id="xCentre">${CENTRES.map((c) => opt(c.id, c.name, m.centre_id)).join('')}</select>`)}
      ${field('xProcess', 'Process', `<select id="xProcess">${META.processes.map((p) => opt(p.code, p.label, m.process_code)).join('')}</select>`)}</div>
      <div class="grid3">${field('xMake', 'Make', inp('xMake', m.make, 'text', 'maxlength="60"'))}
      ${field('xModel', 'Model', inp('xModel', m.model, 'text', 'maxlength="60"'))}
      ${field('xTag', 'Asset tag', inp('xTag', m.asset_tag, 'text', 'maxlength="60"'))}</div>
      <div class="grid3">${field('xRate', 'Rate ₹/hour', inp('xRate', m.rate_per_hour, 'number', 'min="0"'))}
      ${field('xSetup', 'Setup fee ₹', inp('xSetup', m.setup_fee, 'number', 'min="0"'))}
      ${field('xMin', 'Minimum charge ₹', inp('xMin', m.min_charge, 'number', 'min="0"'))}</div>
      <div class="grid3">${field('xDisc', 'Student discount %', inp('xDisc', m.student_discount_pct, 'number', 'min="0" max="100"'))}
      ${field('xStatus', 'Status', `<select id="xStatus">${MACHINE_STATUS.map((s) => opt(s, s.replace('_', ' '), m.status)).join('')}</select>`)}
      ${field('xFinish', 'Surface finish', `<select id="xFinish"><option value="">—</option>${['rough', 'standard', 'fine', 'mirror'].map((s) => opt(s, s, m.surface_finish)).join('')}</select>`)}</div>
      <div class="grid3">${field('xX', 'Max X mm', inp('xX', m.max_x_mm, 'number', 'min="0"'))}
      ${field('xY', 'Max Y mm', inp('xY', m.max_y_mm, 'number', 'min="0"'))}
      ${field('xZ', 'Max Z mm', inp('xZ', m.max_z_mm, 'number', 'min="0"'))}</div>
      <div class="grid3">${field('xTol', 'Tolerance ± mm', inp('xTol', m.tolerance_mm, 'number', 'min="0" step="0.001"'))}
      ${field('xFeat', 'Min feature mm', inp('xFeat', m.min_feature_mm, 'number', 'min="0" step="0.001"'))}
      ${field('xLayer', 'Min layer mm', inp('xLayer', m.layer_min_mm, 'number', 'min="0" step="0.001"'))}</div>
      <div id="mMsg" class="message"></div></div>
    <div class="sfoot"><button class="btn ghost" data-act="closeM">Cancel</button>
      <button class="btn go" id="mBtn" data-act="saveMachine" data-arg="${id}">Save machine</button></div></div>`);
}
function saveMachine(id) {
  return run('mBtn', async () => {
    const pos = (x) => (x === undefined || x <= 0 ? null : x);
    const body = {
      process_code: v('xProcess'), make: v('xMake'), model: v('xModel'), asset_tag: v('xTag') || null,
      rate_per_hour: nv('xRate'), setup_fee: nv('xSetup') ?? 0, min_charge: nv('xMin') ?? 0,
      student_discount_pct: nv('xDisc') ?? 0, status: v('xStatus'), surface_finish: v('xFinish') || null,
      max_x_mm: nv('xX'), max_y_mm: nv('xY'), max_z_mm: nv('xZ'),
      tolerance_mm: pos(nv('xTol')), min_feature_mm: pos(nv('xFeat')), layer_min_mm: pos(nv('xLayer')),
    };
    if (body.rate_per_hour === undefined) throw new Error('Enter the hourly rate.');
    if (!(body.max_x_mm > 0 && body.max_y_mm > 0 && body.max_z_mm > 0)) throw new Error('Enter the build size (X, Y and Z).');
    if (id) await api('/admin/machines/' + id, { method: 'PATCH', body });
    else await api('/admin/machines', { method: 'POST', body: { centre_id: Number(v('xCentre')), ...body } });
    closeM(); toast('Machine saved'); loadMachines();
  });
}
function materialFor(id) {
  const m = MACHINES.find((x) => Number(x.id) === id);
  openModal(`<div data-form><div class="shead"><h3>Material for ${esc(m.make + ' ' + m.model)}</h3>
      <p>Adds a material this machine can use (or updates its price). Staff add stock from the manager console.</p></div>
    <div class="sbody"><div class="grid3">
      ${field('yMat', 'Material', `<select id="yMat">${META.materials.map((x) => opt(x.code, x.label)).join('')}</select>`)}
      ${field('yCost', 'Cost ₹ per gram', inp('yCost', '', 'number', 'min="0" step="0.01"'))}
      ${field('yReorder', 'Reorder below (g)', inp('yReorder', '', 'number', 'min="0"'))}</div>
      <div id="mMsg" class="message"></div></div>
    <div class="sfoot"><button class="btn ghost" data-act="closeM">Cancel</button>
      <button class="btn go" id="mBtn" data-act="saveMaterial" data-arg="${id}">Save material</button></div></div>`);
}
function saveMaterial(id) {
  return run('mBtn', async () => {
    const body = {};
    if (nv('yCost') !== undefined) body.cost_per_gram = nv('yCost');
    if (nv('yReorder') !== undefined) body.reorder_at_g = nv('yReorder');
    await api(`/admin/machines/${id}/materials/${encodeURIComponent(v('yMat'))}`, { method: 'PUT', body });
    closeM(); toast('Material saved'); loadMachines();
  });
}

// ---------------------------------------------------------------- audit
async function viewAudit() {
  $('view').innerHTML = `<h2>Audit log</h2><p class="sub">Sign-ins, account changes and other sensitive actions. Only super admins can see this.</p>
    <div class="toolbar" data-form><select id="aAction"><option value="">All actions</option>
      ${['auth.', 'auth.login', 'user.', 'centre.', 'machine.', 'job.', 'booking.', 'stock.'].map((a) => opt(a, a)).join('')}</select>
      <label class="check" style="margin:0"><input id="aFailed" type="checkbox"> Failed only</label>
      <button class="btn ghost go" data-act="loadAudit">Refresh</button></div>
    <div class="tablewrap" id="auditTable"><div class="empty">Loading…</div></div>`;
  $('aAction').addEventListener('change', loadAudit);
  $('aFailed').addEventListener('change', loadAudit);
  await loadAudit();
}
async function loadAudit() {
  const q = new URLSearchParams({ limit: 300 });
  if (v('aAction')) q.set('action', v('aAction'));
  if ($('aFailed').checked) q.set('failed', 'true');
  const rows = await api('/admin/audit?' + q);
  $('auditTable').innerHTML = rows.length ? `<table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>On</th><th>Details</th><th>IP</th></tr></thead><tbody>
    ${rows.map((a) => `<tr><td class="muted">${fmtDate(a.at)}</td>
      <td>${esc(a.actor_email || (a.actor_role || 'system'))}</td>
      <td>${a.ok ? '' : '<span class="pill off">failed</span> '}${esc(a.action)}</td>
      <td class="muted">${a.object_type ? esc(a.object_type + ' ' + (a.object_id ?? '')) : ''}</td>
      <td class="muted">${esc(a.detail ? JSON.stringify(a.detail) : '')}${a.error ? ' · ' + esc(a.error) : ''}</td>
      <td class="muted">${esc(a.ip || '')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing logged yet.</div>';
}

// ---------------------------------------------------------------- my account
async function viewAccount() {
  $('view').innerHTML = `<h2>My account</h2><p class="sub">${esc(me.email)} · ${esc(ROLE_LABEL[me.role])}</p>
    <div class="tablewrap" style="max-width:520px;padding:18px" data-form>
      ${field('pCur', 'Current password', inp('pCur', '', 'password', 'autocomplete="current-password" maxlength="128"'))}
      ${field('pNew', 'New password', inp('pNew', '', 'password', 'autocomplete="new-password" maxlength="128"'), 'At least 10 characters; for admin accounts use 14+ (four random words works well).')}
      ${field('pNew2', 'Type it again', inp('pNew2', '', 'password', 'autocomplete="new-password" maxlength="128"'))}
      <div id="mMsg" class="message"></div>
      <button class="btn go" id="mBtn" data-act="changePassword">Change password</button>
      <button class="btn ghost" data-act="signOutAll">Sign out on all devices</button>
    </div>`;
}
function changePassword() {
  return run('mBtn', async () => {
    if (v('pNew') !== $('pNew2').value.trim()) throw new Error('The two new passwords are different.');
    const r = await api('/auth/change-password', { method: 'POST', body: { current_password: $('pCur').value, new_password: $('pNew').value } });
    token = r.token; sessionStorage.setItem(TOKEN_KEY, token);
    ['pCur', 'pNew', 'pNew2'].forEach((id) => { $(id).value = ''; });
    setMsg('Password changed. Other devices have been signed out.', true);
  });
}
async function signOutAll() {
  if (!confirm('Sign out of ProtoHub on every device, including this one?')) return;
  logout();
}

window.ACTIONS = {
  doLogin, doSetPassword, logout: () => logout(), show, closeM,
  loadUsers, newUser, saveNewUser, editUser, saveUser, resetUser,
  reviewListing, saveListing, editCentre, saveCentre, machinesFor,
  editMachine, saveMachine, materialFor, saveMaterial, loadAudit, changePassword, signOutAll,
};

if (token) start(); else showLogin();
