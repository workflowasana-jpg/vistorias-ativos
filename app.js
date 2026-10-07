// Vistorias de Ativos DTEL - app conectado ao Supabase
const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

let PERFIL = null;        // { nome, papel, equipe_id, email }
let EQUIPES = [];         // [{id, nome}]
let TEC = [];             // técnicos visíveis (ativos e inativos)
let SUPS = [], GESTS = [];
let RESUMO = new Map();   // tecnico_id -> {total, no_ano, conformes_ano, ultima}
const ANOS = {};          // cache de vistorias por ano: {2026: [...]}
const ANO_ATUAL = new Date().getFullYear();
const ANO_INICIAL = 2023;
const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const eqNome = id => (EQUIPES.find(e => e.id === id) || {}).nome || 'Sem equipe';
const isQual = () => PERFIL?.papel === 'qualidade';
const isDir = () => PERFIL?.papel === 'diretoria';
const veTudo = () => isQual() || isDir();

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
const fmtISO = iso => iso ? iso.split('-').reverse().join('/') : '';
const todayISO = () => { const t=new Date(); return new Date(t - t.getTimezoneOffset()*6e4).toISOString().slice(0,10); };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const title = s => String(s||'').toLowerCase().replace(/(^|\s)(\p{L})/gu, (m,a,b)=>a+b.toUpperCase()).replace(/\b(Da|De|Do|Dos|Das|E)\b/g, w=>w.toLowerCase());
const pct = (a,b) => b ? Math.round(a/b*100)+'%' : '–';
function status(p, total){
  if (!total) return ['Gravíssimo','t-gravissimo'];
  if (p > .9) return ['Ótimo','t-otimo'];
  if (p >= .7) return ['Mediano','t-mediano'];
  return ['Grave','t-grave'];
}
const corPct = p => p > .9 ? '#1a9e38' : p >= .7 ? '#c99700' : '#d9661f';
function toast(msg){ const t=$('toast'); t.textContent=msg; t.style.display='block'; clearTimeout(t._h); t._h=setTimeout(()=>t.style.display='none',3200); }
const toVis = r => ({ id:r.id, eq:eqNome(r.equipe_id), d:r.data, t:r.tecnico_nome, tid:r.tecnico_id, c:r.conforme?1:0, m:r.motivo||'', s:r.supervisor||'', g:r.gerente||'', ci:r.cidade||'', b:r.base||'', ano:r.ano, sem:r.semana });
const anoOptions = () => Array.from({length:ANO_ATUAL-ANO_INICIAL+1},(_,i)=>ANO_ATUAL-i).map(a=>`<option>${a}</option>`).join('');

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
  PERFIL = { ...perfil, email: session.user.email };
  await carregarCadastros();
  await garantirAno(ANO_ATUAL);
  await carregarResumo();

  $('who-name').textContent = perfil.nome + ' · ' + (isQual() ? 'Qualidade' : isDir() ? 'Diretoria' : eqNome(perfil.equipe_id));
  if (veTudo()){
    $('who-wrap').hidden = false;
    $('who').innerHTML = '<option value="">Todas as equipes</option>' + EQUIPES.map(e=>`<option>${esc(e.nome)}</option>`).join('');
    $('who').onchange = refreshAll;
  }
  if (isQual()) $('tab-cad').hidden = false;
  $('loading').hidden = true;
  if (isDir()){
    // Diretoria só consulta: sem a aba de lançamento, abre direto no painel
    document.querySelector('nav.tabs button[data-v="nova"]').hidden = true;
    tabs.forEach(x => x.setAttribute('aria-selected', x.dataset.v === 'painel'));
    $('v-painel').hidden = false;
  } else $('v-nova').hidden = false;
  [$('p-ano'), $('h-ano')].forEach(s => { s.innerHTML = anoOptions(); s.value = ANO_ATUAL; });
  $('h-mes').innerHTML = '<option value="">Todos</option>' + MESES.map((m,i)=>`<option value="${i+1}">${m}</option>`).join('');
  fillSem(); fillHistSem(); verdict(); refreshAll();
}

async function carregarCadastros(){
  const [eq, tec, sups, gests] = await Promise.all([
    sb.from('vistoria_equipes').select('id,nome').order('nome'),
    sb.from('vistoria_tecnicos').select('*').order('nome').range(0, 4999),
    sb.from('vistoria_supervisores').select('*').order('nome'),
    sb.from('vistoria_gestores').select('*').order('nome')
  ]);
  EQUIPES = eq.data || [];
  SUPS = sups.data || []; GESTS = gests.data || [];
  TEC = (tec.data || []).map(t => ({ id:t.id, n:t.nome, ci:t.cidade||'', b:t.base||'', e:t.empresa||'', s:t.supervisor||'', g:t.gerente||'',
    eq:eqNome(t.equipe_id), equipe_id:t.equipe_id, supervisor_id:t.supervisor_id, gestor_id:t.gestor_id, ativo:t.ativo, st:t.ativo?'Ativo':'Inativo' }));
}

