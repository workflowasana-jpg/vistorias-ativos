// Vistorias de Ativos DTEL - app conectado ao Supabase
const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

let PERFIL = null;        // { nome, papel, equipe_id }
let EQUIPES = [];         // [{id, nome}]
let TEC = [];             // técnicos visíveis para o usuário
let VIS = [];             // vistorias visíveis para o usuário
const eqNome = id => (EQUIPES.find(e => e.id === id) || {}).nome || 'Sem equipe';

// ---------- Utilidades ----------
function wk(iso){
  const [y,m,d] = iso.split('-').map(Number);
  const dt = new Date(y, m-1, d), j1 = new Date(y,0,1);
  const doy = Math.round((dt - j1)/864e5) + 1;
  return {ano:y, sem: Math.floor((doy + j1.getDay() - 1)/7) + 1};
}
function weekRange(y, s){
  const j1 = new Date(y,0,1);
  let start = new Date(y,0,1 + (s-1)*7 - j1.getDay()); if (start < j1) start = j1;
  let end = new Date(y,0,1 + s*7 - j1.getDay() - 1); const dec31 = new Date(y,11,31); if (end > dec31) end = dec31;
  return [start,end];
}
const $ = id => document.getElementById(id);
const fmt = d => d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
const fmtISO = iso => iso.split('-').reverse().join('/');
const todayISO = () => { const t=new Date(); return new Date(t - t.getTimezoneOffset()*6e4).toISOString().slice(0,10); };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const title = s => String(s||'').toLowerCase().replace(/(^|\s)(\p{L})/gu, (m,a,b)=>a+b.toUpperCase()).replace(/\b(Da|De|Do|Dos|Das|E)\b/g, w=>w.toLowerCase());
function status(pct, total){
  if (!total) return ['Gravíssimo','t-gravissimo'];
  if (pct > .9) return ['Ótimo','t-otimo'];
  if (pct >= .7) return ['Mediano','t-mediano'];
  return ['Grave','t-grave'];
}
function toast(msg){ const t=$('toast'); t.textContent=msg; t.style.display='block'; clearTimeout(t._h); t._h=setTimeout(()=>t.style.display='none',2800); }
const toVis = r => ({ id:r.id, eq:eqNome(r.equipe_id), d:r.data, t:r.tecnico_nome, c:r.conforme?1:0, m:r.motivo||'', s:r.supervisor||'', g:r.gerente||'', ci:r.cidade||'', b:r.base||'', ano:r.ano, sem:r.semana });

// ---------- Login ----------
$('login-form').onsubmit = async e => {
  e.preventDefault();
  $('l-msg').innerHTML=''; $('l-btn').disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email:$('l-email').value.trim(), password:$('l-senha').value });
  $('l-btn').disabled = false;
  if (error) { $('l-msg').innerHTML = '<div class="err" style="margin-bottom:12px">E-mail ou senha incorretos.</div>'; return; }
  iniciar();
};
$('sair').onclick = async () => { await sb.auth.signOut(); location.reload(); };

async function iniciar(){
  const { data:{ session } } = await sb.auth.getSession();
  if (!session){ $('login').hidden = false; $('app').hidden = true; return; }
  $('login').hidden = true; $('app').hidden = false;

  const { data: perfil, error } = await sb.from('vistoria_perfis').select('nome,papel,equipe_id').eq('user_id', session.user.id).maybeSingle();
  if (error || !perfil){
    $('loading').textContent = 'Seu usuário ainda não tem perfil liberado. Peça à Qualidade para cadastrar seu acesso.';
    return;
  }
  PERFIL = perfil;
  const [eq, tec] = await Promise.all([
    sb.from('vistoria_equipes').select('id,nome').order('id'),
    sb.from('vistoria_tecnicos').select('*').order('nome').range(0, 4999)
  ]);
  EQUIPES = eq.data || [];
  TEC = (tec.data || []).map(t => ({ id:t.id, n:t.nome, ci:t.cidade||'', b:t.base||'', s:t.supervisor||'', g:t.gerente||'', eq:eqNome(t.equipe_id), equipe_id:t.equipe_id, st:t.ativo?'Ativo':'Inativo' }));
  await carregarVistorias();

  $('who-name').textContent = perfil.papel === 'qualidade' ? perfil.nome + ' · Qualidade' : perfil.nome + ' · ' + eqNome(perfil.equipe_id);
  if (perfil.papel === 'qualidade'){
    $('who-wrap').hidden = false;
    $('who').innerHTML = '<option value="">Todas as equipes</option>' + EQUIPES.map(e=>`<option>${esc(e.nome)}</option>`).join('');
    $('who').onchange = refreshAll;
  }
  $('loading').hidden = true;
  $('v-nova').hidden = false;
  fillSem(); verdict(); refreshAll();
}

