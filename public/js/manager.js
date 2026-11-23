'use strict';
const MATLABEL = {
  pla:'PLA',abs:'ABS',petg:'PETG',nylon_pa12:'Nylon PA12',
  resin_std:'Resin',al_6061:'Aluminium 6061',acrylic:'Acrylic',
  mdf:'MDF',fr4:'FR4'
};
const NEXT = {
  quote_accepted:{to:'queued',label:'Add to queue',prime:true},
  queued:{to:'setup',label:'Start setup',prime:true},
  setup:{to:'running',label:'Begin run',prime:true},
  running:{to:'qc',label:'Move to QC'},
  qc:{to:'ready',label:'Pass QC'},
  ready:{to:'collected',label:'Mark collected'}
};
const STLABEL = {
  quote_pending:'Needs quote',quote_sent:'Quote sent',
  quote_accepted:'Quote accepted',queued:'Queued',setup:'In setup',
  running:'Running',qc:'In QC',ready:'Ready for pickup',
  collected:'Collected',cancelled:'Cancelled',failed:'Failed'
};
let token = sessionStorage.getItem('protohub_manager_token') || '';
let currentUser = null;
let centreId = null;
let JOBS = [];
let STOCK = [];
let MACHINE_STATUS = [];
let QJOB = null;
let toastTimer = null;

const esc = escapeHtml;
function money(value){
  const n = Number(value);
  return Number.isFinite(n) ? '₹'+n.toFixed(2) : '—';
}
function toast(message){
  const el=document.getElementById('toast');
  el.textContent=message;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.remove('on'),3000);
}
const api = makeApi({
  getToken: () => token,
  onSessionEnded: () => logout('Your session ended. Please sign in again.')
});
const $ = id => document.getElementById(id);

function showLogin(message=''){
  $('loginScreen').classList.remove('hidden');
  $('passwordStep').classList.add('hidden');
  $('emailStep').classList.remove('hidden');
  $('loginMessage').textContent=message;
}
function hideLogin(){
  $('loginScreen').classList.add('hidden');
}
async function doLogin(){
  const email=$('emailInput').value.trim();
  const password=$('passwordInput').value;
  if(!email||!password){ $('loginMessage').textContent='Enter your email and password.'; return; }
  const btn=$('loginBtn');
  btn.disabled=true;
  try{
    const result=await api('/auth/login',{method:'POST',body:{email,password}});
    token=result.token;
    sessionStorage.setItem('protohub_manager_token',token);
    $('passwordInput').value='';
    await loadSession();
  }catch(e){
    $('loginMessage').textContent=e.message;
  }finally{btn.disabled=false;}
}
function showSetPassword(){
  $('emailStep').classList.add('hidden');
  $('passwordStep').classList.remove('hidden');
  $('loginScreen').classList.remove('hidden');
  $('loginMessage').textContent='You signed in with a temporary password. Choose your own to continue.';
}
async function doSetPassword(){
  const cur=$('tempInput').value, n=$('newInput').value;
  if(n!==$('new2Input').value){ $('loginMessage').textContent='The two new passwords are different.'; return; }
  const btn=$('setPwBtn'); btn.disabled=true;
  try{
    const r=await api('/auth/change-password',{method:'POST',body:{current_password:cur,new_password:n}});
    token=r.token; sessionStorage.setItem('protohub_manager_token',token);
    ['tempInput','newInput','new2Input'].forEach(id=>$(id).value='');
    await loadSession();
  }catch(e){ $('loginMessage').textContent=e.message; }
  finally{ btn.disabled=false; }
}
async function loadSession(){
  try{
    currentUser = await api('/auth/me');
    if(currentUser.must_change_password){ showSetPassword(); return; }
    if(!['centre_manager','centre_staff','apis_admin','super_admin'].includes(currentUser.role)){
      throw new Error('This account does not have manager console access. Innovators sign in on the main site.');
    }
    const isAdmin=['apis_admin','super_admin'].includes(currentUser.role);
    $('managerName').textContent=currentUser.name||'Manager';
    $('adminLink').classList.toggle('hidden',!(isAdmin||currentUser.role==='centre_manager'));
    if(isAdmin){
      const centres=await api('/admin/centres');
      const pick=$('centrePick');
      pick.innerHTML=centres.map(c=>`<option value="${Number(c.id)}">${esc(c.name)}${c.is_live?'':' (not live)'}</option>`).join('');
      const saved=Number(sessionStorage.getItem('protohub_manager_centre'));
      centreId=centres.some(c=>Number(c.id)===saved)?saved:Number(centres[0]&&centres[0].id);
      pick.value=String(centreId);
      pick.classList.remove('hidden');
      $('managerCentre').textContent=currentUser.role.replace('_',' ')+' · viewing any centre';
    }else{
      centreId=currentUser.centre_id;
      if(!centreId) throw new Error('This account has no centre assigned. Ask an administrator to assign a centre.');
      $('centrePick').classList.add('hidden');
      $('managerCentre').textContent=(currentUser.centre_name||('Centre '+centreId))+' · '+currentUser.role.replace('_',' ');
    }
    hideLogin();
    await refreshAll();
  }catch(e){
    if(e.status===401) return;
    sessionStorage.removeItem('protohub_manager_token');
    token='';
    showLogin(e.message);
  }
}
function pickCentre(){
  centreId=Number($('centrePick').value);
  sessionStorage.setItem('protohub_manager_centre',String(centreId));
  refreshAll();
}
function logout(message=''){
  if(token && !message) api('/auth/logout-all',{method:'POST',body:{}}).catch(()=>{});
  token='';
  currentUser=null;
  centreId=null;
  sessionStorage.removeItem('protohub_manager_token');
  showLogin(typeof message==='string'?message:'');
}