async function carregarResumo(){
  const { data } = await sb.from('vistoria_resumo_tecnicos').select('*').range(0, 4999);
  RESUMO = new Map((data||[]).map(r => [r.tecnico_id, r]));
}

// Carrega as vistorias só do ano pedido (em páginas de 1000, limite do Supabase)
async function garantirAno(ano){
  if (ANOS[ano]) return ANOS[ano];
  const out = []; const PAGE = 1000;
  const aviso = $('loading').hidden ? null : $('loading');
  for (let i = 0; ; i += PAGE){
    const { data, error } = await sb.from('vistoria_registros')
      .select('id,data,tecnico_id,tecnico_nome,conforme,motivo,supervisor,gerente,cidade,base,equipe_id,ano,semana')
      .eq('ano', ano).order('id').range(i, i + PAGE - 1);
    if (error) { toast('Erro ao carregar vistorias: ' + error.message); break; }
    out.push(...data);
    if (aviso) aviso.textContent = `Carregando vistorias de ${ano}… ${out.length.toLocaleString('pt-BR')}`;
    if (data.length < PAGE) break;
  }
  ANOS[ano] = out.map(toVis);
  return ANOS[ano];
}
const VIS = () => ANOS[ANO_ATUAL] || [];

// Equipe em foco: supervisor sempre a dele; Qualidade escolhe no seletor
const scope = () => veTudo() ? $('who').value : eqNome(PERFIL?.equipe_id);

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
const tecPorNome = () => new Map(TEC.filter(t=>t.ativo).map(t => [t.n, t]));

function fillTecList(){
  const list = TEC.filter(t => t.ativo && (!scope() || t.eq===scope()));
  $('dl-tec').innerHTML = list.map(t=>`<option value="${esc(t.n)}">${esc(title(t.ci))} · ${esc(title(t.s))}</option>`).join('');
}
async function showAuto(){
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
    const lista = await garantirAno(w.ano);
    const dup = lista.find(v => v.t===t.n && v.sem===w.sem);
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
  if (!t){ $('f-tec-msg').innerHTML='<div class="err">Escolha um técnico ativo da lista do cadastro.</div>'; ok=false; }
  verdict();
  const marcados = checks.filter(c=>c.checked).map(c=>c.value);
  if (marcados.length && !fMot.value.trim()){ $('f-mot-msg').innerHTML='<div class="err">Descreva os itens e quantidades divergentes.</div>'; ok=false; }
  if (!ok) return;

  const btn = e.submitter; btn.disabled = true;
  // O banco preenche supervisor, gerente, cidade, base, equipe e decide a conformidade
  const { data, error } = await sb.from('vistoria_registros').insert({
    data: fData.value, tecnico_id: t.id, tecnico_nome: t.n, conforme: true,
    divergencias: marcados, motivo: fMot.value.trim() || null
  }).select('id,data,tecnico_id,tecnico_nome,conforme,motivo,supervisor,gerente,cidade,base,equipe_id,ano,semana').single();
  btn.disabled = false;
  if (error){ toast('Não foi possível salvar: ' + error.message); return; }

  const v = toVis(data); v.novo = 1;
  (await garantirAno(v.ano)).push(v);
  carregarResumo();
  toast(`Vistoria salva: ${title(v.t)}, ${v.c?'conforme':'não conforme'}`);
  fTec.value=''; fMot.value=''; checks.forEach(c=>c.checked=false); verdict(); showAuto();
  renderLast();
};
function renderLast(){
  const rows = VIS().filter(v => !scope() || v.eq===scope()).sort((a,b)=> b.d.localeCompare(a.d) || b.id-a.id).slice(0,10);
  $('last-title').textContent = scope() ? `Últimas de ${scope()}` : 'Últimas vistorias';
  $('last').innerHTML = rows.map(v=>`<li><span class="dot ${v.c?'ok':'nok'}"></span><span><strong>${esc(title(v.t))}</strong><br><span class="muted">${fmtISO(v.d)} · ${esc(title(v.s))}${v.novo?' · salva agora':''}</span></span></li>`).join('') || '<li class="muted">Nenhuma vistoria ainda.</li>';
}