// Supabase entrega no máximo 1000 linhas por chamada, então busca em páginas
async function carregarVistorias(){
  const out = []; const PAGE = 1000;
  for (let i = 0; ; i += PAGE){
    const { data, error } = await sb.from('vistoria_registros')
      .select('id,data,tecnico_nome,conforme,motivo,supervisor,gerente,cidade,base,equipe_id,ano,semana')
      .order('id').range(i, i + PAGE - 1);
    if (error) { toast('Erro ao carregar vistorias: ' + error.message); break; }
    out.push(...data);
    $('loading').textContent = `Carregando vistorias… ${out.length.toLocaleString('pt-BR')}`;
    if (data.length < PAGE) break;
  }
  VIS = out.map(toVis);
}

// Equipe em foco: supervisor sempre a dele; Qualidade escolhe no seletor
const scope = () => PERFIL?.papel === 'qualidade' ? $('who').value : eqNome(PERFIL?.equipe_id);

// ---------- Abas ----------
const tabs = document.querySelectorAll('nav.tabs button');
tabs.forEach(b => b.onclick = () => {
  tabs.forEach(x => x.setAttribute('aria-selected', x===b));
  document.querySelectorAll('#app-main > section').forEach(s => s.hidden = s.id !== 'v-'+b.dataset.v);
  render[b.dataset.v]?.();
});

// ---------- Nova vistoria ----------
const fData=$('f-data'), fTec=$('f-tec'), fMot=$('f-mot');
const checks=[...document.querySelectorAll('.checks input')];
fData.value = todayISO(); fData.max = todayISO();
const tecPorNome = () => new Map(TEC.map(t => [t.n, t]));

function fillTecList(){
  const list = TEC.filter(t => t.st==='Ativo' && (!scope() || t.eq===scope()));
  $('dl-tec').innerHTML = list.map(t=>`<option value="${esc(t.n)}">${esc(title(t.ci))} · ${esc(title(t.s))}</option>`).join('');
}
function showAuto(){
  const t = tecPorNome().get(fTec.value.trim().toUpperCase());
  const box = $('auto-box'), msg = $('f-tec-msg');
  msg.innerHTML = '';
  if (!t){ box.hidden = true; return; }
  const w = fData.value ? wk(fData.value) : {sem:'–',ano:'–'};
  $('auto').innerHTML =
    `<div><dt>Supervisor</dt><dd>${esc(title(t.s))}</dd></div><div><dt>Gerente</dt><dd>${esc(title(t.g))}</dd></div>
     <div><dt>Cidade</dt><dd>${esc(title(t.ci))}</dd></div><div><dt>Base</dt><dd>${esc(title(t.b))}</dd></div>
     <div><dt>Semana</dt><dd>${w.sem} de ${w.ano}</dd></div><div><dt>Equipe</dt><dd>${esc(t.eq)}</dd></div>`;
  box.hidden = false;
  if (fData.value){
    const dup = VIS.find(v => v.t===t.n && v.ano===w.ano && v.sem===w.sem);
    if (dup) msg.innerHTML = `<div class="warn">${esc(title(t.n))} já tem vistoria na semana ${w.sem} (${fmtISO(dup.d)}, ${dup.c?'conforme':'não conforme'}).</div>`;
  }
}
function checkDate(){
  const m = $('f-data-msg'); m.innerHTML='';
  if (!fData.value) return;
  const w = wk(fData.value), [,sab] = weekRange(w.ano, w.sem);
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  if (hoje > sab) m.innerHTML = `<div class="warn">Lançamento fora do prazo: a semana ${w.sem} fechou no sábado ${fmt(sab)}.</div>`;
}
function verdict(){
  const crit = checks.filter(c => c.checked && c.closest('.crit')).map(c=>c.value);
  const cons = checks.find(c => c.value==='Itens de consumo').checked;
  const v = $('verdict');
  if (crit.length){ v.className='verdict nok'; v.innerHTML=`<b>Não conforme</b><span>Divergência em ${crit.join(', ')}</span>`; }
  else { v.className='verdict ok'; v.innerHTML=`<b>Conforme</b><span>${cons?'Só itens de consumo divergentes':'Nenhum item crítico divergente'}</span>`; }
  $('mot-box').hidden = !(crit.length || cons);
  return crit.length === 0;
}
fTec.addEventListener('input', showAuto);
fData.addEventListener('change', () => { checkDate(); showAuto(); });
checks.forEach(c => c.addEventListener('change', verdict));