function mapJob(row){
  return {
    id:Number(row.job_id),
    title:row.title||'Untitled job',
    status:row.status,
    machine:row.machine||'Machine not specified',
    innovator:row.innovator||'Innovator',
    affiliation:row.affiliation||'',
    phone:row.phone||'',
    material:row.material_code||'',
    qty:Number(row.quantity||1),
    quote:row.current_quote==null?null:Number(row.current_quote)
  };
}
async function loadQueue(){
  const rows=await api('/queue/'+centreId);
  JOBS=(Array.isArray(rows)?rows:[]).map(mapJob);
}
async function loadStats(){
  const data=await api('/centre/'+centreId+'/today');
  const stats=[
    ['awaiting quote',data.awaiting_quote||0,'alert'],
    ['active jobs',data.active_jobs||0,''],
    ['ready for pickup',data.ready_pickup||0,''],
    ['jobs collected',data.collected_jobs||0,''],
    ['machines up',data.machines_up||0,''],
    ['machines down',data.machines_down||0,data.machines_down?'down':''],
    ['low stock',data.low_stock_items||0,data.low_stock_items?'alert':'']
  ];
  document.getElementById('stats').innerHTML=stats.map(([label,value,cls])=>
    '<div class="stat '+cls+'"><b>'+Number(value)+'</b><span>'+esc(label)+'</span></div>'
  ).join('');
}
async function loadResources(){
  const rows=await api('/centre/'+centreId+'/resources');
  const list=Array.isArray(rows)?rows:[];
  const machines=new Map();
  STOCK=[];
  for(const r of list){
    const id=Number(r.machine_id);
    if(!machines.has(id)){
      machines.set(id,{
        id,name:r.machine_name||('Machine '+id),
        status:r.machine_status||'unknown'
      });
    }
    if(r.material_code){
      const have=Number(r.in_stock_g||0);
      const reorder=Number(r.reorder_at_g||0);
      STOCK.push({
        machineId:id,machine:r.machine_name||('Machine '+id),
        mat:r.material_code,have,reorder,
        cap:Math.max(have,reorder*4,1000)
      });
    }
  }
  MACHINE_STATUS=[...machines.values()];
}
async function refreshAll(){
  try{
    await Promise.all([loadQueue(),loadStats(),loadResources()]);
    renderAll();
  }catch(e){
    toast('Could not refresh dashboard: '+e.message);
  }
}
function priority(s){
  return s==='quote_pending'?0:
    ['running','setup','qc'].includes(s)?2:s==='queued'?1:3;
}
function jobClass(s){
  return ['quote_pending','quote_accepted','queued'].includes(s)?'act':
    ['setup','running','qc'].includes(s)?'run':'wait';
}
function renderQueue(){
  const active=JOBS.filter(j=>!['collected','cancelled','failed','draft'].includes(j.status))
    .sort((a,b)=>priority(a.status)-priority(b.status)||a.id-b.id);
  document.getElementById('qcount').textContent=
    active.length+' OPEN · '+JOBS.filter(j=>j.status==='quote_pending').length+' NEED QUOTES';
  document.getElementById('queue').innerHTML=active.map(j=>{
    let action='';
    if(j.status==='quote_pending'){
      action='<button class="act-btn prime" data-act="openQuote" data-arg="'+j.id+'">Price this job</button>';
    }else if(j.status==='quote_sent'){
      action='<div class="wait-note">Awaiting innovator</div>';
    }else if(NEXT[j.status]){
      const n=NEXT[j.status];
      action='<button class="act-btn '+(n.prime?'prime':'')+'" data-act="advance" data-arg="'+j.id+'">'+esc(n.label)+'</button>';
    }else{
      action='<div class="wait-note">—</div>';
    }
    return `<div class="job ${jobClass(j.status)}">
      <div class="jid">JOB<b>${String(j.id).padStart(3,'0')}</b></div>
      <div>
        <div class="jtitle">${esc(j.title)}</div>
        <div class="jmeta">${esc(j.innovator)} · ${esc(j.machine)} · ×${j.qty}</div>
        <div class="jtags">
          <span class="tag">${esc(j.affiliation)}</span>
          <span class="tag">${esc(MATLABEL[j.material]||j.material)}</span>
          ${j.quote!==null?'<span class="tag q">'+money(j.quote)+'</span>':''}
        </div>
      </div>
      <div class="jright">
        <div class="status-lbl">${esc(STLABEL[j.status]||j.status)}</div>
        ${action}
      </div>
    </div>`;
  }).join('')||'<div class="empty"><b>Queue clear</b>Nothing needs attention right now.</div>';
}
function renderStock(){
  const low=STOCK.filter(s=>s.have<=s.reorder).length;
  const h=document.getElementById('stockhead');
  h.textContent=low?'On hand · '+low+' low':'On hand';
  h.className=low?'warn':'';
  document.getElementById('stock').innerHTML=STOCK.map((s,i)=>{
    const pct=Math.min(100,Math.round(s.have/s.cap*100));
    const isLow=s.have<=s.reorder;
    return `<div class="stock">
      <div class="bar">
        <div class="sname">${esc(MATLABEL[s.mat]||s.mat)}</div>
        <div class="smeta">${esc(s.machine)} · ${Math.round(s.have)}g${isLow?' · below '+s.reorder+'g':''}</div>
        <div class="meter"><i class="${isLow?'low':''}" style="width:${pct}%"></i></div>
      </div>
      <button class="restock" data-act="restock" data-arg="${i}">+ Stock</button>
    </div>`;
  }).join('')||'<div class="empty">No material stock records found.</div>';
}
function renderMachines(){
  const dot={available:'var(--verd)',in_use:'var(--safety)',maintenance:'var(--oxide)',broken:'var(--oxide)'};
  document.getElementById('machines').innerHTML=MACHINE_STATUS.map(m=>`
    <div class="stock"><div class="bar">
      <div class="sname">${esc(m.name)}</div>
      <div class="smeta" style="color:${dot[m.status]||'var(--steel-500)'}">● ${esc(m.status.replace('_',' '))}</div>
    </div>
    <button class="restock" data-act="${m.status==='maintenance'?'endMaintenance':'startMaintenance'}" data-arg="${m.id}">${m.status==='maintenance'?'Mark fixed':'Maintenance'}</button>
    </div>`).join('')||'<div class="empty">No machines found.</div>';
}
function renderAll(){renderQueue();renderStock();renderMachines();}

