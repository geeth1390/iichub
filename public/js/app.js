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
      <label class="check"><input id="regOwner" type="checkbox"> I own equipment and want to list it on ProtoHub</label>
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
      ${u.role==='equipment_owner'?'<p class="links">You are registered as an equipment owner. Ask the ProtoHub team to help list your machines.</p>':''}
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
  if(!confirm('Sign out of ProtoHub on every device?')) return;
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

async function run(){
  const x=Number(val('x'));
  const y=Number(val('y'));
  const z=Number(val('z'));
  const mat=val('mat');
  const tol=val('tol');
  const [lat,lng]=val('loc').split(',').map(Number);

  if(!(x>0&&y>0&&z>0)){
    renderMessage('Enter all three part dimensions.');
    return;
  }

  $('list').innerHTML='<div class="empty">Searching the machine network…</div>';

  try{
    const q=new URLSearchParams({x,y,z,lat,lng,qty:1});
    if(mat) q.set('mat',mat);
    if(tol) q.set('tol',tol);

    const payload=await api('/machines?'+q.toString());
    const rows=Array.isArray(payload)?payload:payload.value;

    if(!Array.isArray(rows)) throw new Error('Unexpected machine search response.');

    renderMachines(rows);
  }catch(e){
    $('count').textContent='';
    renderMessage('Could not load machines: '+e.message);
  }
}

function renderMessage(message){
  $('count').textContent='';
  $('list').innerHTML=`<div class="empty"><b>${escapeHtml(message)}</b></div>`;
}

function renderMachines(rows){
  $('count').textContent=rows.length+' MATCH'+(rows.length===1?'':'ES');

  if(!rows.length){
    renderMessage('No machine matches these requirements. Try changing the dimensions, material or precision.');
    return;
  }

  $('list').innerHTML=rows.map((m,i)=>{
    const id=Number(m.machine_id);
    const available=String(m.status).toLowerCase()==='available';
    const distance=m.distance_km==null?'—':`${Number(m.distance_km).toFixed(1)} km`;

    return `
      <div class="card ${available?'':'maint'}">
        <div class="fit">
          <b>${escapeHtml(distance)}</b>
          <span>${i===0&&available?'BEST MATCH':'DISTANCE'}</span>
        </div>
        <div>
          <div class="cname">${escapeHtml(m.machine||'Machine')}</div>
          <div class="cmeta">${escapeHtml(m.process_label||'')} · ${escapeHtml(m.centre_name||'')}</div>
          <div class="creason">${escapeHtml(m.reason||'')}</div>
          <div class="creason">${escapeHtml(m.district||'')}</div>
        </div>
        <div class="right">
          <div class="rate">₹${m.rate_per_hour==null?'—':Number(m.rate_per_hour).toFixed(0)}<small>/hr</small></div>
          <button class="book" ${available?'':'disabled'}
            data-act="openSlots" data-arg="${id}">${available?'Book':'Unavailable'}</button>
        </div>
      </div>`;
  }).join('');
}