$('form').onsubmit = async e => {
  e.preventDefault();
  let ok = true;
  const t = tecPorNome().get(fTec.value.trim().toUpperCase());
  ['f-mot-msg','f-tec-msg'].forEach(id => $(id).innerHTML='');
  if (!fData.value || fData.value > todayISO()){ $('f-data-msg').innerHTML='<div class="err">Informe uma data até hoje.</div>'; ok=false; }
  if (!t){ $('f-tec-msg').innerHTML='<div class="err">Escolha um técnico da lista do cadastro.</div>'; ok=false; }
  verdict();
  const marcados = checks.filter(c=>c.checked).map(c=>c.value);
  if (marcados.length && !fMot.value.trim()){ $('f-mot-msg').innerHTML='<div class="err">Descreva os itens e quantidades divergentes.</div>'; ok=false; }
  if (!ok) return;

  const btn = e.submitter; btn.disabled = true;
  // O banco preenche supervisor, gerente, cidade, base, equipe e decide a conformidade
  const { data, error } = await sb.from('vistoria_registros').insert({
    data: fData.value, tecnico_id: t.id, tecnico_nome: t.n, conforme: true,
    divergencias: marcados, motivo: fMot.value.trim() || null
  }).select('id,data,tecnico_nome,conforme,motivo,supervisor,gerente,cidade,base,equipe_id,ano,semana').single();
  btn.disabled = false;
  if (error){ toast('Não foi possível salvar: ' + error.message); return; }

  const v = toVis(data); v.novo = 1; VIS.push(v);
  toast(`Vistoria salva: ${title(v.t)}, ${v.c?'conforme':'não conforme'}`);
  fTec.value=''; fMot.value=''; checks.forEach(c=>c.checked=false); verdict(); showAuto();
  renderLast();
};
function renderLast(){
  const rows = VIS.filter(v => !scope() || v.eq===scope()).sort((a,b)=> b.d.localeCompare(a.d) || b.id-a.id).slice(0,10);
  $('last-title').textContent = scope() ? `Últimas de ${scope()}` : 'Últimas vistorias';
  $('last').innerHTML = rows.map(v=>`<li><span class="dot ${v.c?'ok':'nok'}"></span><span><strong>${esc(title(v.t))}</strong><br><span class="muted">${fmtISO(v.d)} · ${esc(title(v.s))}${v.novo?' · salva agora':''}</span></span></li>`).join('') || '<li class="muted">Nenhuma vistoria ainda.</li>';
}

// ---------- Painel ----------
const pAno=$('p-ano'), pSem=$('p-sem');
function fillSem(){
  const anos = [...new Set(VIS.map(v=>v.ano))].sort((a,b)=>b-a);
  if (!anos.length) anos.push(wk(todayISO()).ano);
  if (!pAno.options.length) pAno.innerHTML = anos.map(a=>`<option>${a}</option>`).join('');
  const y=+pAno.value, cur=wk(todayISO()), max = y===cur.ano ? cur.sem : 53;
  const prev = pSem.value;
  pSem.innerHTML = '<option value="todas">Todas</option>' + Array.from({length:max},(_,i)=>max-i).map(s=>`<option value="${s}">Semana ${s}</option>`).join('');
  pSem.value = prev && [...pSem.options].some(o=>o.value===prev) ? prev : String(y===cur.ano ? Math.max(cur.sem-1,1) : max);
}
pAno.onchange = () => { fillSem(); renderPainel(); };
pSem.onchange = renderPainel;