function openQuote(id){
  QJOB=JOBS.find(j=>j.id===id);
  if(!QJOB)return;
  document.getElementById('sheet').innerHTML=`
    <div class="shead">
      <h3>Price JOB${String(id).padStart(3,'0')} — ${esc(QJOB.title)}</h3>
      <p>${esc(QJOB.innovator)} · ${esc(QJOB.machine)} · ${esc(MATLABEL[QJOB.material]||QJOB.material)} · qty ${QJOB.qty}</p>
    </div>
    <div class="sbody">
      <div class="row2">
        <div class="field"><label>Machine time (minutes)</label><input id="q_min" type="number" value="60" min="1"></div>
        <div class="field"><label>Material (grams)</label><input id="q_g" type="number" value="50" min="0"></div>
      </div>
      <p style="font-size:12px;color:var(--steel-500)">The total is worked out from this machine's rates, setup fee, minimum charge and any student discount.</p>
      <div id="quoteResult" style="margin-top:12px;font-weight:600"></div>
    </div>
    <div class="sfoot">
      <button class="ghost" data-act="closeM">Cancel</button>
      <button class="send" id="sendQuoteBtn" data-act="sendQuote">Save and send quote</button>
    </div>`;
  document.getElementById('modal').classList.add('on');
}
async function sendQuote(){
  if(!QJOB)return;
  const minutes=Number(document.getElementById('q_min').value);
  const grams=Number(document.getElementById('q_g').value);
  if(!Number.isFinite(minutes)||minutes<=0||!Number.isFinite(grams)||grams<0){
    toast('Enter valid machine time and material grams');return;
  }
  const btn=document.getElementById('sendQuoteBtn');
  btn.disabled=true;
  try{
    const result=await api('/jobs/'+QJOB.id+'/quote',{
      method:'POST',
      body:{minutes:Math.round(minutes),grams,note:'Manager console quote'}
    });
    closeM();
    toast('Quote saved: '+money(result.total));
    await refreshAll();
  }catch(e){
    document.getElementById('quoteResult').textContent=e.message;
    toast('Quote failed: '+e.message);
  }finally{btn.disabled=false;}
}
async function advance(id){
  const j=JOBS.find(x=>x.id===id);
  const next=j&&NEXT[j.status];
  if(!next)return;
  let grams=0;
  if(next.to==='running' && j.material){
    const g=prompt('Starting the run. How many grams of '+(MATLABEL[j.material]||j.material)+' will it use? (taken from stock; 0 to skip)','0');
    if(g===null) return;
    grams=Number(g);
    if(!Number.isFinite(grams)||grams<0){ toast('Enter a number of grams, or 0'); return; }
  }else if(!confirm('Move JOB'+String(id).padStart(3,'0')+' to '+next.to+'?')) return;
  try{
    await api('/jobs/'+id+'/advance',{
      method:'POST',
      body:{ to:next.to, note:'Updated from ProtoHub manager console', grams }
    });
    toast('Job progress saved');
    await refreshAll();
  }catch(e){toast('Could not update job: '+e.message);}
}
async function restock(index){
  const s=STOCK[index];
  if(!s)return;
  const amount=prompt('How many grams of '+(MATLABEL[s.mat]||s.mat)+' are being added?', '1000');
  if(amount===null)return;
  const grams=Number(amount);
  if(!Number.isFinite(grams)||grams<=0){toast('Enter a valid positive quantity');return;}
  try{
    await api('/machines/'+s.machineId+'/restock',{
      method:'POST',
      body:{material:s.mat,grams}
    });
    toast('Restock movement saved');
    await refreshAll();
  }catch(e){toast('Restock failed: '+e.message);}
}
async function startMaintenance(id){
  const reason=prompt('Why is this machine going into maintenance?');
  if(!reason||reason.trim().length<3) return;
  try{
    await api('/machines/'+id+'/maintenance',{method:'POST',body:{reason:reason.trim()}});
    toast('Machine marked as under maintenance'); await refreshAll();
  }catch(e){ toast(e.message); }
}
async function endMaintenance(id){
  if(!confirm('Mark this machine as fixed and available again?')) return;
  try{
    const rows=await api('/machines/'+id+'/maintenance');
    for(const r of rows.filter(r=>!r.resolved_at)) await api('/maintenance/'+r.id+'/resolve',{method:'POST',body:{}});
    toast('Machine is available again'); await refreshAll();
  }catch(e){ toast(e.message); }
}
function closeM(){document.getElementById('modal').classList.remove('on');}
document.getElementById('modal').addEventListener('click',e=>{
  if(e.target.id==='modal')closeM();
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape')closeM();
});

window.ACTIONS={doLogin,doSetPassword,logout:()=>logout(),openQuote,sendQuote,advance,restock,closeM,startMaintenance,endMaintenance};
$('centrePick').addEventListener('change',pickCentre);

if(token){
  loadSession();
}else{
  showLogin();
}