function formatDate(iso){
  return new Date(iso).toLocaleDateString('en-IN',{
    weekday:'long',day:'numeric',month:'short'
  });
}
function formatTime(iso){
  return new Date(iso).toLocaleTimeString('en-IN',{
    hour:'numeric',minute:'2-digit'
  });
}
function dateKey(iso){
  const d=new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

async function openSlots(machineId){
  if(!currentUser){
    accountRequired(machineId);
    return;
  }
  if(!['innovator','equipment_owner'].includes(currentUser.role)){
    showToast('Bookings are made from an innovator account.');
    return;
  }

  try{
    openModal(`
      <div class="shead"><h3>Loading machine details…</h3></div>
      <div class="sbody">Please wait.</div>
    `);

    const profile=await api(`/machines/${machineId}/profile`);
    const slotsPayload=await api(`/machines/${machineId}/slots?days=7&mins=60`);
    const slots=Array.isArray(slotsPayload)?slotsPayload:slotsPayload.value;

    if(!Array.isArray(slots)) throw new Error('Unexpected slots response.');

    currentMachine=profile;
    currentSlots=slots.filter(s=>
      s.slot_start && s.slot_end &&
      new Date(s.slot_start).getTime()>Date.now()
    );
    selectedSlot=null;

    renderBookingForm();
  }catch(e){
    openModal(`
      <div class="shead"><h3>Could not load booking details</h3></div>
      <div class="sbody"><div class="message">${escapeHtml(e.message)}</div></div>
      <div class="sfoot"><button class="ghost" data-act="closeM">Close</button></div>
    `);
  }
}

function renderBookingForm(){
  const m=currentMachine;
  const groups={};

  currentSlots.forEach((slot,index)=>{
    const key=dateKey(slot.slot_start);
    if(!groups[key]) groups[key]=[];
    groups[key].push({...slot,index});
  });

  const days=Object.values(groups);

  const slotsHtml=days.length?days.map(day=>{
    const first=day[0].slot_start;
    return `
      <div class="day">
        <div class="dlabel">${escapeHtml(formatDate(first))}</div>
        <div class="slots">
          ${day.map(s=>`
            <button class="slot ${selectedSlot===s.index?'sel':''}"
              data-act="selectSlot" data-arg="${s.index}">
              ${escapeHtml(formatTime(s.slot_start))}
            </button>
          `).join('')}
        </div>
      </div>`;
  }).join(''):'<div class="empty">No future slots are currently available for this machine.</div>';

  openModal(`
    <div class="shead">
      <h3>${escapeHtml(m.machine||'Machine')}</h3>
      <p>${escapeHtml(m.centre_name||'')} · ${escapeHtml(m.address||'')}</p>
      <p>₹${Number(m.rate_per_hour||0).toFixed(0)}/hour · Setup ₹${Number(m.setup_fee||0).toFixed(0)}</p>
    </div>
    <div class="sbody">
      <div class="field">
        <label>Job title</label>
        <input id="jobTitle" type="text" placeholder="e.g. Drone arm bracket">
      </div>
      <div class="form-grid">
        <div class="field">
          <label>Material</label>
          <select id="jobMaterial">
            <option value="">Select material</option>
            <option value="pla">PLA</option>
            <option value="abs">ABS</option>
            <option value="petg">PETG</option>
            <option value="nylon_pa12">Nylon PA12</option>
            <option value="resin_std">Standard Resin</option>
            <option value="al_6061">Aluminium 6061</option>
            <option value="acrylic">Acrylic</option>
            <option value="mdf">MDF</option>
            <option value="fr4">FR4</option>
          </select>
        </div>
        <div class="field">
          <label>Quantity</label>
          <input id="jobQty" type="number" min="1" value="1">
        </div>
      </div>
      <div class="dlabel">Choose an available one-hour slot</div>
      ${slotsHtml}
      <div id="bookingMessage" class="message"></div>
    </div>
    <div class="sfoot">
      <div class="est">
        Estimated starting amount<br>
        <b>₹${Number(m.min_charge||0).toFixed(0)}+</b>
        <br><span style="font-size:10px">Final quote is provided by the centre.</span>
      </div>
      <button class="ghost" data-act="closeM">Cancel</button>
      <button class="go" id="confirmBookingBtn"
        data-act="confirmBooking" ${days.length?'':'disabled'}>Confirm booking</button>
    </div>
  `);
}

function selectSlot(index){
  selectedSlot=index;
  renderBookingForm();
}

async function confirmBooking(){
  if(selectedSlot===null){
    $('bookingMessage').textContent='Please select an available time slot.';
    return;
  }

  const title=$('jobTitle').value.trim();
  const material=$('jobMaterial').value;
  const qty=Number($('jobQty').value);

  if(!title){
    $('bookingMessage').textContent='Enter a title for your job.';
    return;
  }
  if(!Number.isInteger(qty)||qty<1){
    $('bookingMessage').textContent='Enter a valid quantity.';
    return;
  }

  const slot=currentSlots[selectedSlot];
  const button=$('confirmBookingBtn');
  button.disabled=true;
  button.textContent='Saving…';

  try{
    const result=await api('/bookings',{
      method:'POST',
      body:JSON.stringify({
        machine_id:Number(currentMachine.machine_id),
        slot_start:slot.slot_start,
        slot_end:slot.slot_end,
        title,
        ...(material?{material}:{}),
        qty
      })
    });

    $('sheet').innerHTML=`
      <div class="done">
        <div class="tick">✓</div>
        <h3>Booking confirmed</h3>
        <p>${escapeHtml(currentMachine.machine||'Machine')} · ${escapeHtml(currentMachine.centre_name||'')}</p>
        <p>${escapeHtml(formatDate(slot.slot_start))} at ${escapeHtml(formatTime(slot.slot_start))}</p>
        <div class="jobno">
          Booking ID: ${escapeHtml(result.booking_id)}<br>
          Job ID: ${escapeHtml(result.job_id)}<br>
          Status: ${escapeHtml(result.status)}
        </div>
        <p>The centre will review your job and send a quote.</p>
        <button class="go" style="margin-top:14px" data-act="openMyJobs">View My Jobs</button>
        <button class="ghost" style="margin-top:14px" data-act="closeM">Close</button>
      </div>
    `;
    showToast('Booking saved successfully.');
  }catch(e){
    $('bookingMessage').textContent=e.message;
    button.disabled=false;
    button.textContent='Confirm booking';
  }
}

async function openMyJobs(){
  if(!currentUser){
    pendingMachineId=null;
    showLogin();
    return;
  }

  openModal(`
    <div class="shead">
      <h3>My Jobs</h3>
      <p>Your bookings, job progress and quotes.</p>
    </div>
    <div class="sbody">Loading your jobs…</div>
  `);

  try{
    const jobs=await api('/my/jobs');
    renderMyJobs(jobs);
  }catch(e){
    openModal(`
      <div class="shead"><h3>My Jobs</h3></div>
      <div class="sbody"><div class="message">${escapeHtml(e.message)}</div></div>
      <div class="sfoot"><button class="ghost" data-act="closeM">Close</button></div>
    `);
  }
}

function renderMyJobs(jobs){
  const content=jobs.length?jobs.map(job=>{
    const status=String(job.status||'unknown');
    const hasQuote=job.quote!==null&&job.quote!==undefined;
    const canAccept=status==='quote_sent'&&hasQuote;
    const canCancel=['quote_pending','quote_sent','quote_accepted'].includes(status);
    const when=job.slot_start?`${formatDate(job.slot_start)} at ${formatTime(job.slot_start)}`:'';

    return `
      <div class="job">
        <h4>${escapeHtml(job.title||'Untitled job')}</h4>
        <div class="job-meta">${escapeHtml(job.machine||'')} · ${escapeHtml(job.centre||'')}</div>
        <div class="job-meta">Quantity: ${escapeHtml(job.quantity)}${when?' · '+escapeHtml(when):''}</div>
        <span class="job-status">${escapeHtml(status.replaceAll('_',' ').toUpperCase())}</span>
        ${hasQuote?`<div class="job-price">Quote: ₹${Number(job.quote).toFixed(2)}</div>`:
          '<div class="job-meta">Waiting for centre quote.</div>'}
        ${canAccept||canCancel?`
          <div class="job-actions">
            ${canAccept?`<button class="book" data-act="acceptQuote" data-arg="${Number(job.id)}">Accept quote</button>`:''}
            ${canCancel?`<button class="ghost" data-act="cancelJob" data-arg="${Number(job.id)}">Cancel booking</button>`:''}
          </div>`:''}
      </div>`;
  }).join(''):'<div class="empty"><b>No jobs yet.</b>Your confirmed bookings will appear here.</div>';

  openModal(`
    <div class="shead">
      <h3>My Jobs</h3>
      <p>Signed in as ${escapeHtml(currentUser?.name||currentUser?.email||'Innovator')}</p>
    </div>
    <div class="sbody">${content}</div>
    <div class="sfoot">
      <button class="ghost" data-act="closeM">Close</button>
      <button class="go" data-act="openMyJobs">Refresh</button>
    </div>
  `);
}

async function acceptQuote(jobId){
  if(!confirm('Accept the quote for this job?')) return;

  try{
    await api(`/jobs/${jobId}/accept`,{method:'POST',body:JSON.stringify({})});
    showToast('Quote accepted successfully.');
    await openMyJobs();
  }catch(e){
    showToast(e.message);
  }
}

async function cancelJob(jobId){
  if(!confirm('Cancel this booking? The time slot will be released.')) return;
  try{
    await api(`/jobs/${jobId}/cancel`,{method:'POST',body:{}});
    showToast('Booking cancelled.');
    await openMyJobs();
  }catch(e){
    showToast(e.message);
  }
}

window.ACTIONS={
  run, openSlots, selectSlot, confirmBooking, openMyJobs, acceptQuote, cancelJob, closeM,
  accountAction, showLogin, doLogin, showRegister, doRegister, showForgot, doForgot, doReset,
  showChangePassword:()=>showChangePassword(false), doChangePassword, showAccount, resendVerify, signOut, signOutAll
};

async function init(){
  await loadSession();
  await handleLinkHash();
  await run();
}
init();