function renderPainel(){
  const y=+pAno.value, s=pSem.value;
  const data = VIS.filter(v => v.ano===y && (s==='todas' || v.sem===+s));
  if (s==='todas') $('p-range').textContent = `Ano de ${y} inteiro`;
  else { const [a,b]=weekRange(y,+s); $('p-range').textContent = `${fmt(a)} a ${fmt(b)}`; }
  const eqs = scope() ? [scope()] : EQUIPES.map(e=>e.nome);
  const stats = eqs.map(e => { const r=data.filter(v=>v.eq===e), ok=r.filter(v=>v.c).length; return {e, ok, nok:r.length-ok, tot:r.length, pct: r.length? ok/r.length : 0}; })
    .sort((a,b)=> (b.tot>0)-(a.tot>0) || b.pct-a.pct || b.tot-a.tot);
  const T = stats.reduce((a,x)=>({ok:a.ok+x.ok,tot:a.tot+x.tot}),{ok:0,tot:0});
  const sem = stats.filter(x=>!x.tot).length;
  $('kpis').innerHTML =
    `<div class="kpi"><span>Vistorias</span><strong>${T.tot}</strong></div>
     <div class="kpi"><span>Conformidade geral</span><strong>${T.tot?Math.round(T.ok/T.tot*100)+'%':'–'}</strong></div>
     <div class="kpi"><span>Não conformes</span><strong>${T.tot-T.ok}</strong></div>
     <div class="kpi"><span>Equipes sem vistoria</span><strong>${sem}</strong></div>`;
  $('meters').innerHTML = stats.map(x=>{
    const [lbl,cls]=status(x.pct,x.tot), col = {'t-otimo':'var(--verde)','t-mediano':'var(--ouro)','t-grave':'var(--laranja)'}[cls]||'transparent';
    return `<div class="meter"><div class="nm">${esc(x.e)}<small>${x.tot? `${x.ok} ok · ${x.nok} não ok · ${x.tot} total`:'Nenhuma vistoria lançada'}</small></div>
      <div class="track" role="img" aria-label="${esc(x.e)}: ${x.tot?Math.round(x.pct*100)+'%':'sem vistorias'}">
        <div class="fill" style="width:${x.tot?x.pct*100:0}%;background:${col};opacity:.85"></div>
        <div class="tick" style="left:70%"></div><div class="tick" style="left:90%"></div>
        <span class="pct">${x.tot?Math.round(x.pct*100)+'%':''}</span></div>
      <div><span class="tag ${cls}">${lbl}</span></div></div>`;
  }).join('');
  renderChart(y);
}
function renderChart(y){
  const rows = VIS.filter(v=>v.ano===y && (!scope()||v.eq===scope()));
  const cur = wk(todayISO()), maxS = y===cur.ano ? cur.sem : 53;
  const W=900,H=240,pl=36,pr=10,pt=14,pb=28, bw=(W-pl-pr)/maxS;
  let bars='', labels='';
  for (let s=1;s<=maxS;s++){
    const r=rows.filter(v=>v.sem===s), ok=r.filter(v=>v.c).length, p=r.length?ok/r.length:0;
    const h=(H-pt-pb)*p, x=pl+(s-1)*bw, col = !r.length?'var(--line)': p>.9?'var(--verde)': p>=.7?'var(--ouro)':'var(--laranja)';
    bars += r.length ? `<rect x="${x+1.5}" y="${H-pb-h}" width="${bw-3}" height="${h}" rx="2" fill="${col}"><title>Semana ${s}: ${Math.round(p*100)}% (${r.length} vistorias)</title></rect>`
                     : `<rect x="${x+1.5}" y="${H-pb-4}" width="${bw-3}" height="4" fill="${col}"><title>Semana ${s}: sem vistorias</title></rect>`;
    if (s%5===0||s===1) labels += `<text x="${x+bw/2}" y="${H-10}" text-anchor="middle" font-size="11" fill="var(--muted)">${s}</text>`;
  }
  const yl = v => H-pb-(H-pt-pb)*v;
  const grid = [0,.7,.9,1].map(v=>`<line x1="${pl}" x2="${W-pr}" y1="${yl(v)}" y2="${yl(v)}" stroke="var(--line)" ${v===.7||v===.9?'stroke-dasharray="4 4"':''}/><text x="${pl-6}" y="${yl(v)+4}" text-anchor="end" font-size="11" fill="var(--muted)">${v*100}%</text>`).join('');
  $('chart-title').textContent = `Conformidade semana a semana, ${y}${scope()?' · '+scope():''}`;
  $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Conformidade por semana">${grid}${bars}${labels}</svg>`;
}