// ---------- Painel ----------
const pAno=$('p-ano'), pSem=$('p-sem');
function fillSem(){
  const y=+pAno.value, cur=wk(todayISO()), max = y===cur.ano ? cur.sem : 53;
  const prev = pSem.value;
  pSem.innerHTML = '<option value="todas">Todas</option>' + Array.from({length:max},(_,i)=>max-i).map(s=>`<option value="${s}">Semana ${s}</option>`).join('');
  pSem.value = prev && [...pSem.options].some(o=>o.value===prev) ? prev : String(y===cur.ano ? Math.max(cur.sem-1,1) : max);
}
pAno.onchange = async () => { fillSem(); $('meters').innerHTML='<div class="loading-inline">Carregando…</div>'; await garantirAno(+pAno.value); renderPainel(); };
pSem.onchange = renderPainel;

function statsPainel(){
  const y=+pAno.value, s=pSem.value, lista = ANOS[y] || [];
  const data = lista.filter(v => s==='todas' || v.sem===+s);
  const eqs = scope() ? [scope()] : EQUIPES.map(e=>e.nome);
  const stats = eqs.map(e => { const r=data.filter(v=>v.eq===e), ok=r.filter(v=>v.c).length; return {e, ok, nok:r.length-ok, tot:r.length, pct: r.length? ok/r.length : 0}; })
    .sort((a,b)=> (b.tot>0)-(a.tot>0) || b.pct-a.pct || b.tot-a.tot);
  const T = stats.reduce((a,x)=>({ok:a.ok+x.ok,tot:a.tot+x.tot}),{ok:0,tot:0});
  const periodo = s==='todas' ? `Ano de ${y}` : (()=>{ const [a,b]=weekRange(y,+s); return `Semana ${s} de ${y} · ${fmt(a)} a ${fmt(b)}`; })();
  const nok = data.filter(v => !v.c && (!scope() || v.eq===scope())).sort((a,b)=>a.eq.localeCompare(b.eq)||a.d.localeCompare(b.d));
  return { y, s, stats, T, periodo, nok, semVist: stats.filter(x=>!x.tot).length };
}
function renderPainel(){
  const { y, s, stats, T, semVist } = statsPainel();
  $('p-range').textContent = s==='todas' ? `Ano de ${y} inteiro` : (()=>{ const [a,b]=weekRange(y,+s); return `${fmt(a)} a ${fmt(b)}`; })();
  $('kpis').innerHTML =
    `<div class="kpi"><span>Vistorias</span><strong>${T.tot}</strong></div>
     <div class="kpi"><span>Conformidade geral</span><strong>${pct(T.ok,T.tot)}</strong></div>
     <div class="kpi"><span>Não conformes</span><strong>${T.tot-T.ok}</strong></div>
     <div class="kpi"><span>Equipes sem vistoria</span><strong>${semVist}</strong></div>`;
  $('meters').innerHTML = stats.map(x=>{
    const [lbl,cls]=status(x.pct,x.tot), col = x.tot ? corPct(x.pct) : 'transparent';
    return `<div class="meter"><div class="nm">${esc(x.e)}<small>${x.tot? `${x.ok} ok · ${x.nok} não ok · ${x.tot} total`:'Nenhuma vistoria lançada'}</small></div>
      <div class="track" role="img" aria-label="${esc(x.e)}: ${x.tot?Math.round(x.pct*100)+'%':'sem vistorias'}">
        <div class="fill" style="width:${x.tot?x.pct*100:0}%;background:${col};opacity:.85"></div>
        <div class="tick" style="left:70%"></div><div class="tick" style="left:90%"></div>
        <span class="pct">${x.tot?Math.round(x.pct*100)+'%':''}</span></div>
      <div><span class="tag ${cls}">${lbl}</span></div></div>`;
  }).join('');
  $('chart-title').textContent = `Conformidade semana a semana, ${y}${scope()?' · '+scope():''}`;
  $('chart').innerHTML = chartSVG(y, scope());
}
// Gráfico semanal com a % escrita em cima de cada barra
function chartSVG(y, equipe, paraImpressao){
  const rows = (ANOS[y]||[]).filter(v=>!equipe||v.eq===equipe);
  const cur = wk(todayISO()), maxS = y===cur.ano ? cur.sem : 53;
  const bw = 26, pl=38, pr=10, pt=22, pb=28, W = Math.max(900, pl+pr+maxS*bw), H=250;
  const txt = paraImpressao ? '#5e6b61' : 'var(--muted)', grade = paraImpressao ? '#dfe5df' : 'var(--line)', vazio = paraImpressao ? '#e5e9e5' : 'var(--line)', forte = paraImpressao ? '#1b2a1e' : 'var(--text)';
  let bars='', labels='';
  for (let s=1;s<=maxS;s++){
    const r=rows.filter(v=>v.sem===s), ok=r.filter(v=>v.c).length, p=r.length?ok/r.length:0;
    const h=(H-pt-pb)*p, x=pl+(s-1)*bw;
    if (r.length){
      bars += `<rect x="${x+2}" y="${H-pb-h}" width="${bw-4}" height="${h}" rx="2" fill="${corPct(p)}"><title>Semana ${s}: ${Math.round(p*100)}% (${r.length} vistorias)</title></rect>`;
      bars += `<text x="${x+bw/2}" y="${H-pb-h-5}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${forte}">${Math.round(p*100)}%</text>`;
    } else bars += `<rect x="${x+2}" y="${H-pb-4}" width="${bw-4}" height="4" fill="${vazio}"><title>Semana ${s}: sem vistorias</title></rect>`;
    if (s%2===1 || maxS<=20) labels += `<text x="${x+bw/2}" y="${H-10}" text-anchor="middle" font-size="10" fill="${txt}">${s}</text>`;
  }
  const yl = v => H-pb-(H-pt-pb)*v;
  const grid = [0,.7,.9,1].map(v=>`<line x1="${pl}" x2="${W-pr}" y1="${yl(v)}" y2="${yl(v)}" stroke="${grade}" ${v===.7||v===.9?'stroke-dasharray="4 4"':''}/><text x="${pl-6}" y="${yl(v)+4}" text-anchor="end" font-size="10" fill="${txt}">${v*100}%</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Conformidade por semana" style="min-width:${paraImpressao?0:W}px">${grid}${bars}${labels}</svg>`;
}

// ---------- Relatório em PDF (impressão do navegador) ----------
$('p-pdf').onclick = () => {
  const { y, stats, T, periodo, nok, semVist } = statsPainel();
  const escopo = scope() || 'Todas as equipes';
  $('relatorio').innerHTML = `
    <div class="rel-head"><img class="lg" src="assets/logo-dtel.png" alt="DTEL">
      <div class="t"><b>Relatório de Vistorias de Ativos</b><span>${esc(periodo)} · ${esc(escopo)}</span></div>
      <img class="selo" src="assets/selo-qualidade.png" alt="Selo Qualidade DTEL"></div>
    <div class="rel-kpis">
      <div><span>Vistorias</span><strong>${T.tot}</strong></div>
      <div><span>Conformidade geral</span><strong>${pct(T.ok,T.tot)}</strong></div>
      <div><span>Não conformes</span><strong>${T.tot-T.ok}</strong></div>
      <div><span>Equipes sem vistoria</span><strong>${semVist}</strong></div></div>
    <h3>Conformidade por equipe</h3>
    <table><thead><tr><th>Equipe</th><th>Conformes</th><th>Não conformes</th><th>Total</th><th style="width:30%">Conformidade</th><th>Status</th></tr></thead><tbody>
      ${stats.map(x=>{ const [lbl]=status(x.pct,x.tot); return `<tr><td>${esc(x.e)}</td><td>${x.ok}</td><td>${x.nok}</td><td>${x.tot}</td>
        <td><div style="display:flex;gap:6px;align-items:center"><div class="rel-bar" style="flex:1"><i style="width:${x.pct*100}%;background:${x.tot?corPct(x.pct):'transparent'}"></i></div><b>${pct(x.ok,x.tot)}</b></div></td><td>${lbl}</td></tr>`; }).join('')}
    </tbody></table>
    <h3>Conformidade semana a semana, ${y}</h3>
    <div class="rel-chart">${chartSVG(y, scope(), true)}</div>
    <h3>Vistorias não conformes no período (${nok.length})</h3>
    ${nok.length ? `<table><thead><tr><th>Data</th><th>Técnico</th><th>Equipe</th><th>Supervisor</th><th>Divergência</th></tr></thead><tbody>
      ${nok.map(v=>`<tr><td>${fmtISO(v.d)}</td><td>${esc(title(v.t))}</td><td>${esc(v.eq)}</td><td>${esc(title(v.s))}</td><td>${esc(v.m)}</td></tr>`).join('')}</tbody></table>` : '<p>Nenhuma vistoria não conforme no período.</p>'}
    <div class="rel-foot">Gerado em ${new Date().toLocaleString('pt-BR')} por ${esc(PERFIL.nome)} · Sistema de Vistorias de Ativos DTEL · Faixas: Ótimo acima de 90%, Mediano de 70 a 90%, Grave abaixo de 70%, Gravíssimo sem vistoria.</div>`;
  const imgs = [...$('relatorio').querySelectorAll('img')];
  Promise.all(imgs.map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))).then(() => window.print());
};