// ---------- Histórico ----------
const hq=$('h-q'), heq=$('h-eq'), hc=$('h-c'), hde=$('h-de'), hate=$('h-ate');
let hPage=0; const PS=50;
function fillEqSelects(){
  const opts = scope() ? [scope()] : EQUIPES.map(e=>e.nome);
  const html = (scope()?'':'<option value="">Todas</option>') + opts.map(e=>`<option>${esc(e)}</option>`).join('');
  heq.innerHTML = html; $('t-eq').innerHTML = html;
}
[hq,heq,hc,hde,hate].forEach(el => el.addEventListener('input', ()=>{hPage=0;renderHist();}));
$('h-prev').onclick=()=>{ if(hPage>0){hPage--;renderHist();} };
$('h-next').onclick=()=>{ hPage++; renderHist(); };
function renderHist(){
  const q=hq.value.trim().toUpperCase();
  const r = VIS.filter(v => (!heq.value||v.eq===heq.value) && (hc.value===''||v.c===+hc.value) && (!hde.value||v.d>=hde.value) && (!hate.value||v.d<=hate.value)
    && (!q || (v.t+' '+v.s+' '+v.ci+' '+v.b).toUpperCase().includes(q)))
    .sort((a,b)=>b.d.localeCompare(a.d) || b.id-a.id);
  const pages=Math.max(1,Math.ceil(r.length/PS)); hPage=Math.min(hPage,pages-1);
  $('h-body').innerHTML = r.slice(hPage*PS,(hPage+1)*PS).map(v=>`<tr><td>${fmtISO(v.d)}</td><td>${v.sem}</td><td>${esc(title(v.t))}</td><td><span class="tag ${v.c?'t-otimo':'t-grave'}">${v.c?'Conforme':'Não conforme'}</span></td><td class="mot">${esc(v.m)}</td><td>${esc(title(v.s))}</td><td>${esc(v.eq)}</td><td>${esc(title(v.ci))}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">Nenhuma vistoria com esses filtros.</td></tr>';
  $('h-info').textContent = `${r.length.toLocaleString('pt-BR')} vistorias · página ${hPage+1} de ${pages}`;
}

// ---------- Técnicos ----------
['t-q','t-eq','t-st'].forEach(id=>$(id).addEventListener('input',renderTec));
function renderTec(){
  const q=$('t-q').value.trim().toUpperCase(), eq=$('t-eq').value, st=$('t-st').value;
  const y = wk(todayISO()).ano, agg = new Map();
  VIS.forEach(v=>{ const a=agg.get(v.t)||{n:0,ok:0,last:''}; if(v.ano===y){a.n++; a.ok+=v.c;} if(v.d>a.last)a.last=v.d; agg.set(v.t,a); });
  const lim = new Date(); lim.setDate(lim.getDate()-14); const limISO = lim.toISOString().slice(0,10);
  const r = TEC.filter(t => (!eq||t.eq===eq) && (!st||t.st===st) && (!q || (t.n+' '+t.ci+' '+t.s+' '+t.b).includes(q)));
  $('t-body').innerHTML = r.map(t=>{ const a=agg.get(t.n)||{n:0,ok:0,last:''}; const late = t.st==='Ativo' && (!a.last || a.last<limISO);
    return `<tr><td>${esc(title(t.n))}</td><td>${esc(title(t.ci))}</td><td>${esc(title(t.b))}</td><td>${esc(title(t.s))}</td><td>${esc(t.eq)}</td><td>${a.n}</td><td>${a.n?Math.round(a.ok/a.n*100)+'%':'–'}</td><td class="${late?'late':''}">${a.last?fmtISO(a.last):'Nunca'}</td></tr>`; }).join('');
  $('t-info').textContent = `${r.length} técnicos`;
}

const render = { painel:renderPainel, hist:renderHist, tec:renderTec, nova:renderLast };
function refreshAll(){ fillTecList(); fillEqSelects(); renderLast(); renderPainel(); renderHist(); renderTec(); showAuto(); }

sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') location.reload(); });
iniciar();