// ---------- Histórico ----------
const hq=$('h-q'), heq=$('h-eq'), hc=$('h-c'), hAno=$('h-ano'), hMes=$('h-mes'), hSem=$('h-sem');
let hPage=0; const PS=50;
function fillHistSem(){
  const y=+hAno.value, cur=wk(todayISO()), max = y===cur.ano ? cur.sem : 53, prev=hSem.value;
  hSem.innerHTML = '<option value="">Todas</option>' + Array.from({length:max},(_,i)=>max-i).map(s=>{ const [a,b]=weekRange(y,s); return `<option value="${s}">Semana ${s} (${fmt(a)} a ${fmt(b)})</option>`; }).join('');
  if ([...hSem.options].some(o=>o.value===prev)) hSem.value = prev;
}
function fillEqSelects(){
  const opts = scope() ? [scope()] : EQUIPES.map(e=>e.nome);
  const html = (scope()?'':'<option value="">Todas</option>') + opts.map(e=>`<option>${esc(e)}</option>`).join('');
  heq.innerHTML = html; $('t-eq').innerHTML = html;
}
[hq,heq,hc,hMes,hSem].forEach(el => el.addEventListener('input', ()=>{hPage=0;renderHist();}));
hAno.addEventListener('change', async () => { hPage=0; fillHistSem(); $('h-info').textContent='Carregando…'; await garantirAno(+hAno.value); renderHist(); });
$('h-prev').onclick=()=>{ if(hPage>0){hPage--;renderHist();} };
$('h-next').onclick=()=>{ hPage++; renderHist(); };
function renderHist(){
  const q=hq.value.trim().toUpperCase(), lista = ANOS[+hAno.value] || [];
  const r = lista.filter(v => (!heq.value||v.eq===heq.value) && (hc.value===''||v.c===+hc.value)
    && (!hMes.value || +v.d.slice(5,7)===+hMes.value) && (!hSem.value || v.sem===+hSem.value)
    && (!q || (v.t+' '+v.s+' '+v.ci+' '+v.b).toUpperCase().includes(q)))
    .sort((a,b)=>b.d.localeCompare(a.d) || b.id-a.id);
  const pages=Math.max(1,Math.ceil(r.length/PS)); hPage=Math.min(hPage,pages-1);
  $('h-body').innerHTML = r.slice(hPage*PS,(hPage+1)*PS).map(v=>`<tr><td>${fmtISO(v.d)}</td><td>${v.sem}</td><td>${esc(title(v.t))}</td><td><span class="tag ${v.c?'t-otimo':'t-grave'}">${v.c?'Conforme':'Não conforme'}</span></td><td class="mot">${esc(v.m)}</td><td>${esc(title(v.s))}</td><td>${esc(v.eq)}</td><td>${esc(title(v.ci))}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">Nenhuma vistoria com esses filtros.</td></tr>';
  const ok = r.filter(v=>v.c).length;
  $('h-info').textContent = `${r.length.toLocaleString('pt-BR')} vistorias · ${pct(ok,r.length)} conformes · página ${hPage+1} de ${pages}`;
}

// ---------- Técnicos (só ativos) ----------
['t-q','t-eq','t-ord'].forEach(id=>$(id).addEventListener('input',renderTec));
function renderTec(){
  const q=$('t-q').value.trim().toUpperCase(), eq=$('t-eq').value, ord=$('t-ord').value;
  const lim = new Date(); lim.setDate(lim.getDate()-14); const limISO = lim.toISOString().slice(0,10);
  const vazio = {total:0,no_ano:0,conformes_ano:0,ultima:null};
  let r = TEC.filter(t => t.ativo && (!eq||t.eq===eq) && (!q || (t.n+' '+t.ci+' '+t.s+' '+t.b).includes(q)))
    .map(t => ({...t, r: RESUMO.get(t.id) || vazio}));
  if (ord==='ano') r.sort((a,b)=>b.r.no_ano-a.r.no_ano);
  else if (ord==='menos') r.sort((a,b)=>a.r.no_ano-b.r.no_ano);
  else if (ord==='ultima') r.sort((a,b)=>(a.r.ultima||'').localeCompare(b.r.ultima||''));
  $('t-body').innerHTML = r.map(t=>{ const a=t.r, late = !a.ultima || a.ultima<limISO;
    return `<tr><td>${esc(title(t.n))}</td><td>${esc(title(t.ci))}</td><td>${esc(title(t.s))}</td><td>${esc(t.eq)}</td>
      <td class="num"><strong>${a.no_ano}</strong></td><td class="num">${a.total}</td><td class="num">${pct(a.conformes_ano,a.no_ano)}</td>
      <td class="${late?'late':''}">${a.ultima?fmtISO(a.ultima):'Nunca'}</td></tr>`; }).join('') || '<tr><td colspan="8" class="muted">Nenhum técnico.</td></tr>';
  const somaAno = r.reduce((s,t)=>s+t.r.no_ano,0);
  $('t-info').textContent = `${r.length} técnicos ativos · ${somaAno.toLocaleString('pt-BR')} vistorias no ano`;
}

// ---------- Cadastros (Qualidade) ----------
let CAD = 'tecnicos', DEST = [], ENVIOS = [];
const optList = (arr, sel, vazio) => (vazio?`<option value="">${vazio}</option>`:'') + arr.map(o=>`<option value="${o.v}" ${String(o.v)===String(sel??'')?'selected':''}>${esc(o.l)}</option>`).join('');
const eqOpts = () => EQUIPES.map(e=>({v:e.id,l:e.nome}));
const supOpts = () => SUPS.filter(s=>s.ativo).map(s=>({v:s.id,l:title(s.nome)+(s.equipe_id?' · '+eqNome(s.equipe_id):'')}));
const gesOpts = () => GESTS.filter(g=>g.ativo).map(g=>({v:g.id,l:title(g.nome)+' · '+eqNome(g.equipe_id)}));

const CADS = {
  tecnicos: { tabela:'vistoria_tecnicos', rotulo:'técnico', temAtivo:true,
    linhas: () => TEC.map(t=>({...t, nome:t.n})),
    busca: t => t.n+' '+t.ci+' '+t.s+' '+t.g+' '+t.b,
    cols: ['Técnico','Cidade','Base','Supervisor','Gestor','Equipe','Situação',''],
    celulas: t => [title(t.n), title(t.ci), title(t.b), title(t.s), title(t.g), t.eq],
    campos: t => [
      {k:'nome', l:'Nome completo', req:true, v:t?.n},
      {k:'cidade', l:'Cidade de atuação', v:t?.ci},
      {k:'base', l:'Base', v:t?.b},
      {k:'empresa', l:'Empresa', v:t?.e || 'DTEL'},
      {k:'supervisor_id', l:'Supervisor', tipo:'select', opts:supOpts(), v:t?.supervisor_id, req:true},
      {k:'gestor_id', l:'Gestor (define a equipe)', tipo:'select', opts:gesOpts(), v:t?.gestor_id, req:true},
      {k:'ativo', l:'Técnico ativo', tipo:'bool', v:t ? t.ativo : true}],
    preparar: d => ({...d, nome:d.nome.toUpperCase(), cidade:d.cidade.toUpperCase(), base:d.base.toUpperCase(), empresa:d.empresa.toUpperCase()}) },
  supervisores: { tabela:'vistoria_supervisores', rotulo:'supervisor', temAtivo:true,
    linhas: () => SUPS, busca: s => s.nome+' '+(s.email||''),
    cols: ['Supervisor','E-mail','Equipe','Técnicos ativos','Situação',''],
    celulas: s => [title(s.nome), s.email||'–', eqNome(s.equipe_id), String(TEC.filter(t=>t.ativo&&t.supervisor_id===s.id).length)],
    campos: s => [
      {k:'nome', l:'Nome', req:true, v:s?.nome},
      {k:'email', l:'E-mail', tipo:'email', v:s?.email},
      {k:'equipe_id', l:'Equipe principal', tipo:'select', opts:eqOpts(), v:s?.equipe_id, vazio:'Sem equipe'},
      {k:'ativo', l:'Supervisor ativo', tipo:'bool', v:s ? s.ativo : true}],
    preparar: d => ({...d, nome:d.nome.toUpperCase(), email:d.email?.toLowerCase()||null, equipe_id:d.equipe_id||null}) },
  gestores: { tabela:'vistoria_gestores', rotulo:'gestor', temAtivo:true,
    linhas: () => GESTS, busca: g => g.nome+' '+(g.email||''),
    cols: ['Gestor','E-mail','Equipe','Técnicos ativos','Situação',''],
    celulas: g => [title(g.nome), g.email||'–', eqNome(g.equipe_id), String(TEC.filter(t=>t.ativo&&t.gestor_id===g.id).length)],
    campos: g => [
      {k:'nome', l:'Nome', req:true, v:g?.nome},
      {k:'email', l:'E-mail', tipo:'email', v:g?.email},
      {k:'equipe_id', l:'Equipe', tipo:'select', opts:eqOpts(), v:g?.equipe_id, req:true},
      {k:'ativo', l:'Gestor ativo', tipo:'bool', v:g ? g.ativo : true}],
    preparar: d => ({...d, nome:d.nome.toUpperCase(), email:d.email?.toLowerCase()||null}) },
  equipes: { tabela:'vistoria_equipes', rotulo:'equipe', temAtivo:false,
    linhas: () => EQUIPES, busca: e => e.nome,
    cols: ['Equipe','Gestores','Técnicos ativos',''],
    celulas: e => [e.nome, GESTS.filter(g=>g.equipe_id===e.id).map(g=>title(g.nome)).join(', ')||'–', String(TEC.filter(t=>t.ativo&&t.equipe_id===e.id).length)],
    campos: e => [{k:'nome', l:'Nome da equipe', req:true, v:e?.nome}],
    preparar: d => d },
  destinatarios: { tabela:'vistoria_destinatarios', rotulo:'e-mail em cópia', temAtivo:true, extraNovo:{tipo:'qualidade'},
    linhas: () => DEST, busca: d => d.nome+' '+d.email,
    cols: ['Nome','E-mail','Situação',''],
    celulas: d => [d.nome, d.email],
    campos: d => [
      {k:'nome', l:'Nome', req:true, v:d?.nome},
      {k:'email', l:'E-mail', tipo:'email', req:true, v:d?.email},
      {k:'ativo', l:'Recebe o relatório em cópia', tipo:'bool', v:d ? d.ativo : true}],
    preparar: d => ({...d, email:d.email.toLowerCase()}) }
};

document.querySelectorAll('#cad-tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#cad-tabs button').forEach(x => x.setAttribute('aria-pressed', x===b));
  CAD = b.dataset.c; $('c-q').value=''; renderCad();
});
['c-q','c-st'].forEach(id => $(id).addEventListener('input', renderCad));
$('c-novo').onclick = () => abrirForm(null);

async function renderCad(){
  const cfg = CADS[CAD];
  if (CAD==='destinatarios') await carregarDestinatarios();
  $('c-st-wrap').hidden = !cfg.temAtivo;
  $('c-novo').textContent = 'Novo ' + cfg.rotulo;
  $('c-extra').innerHTML = CAD==='destinatarios' ? blocoEnvio() : '';
  if (CAD==='destinatarios') ligarEnvio();
  const q = $('c-q').value.trim().toUpperCase(), st = $('c-st').value;
  const rows = cfg.linhas().filter(r => (!cfg.temAtivo || st==='' || String(+r.ativo)===st) && (!q || cfg.busca(r).toUpperCase().includes(q)));
  $('c-head').innerHTML = '<tr>' + cfg.cols.map(c=>`<th>${c}</th>`).join('') + '</tr>';
  $('c-body').innerHTML = rows.map(r => '<tr>' + cfg.celulas(r).map(c=>`<td>${esc(c)}</td>`).join('')
      + (cfg.temAtivo ? `<td><span class="pill ${r.ativo?'on':''}">${r.ativo?'Ativo':'Inativo'}</span></td>` : '')
      + `<td><button class="lnk" data-id="${r.id}">Editar</button></td></tr>`).join('')
    || `<tr><td colspan="${cfg.cols.length}" class="muted">Nada encontrado.</td></tr>`;
  $('c-body').querySelectorAll('button[data-id]').forEach(b => b.onclick = () => abrirForm(cfg.linhas().find(r => r.id===+b.dataset.id)));
  $('c-info').textContent = `${rows.length} registro(s)`;
}

let editando = null;
function abrirForm(reg){
  const cfg = CADS[CAD]; editando = reg;
  $('dlg-title').textContent = (reg ? 'Editar ' : 'Novo ') + cfg.rotulo;
  $('dlg-msg').innerHTML = '';
  $('dlg-fields').innerHTML = cfg.campos(reg).map(c => {
    const id = 'fld-'+c.k;
    if (c.tipo==='bool') return `<div class="field"><label class="switch"><input type="checkbox" id="${id}" ${c.v?'checked':''}> ${c.l}</label></div>`;
    if (c.tipo==='select') return `<div class="field"><label class="f" for="${id}">${c.l}</label><select class="in" id="${id}">${optList(c.opts, c.v, c.vazio || (c.req?'Selecione':''))}</select></div>`;
    return `<div class="field"><label class="f" for="${id}">${c.l}</label><input type="${c.tipo||'text'}" id="${id}" value="${esc(c.v??'')}"></div>`;
  }).join('');
  $('dlg').showModal();
}
$('dlg-cancel').onclick = () => $('dlg').close();
$('dlg-form').onsubmit = async e => {
  e.preventDefault();
  const cfg = CADS[CAD]; const campos = cfg.campos(editando); const d = {};
  for (const c of campos){
    const el = $('fld-'+c.k);
    d[c.k] = c.tipo==='bool' ? el.checked : c.tipo==='select' ? (el.value==='' ? null : (/^\d+$/.test(el.value) ? +el.value : el.value)) : el.value.trim();
    if (c.req && (d[c.k]===null || d[c.k]==='')){ $('dlg-msg').innerHTML = `<div class="err" style="margin-bottom:10px">Preencha: ${c.l}.</div>`; return; }
  }
  const erro = cfg.validar?.(d); if (erro){ $('dlg-msg').innerHTML = `<div class="err" style="margin-bottom:10px">${erro}</div>`; return; }
  const dados = cfg.preparar(d);
  $('dlg-save').disabled = true;
  const res = editando ? await sb.from(cfg.tabela).update(dados).eq('id', editando.id) : await sb.from(cfg.tabela).insert({...dados, ...(cfg.extraNovo||{})});
  $('dlg-save').disabled = false;
  if (res.error){ $('dlg-msg').innerHTML = `<div class="err" style="margin-bottom:10px">${res.error.code==='23505' ? 'Já existe um cadastro com esse nome ou e-mail.' : esc(res.error.message)}</div>`; return; }
  $('dlg').close();
  toast(`${cfg.rotulo[0].toUpperCase()+cfg.rotulo.slice(1)} salvo.`);
  await carregarCadastros();
  renderCad(); fillTecList(); fillEqSelects();
};

async function carregarDestinatarios(){
  const [d, e] = await Promise.all([
    sb.from('vistoria_destinatarios').select('*').order('nome'),
    sb.from('vistoria_envios').select('*').order('enviado_em', {ascending:false}).limit(15)
  ]);
  DEST = d.data || []; ENVIOS = e.data || [];
}
function blocoEnvio(){
  const ult = ENVIOS.length ? ENVIOS.map(x=>`<tr><td>${new Date(x.enviado_em).toLocaleString('pt-BR')}</td><td>${x.semana??''}/${x.ano??''}</td><td>${esc(x.email)}</td><td>${x.status==='enviado'?'<span class="pill on">Enviado</span>':`<span class="pill">${esc(x.status)}</span> ${esc(x.erro||'')}`}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">Nenhum envio ainda.</td></tr>';
  return `<div class="box"><p><strong>Envio automático toda segunda-feira às 8h</strong> com os gráficos da semana anterior de todas as equipes. Sai um único e-mail pela conta Gmail da Qualidade, com todos os ativos desta lista em cópia.</p>
    <div class="row-btns"><button class="btn ghost" id="env-teste" type="button">Enviar teste para ${esc(PERFIL.email)}</button><span id="env-msg" class="muted"></span></div></div>
    <details class="box"><summary><strong>Últimos envios</strong></summary><div class="tbl-wrap" style="margin-top:10px"><table><thead><tr><th>Quando</th><th>Semana</th><th>E-mail</th><th>Situação</th></tr></thead><tbody>${ult}</tbody></table></div></details>`;
}
function ligarEnvio(){
  $('env-teste').onclick = async () => {
    $('env-teste').disabled = true; $('env-msg').textContent = 'Enviando…';
    const { data, error } = await sb.functions.invoke('vistoria-relatorio-semanal', { body: { teste_email: PERFIL.email } });
    $('env-teste').disabled = false;
    $('env-msg').textContent = error ? 'Falhou: ' + (error.message || 'verifique a função no Supabase') : (data?.mensagem || 'Enviado. Confira sua caixa de entrada.');
  };
}

const render = { painel:renderPainel, hist:renderHist, tec:renderTec, nova:renderLast, cad:renderCad };
function refreshAll(){ fillTecList(); fillEqSelects(); renderLast(); renderPainel(); renderHist(); renderTec(); showAuto(); }

sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') location.reload(); });
iniciar();
