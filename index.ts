// Relatório semanal de vistorias por e-mail (Supabase Edge Function)
//
// Envia UM e-mail pela conta Gmail da Qualidade:
//   Para: EMAIL_PARA (ou a própria conta Gmail, se não informado)
//   Cópia: todos os ativos da tabela vistoria_destinatarios
//
// Quem chama:
//  * o agendamento (pg_cron) toda segunda às 8h, com o cabeçalho x-relatorio-segredo
//  * a tela Cadastros > Relatório por e-mail, botão "Enviar teste" (vai só para quem clicou)
//
// Segredos necessários (Edge Functions > Secrets):
//  GMAIL_USUARIO       conta que envia, ex.: qualidade@dtel.com.br
//  GMAIL_SENHA_APP     senha de app de 16 letras gerada no Google (não é a senha normal)
//  RELATORIO_SEGREDO   uma senha longa qualquer, a mesma usada no agendamento (arquivo 12)
//  APP_URL             endereço do sistema na Vercel, ex.: https://vistorias-ativos.vercel.app
//  EMAIL_PARA          (opcional) destinatário principal; se vazio, vai para o próprio GMAIL_USUARIO
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem automaticamente.

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-relatorio-segredo",
};
const env = (k: string) => Deno.env.get(k) ?? "";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Reg = { equipe_id: number | null; conforme: boolean; semana: number; data: string; tecnico_nome: string; supervisor: string | null; motivo: string | null };
type Equipe = { id: number; nome: string };

// ---------- Semana igual ao WEEKNUM do Sheets (domingo a sábado) ----------
function semanaDe(d: Date) {
  const y = d.getUTCFullYear();
  const j1 = new Date(Date.UTC(y, 0, 1));
  const doy = Math.round((d.getTime() - j1.getTime()) / 864e5) + 1;
  return { ano: y, semana: Math.floor((doy + j1.getUTCDay() - 1) / 7) + 1 };
}
function intervalo(ano: number, s: number) {
  const j1 = new Date(Date.UTC(ano, 0, 1));
  let ini = new Date(Date.UTC(ano, 0, 1 + (s - 1) * 7 - j1.getUTCDay())); if (ini < j1) ini = j1;
  let fim = new Date(Date.UTC(ano, 0, 1 + s * 7 - j1.getUTCDay() - 1));
  const dez = new Date(Date.UTC(ano, 11, 31)); if (fim > dez) fim = dez;
  const f = (x: Date) => `${String(x.getUTCDate()).padStart(2, "0")}/${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${f(ini)} a ${f(fim)}`;
}
// Semana fechada mais recente: o sábado passado, no horário de Recife
function ultimaSemanaFechada() {
  const agora = new Date(Date.now() - 3 * 3600e3);
  const hoje = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
  const sabado = new Date(hoje.getTime() - (hoje.getUTCDay() + 1) * 864e5);
  return semanaDe(sabado);
}

// ---------- Visual do e-mail (tabelas e estilos inline, funciona no Outlook e Gmail) ----------
const cor = (p: number) => (p > 0.9 ? "#1a9e38" : p >= 0.7 ? "#c99700" : "#d9661f");
const statusTxt = (p: number, t: number) => (!t ? "Gravíssimo" : p > 0.9 ? "Ótimo" : p >= 0.7 ? "Mediano" : "Grave");
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const tit = (s: string | null) => String(s ?? "").toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());
const pctTxt = (ok: number, t: number) => (t ? Math.round((ok / t) * 100) + "%" : "–");

function barra(p: number, t: number, largura = 220) {
  const w = t ? Math.max(2, Math.round(p * largura)) : 0;
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="${largura}" style="background:#eef1ee;border-radius:3px"><tr>` +
    (w ? `<td width="${w}" height="12" style="background:${cor(p)};border-radius:3px;font-size:0;line-height:0">&nbsp;</td>` : "") +
    `<td height="12" style="font-size:0;line-height:0">&nbsp;</td></tr></table>`;
}

function grafico(semanas: { s: number; ok: number; t: number }[]) {
  const alt = 110;
  const cols = semanas.map((x) => {
    const p = x.t ? x.ok / x.t : 0, h = x.t ? Math.max(3, Math.round(p * alt)) : 3;
    return `<td valign="bottom" align="center" style="padding:0 3px">
      <div style="font:700 10px Arial,sans-serif;color:#1b2a1e;margin-bottom:3px">${x.t ? Math.round(p * 100) + "%" : "–"}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" width="34"><tr><td height="${h}" style="background:${x.t ? cor(p) : "#dfe5df"};border-radius:3px 3px 0 0;font-size:0;line-height:0">&nbsp;</td></tr></table>
      <div style="font:11px Arial,sans-serif;color:#5e6b61;margin-top:4px">S${x.s}</div></td>`;
  }).join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>${cols}</tr></table>`;
}

function montarEmail(o: {
  ano: number; semana: number; escopo: string; equipes: Equipe[]; regs: Reg[]; appUrl: string; teste: boolean;
}) {
  const daSemana = o.regs.filter((r) => r.semana === o.semana);
  const linhas = o.equipes.map((e) => {
    const r = daSemana.filter((x) => x.equipe_id === e.id), ok = r.filter((x) => x.conforme).length;
    return { nome: e.nome, ok, t: r.length, p: r.length ? ok / r.length : 0 };
  }).sort((a, b) => Number(b.t > 0) - Number(a.t > 0) || b.p - a.p || b.t - a.t);
  const tot = daSemana.length, okTot = daSemana.filter((r) => r.conforme).length;
  const semVist = linhas.filter((l) => !l.t).length;
  const semanas = Array.from({ length: 8 }, (_, i) => o.semana - 7 + i).filter((s) => s >= 1).map((s) => {
    const r = o.regs.filter((x) => x.semana === s);
    return { s, ok: r.filter((x) => x.conforme).length, t: r.length };
  });
  const nok = daSemana.filter((r) => !r.conforme).sort((a, b) => a.data.localeCompare(b.data));
  const nomeEq = (id: number | null) => o.equipes.find((e) => e.id === id)?.nome ?? "";
  const kpi = (rot: string, val: string | number) =>
    `<td width="25%" style="padding:4px"><table role="presentation" width="100%" style="border:1px solid #dfe5df;border-radius:6px"><tr><td style="padding:10px 12px;font-family:Arial,sans-serif">
      <div style="font-size:12px;color:#5e6b61">${rot}</div><div style="font-size:24px;font-weight:700;color:#1b2a1e">${val}</div></td></tr></table></td>`;

  return `<!DOCTYPE html><html><body style="margin:0;background:#f3f5f2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f2"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden">
  <tr><td style="background:#174721;padding:18px 22px">
    <table role="presentation" width="100%"><tr>
      <td width="110"><img src="${o.appUrl}/assets/logo-dtel.png" alt="DTEL" height="38" style="display:block"></td>
      <td style="font-family:Arial,sans-serif;color:#ffffff"><div style="font-size:20px;font-weight:700">${o.teste ? "[TESTE] " : ""}Vistorias de Ativos</div>
        <div style="font-size:13px;opacity:.85">Semana ${o.semana} de ${o.ano} · ${intervalo(o.ano, o.semana)} · ${esc(o.escopo)}</div></td>
      <td width="64" align="right"><img src="${o.appUrl}/assets/selo-qualidade.png" alt="Selo Qualidade" height="70" style="display:block"></td>
    </tr></table></td></tr>
  <tr><td style="padding:16px 18px 4px"><table role="presentation" width="100%"><tr>
    ${kpi("Vistorias", tot)}${kpi("Conformidade", pctTxt(okTot, tot))}${kpi("Não conformes", tot - okTot)}${kpi("Equipes sem vistoria", semVist)}
  </tr></table></td></tr>
  <tr><td style="padding:12px 22px 0;font:700 16px Arial,sans-serif;color:#174721">Conformidade por equipe</td></tr>
  <tr><td style="padding:8px 22px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;font-size:13px;color:#1b2a1e">
    ${linhas.map((l) => `<tr>
      <td style="padding:7px 0;border-bottom:1px solid #eef1ee">${esc(l.nome)}<div style="font-size:11px;color:#5e6b61">${l.t ? `${l.ok} ok · ${l.t - l.ok} não ok` : "Nenhuma vistoria"}</div></td>
      <td style="padding:7px 8px;border-bottom:1px solid #eef1ee" width="220">${barra(l.p, l.t)}</td>
      <td style="padding:7px 0;border-bottom:1px solid #eef1ee;font-weight:700" width="44" align="right">${pctTxt(l.ok, l.t)}</td>
      <td style="padding:7px 0 7px 8px;border-bottom:1px solid #eef1ee;font-size:12px;color:${l.t ? cor(l.p) : "#b42318"};font-weight:700" width="80">${statusTxt(l.p, l.t)}</td></tr>`).join("")}
    </table></td></tr>
  <tr><td style="padding:16px 22px 6px;font:700 16px Arial,sans-serif;color:#174721">Últimas 8 semanas</td></tr>
  <tr><td style="padding:4px 22px 10px">${grafico(semanas)}</td></tr>
  <tr><td style="padding:12px 22px 6px;font:700 16px Arial,sans-serif;color:#174721">Não conformes da semana (${nok.length})</td></tr>
  <tr><td style="padding:0 22px 10px">${nok.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;font-size:12px;color:#1b2a1e">
    <tr style="color:#5e6b61"><td style="padding:5px 0">Data</td><td>Técnico</td><td>Equipe</td><td>Divergência</td></tr>
    ${nok.map((r) => `<tr><td style="padding:5px 6px 5px 0;border-top:1px solid #eef1ee;white-space:nowrap">${r.data.split("-").reverse().join("/")}</td>
      <td style="border-top:1px solid #eef1ee;padding-right:6px">${esc(tit(r.tecnico_nome))}</td><td style="border-top:1px solid #eef1ee;padding-right:6px">${esc(nomeEq(r.equipe_id))}</td>
      <td style="border-top:1px solid #eef1ee;color:#5e6b61">${esc(r.motivo)}</td></tr>`).join("")}</table>`
    : `<div style="font:13px Arial,sans-serif;color:#5e6b61">Nenhuma vistoria não conforme na semana.</div>`}</td></tr>
  <tr><td align="center" style="padding:14px 22px 22px"><a href="${o.appUrl}" style="background:#174721;color:#ffffff;text-decoration:none;font:700 14px Arial,sans-serif;padding:12px 22px;border-radius:8px;display:inline-block">Abrir o painel completo</a></td></tr>
  <tr><td style="background:#f3f5f2;padding:12px 22px;font:11px Arial,sans-serif;color:#5e6b61">Ótimo acima de 90% · Mediano 70 a 90% · Grave abaixo de 70% · Gravíssimo sem vistoria. Mensagem automática do Sistema de Vistorias de Ativos, Qualidade DTEL.</td></tr>
</table></td></tr></table></body></html>`;
}

// Gmail pela porta 465 (o Supabase bloqueia as portas 25 e 587)
async function enviar(para: string, copia: string[], assunto: string, html: string) {
  const porta = Number(env("SMTP_PORTA") || 465);
  const smtp = nodemailer.createTransport({
    host: env("SMTP_HOST") || "smtp.gmail.com",
    port: porta,
    secure: porta !== 587 && porta !== 25,
    auth: { user: env("GMAIL_USUARIO"), pass: env("GMAIL_SENHA_APP").replace(/\s/g, "") },
    tls: env("SMTP_TESTE") ? { rejectUnauthorized: false } : undefined,
  });
  await smtp.sendMail({
    from: `"Qualidade DTEL" <${env("GMAIL_USUARIO")}>`,
    to: para,
    cc: copia.length ? copia : undefined,
    subject: assunto,
    html,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  // Autorização: segredo do agendamento OU usuário logado com perfil Qualidade
  const segredo = req.headers.get("x-relatorio-segredo");
  let autorizado = !!segredo && segredo === env("RELATORIO_SEGREDO");
  let emailUsuario = "";
  if (!autorizado) {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data } = await admin.auth.getUser(token);
    if (data?.user) {
      const { data: p } = await admin.from("vistoria_perfis").select("papel").eq("user_id", data.user.id).maybeSingle();
      autorizado = p?.papel === "qualidade";
      emailUsuario = data.user.email ?? "";
    }
  }
  if (!autorizado) return json({ erro: "Não autorizado" }, 401);
  if (!env("GMAIL_USUARIO") || !env("GMAIL_SENHA_APP")) return json({ erro: "Configure GMAIL_USUARIO e GMAIL_SENHA_APP nos Secrets da função." }, 500);

  const body = await req.json().catch(() => ({}));
  const ref = ultimaSemanaFechada();
  const ano: number = body.ano ?? ref.ano, semana: number = body.semana ?? ref.semana;
  const teste: string = body.teste_email ? (emailUsuario || body.teste_email) : "";
  const appUrl = (env("APP_URL") || "").replace(/\/$/, "");

  const { data: equipes } = await admin.from("vistoria_equipes").select("id,nome").order("nome");
  const regs: Reg[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await admin.from("vistoria_registros")
      .select("equipe_id,conforme,semana,data,tecnico_nome,supervisor,motivo")
      .eq("ano", ano).gte("semana", semana - 7).lte("semana", semana).order("id").range(i, i + 999);
    if (error) return json({ erro: error.message }, 500);
    regs.push(...(data as Reg[]));
    if (data.length < 1000) break;
  }

  // Teste: só para quem clicou. Normal: Para EMAIL_PARA, cópia para a tabela de destinatários
  let para = teste, copia: string[] = [];
  if (!teste) {
    const { data } = await admin.from("vistoria_destinatarios").select("email").eq("ativo", true);
    para = env("EMAIL_PARA") || env("GMAIL_USUARIO");
    copia = [...new Set((data ?? []).map((d: { email: string }) => d.email.trim().toLowerCase()))].filter((e) => e && e !== para.toLowerCase());
  }

  const html = montarEmail({ ano, semana, escopo: "Todas as equipes", equipes: (equipes ?? []) as Equipe[], regs, appUrl, teste: !!teste });
  const assunto = `${teste ? "[TESTE] " : ""}Vistorias de Ativos · Semana ${semana} de ${ano}`;
  let ok = true, erro = "";
  try { await enviar(para, copia, assunto, html); } catch (e) { ok = false; erro = String(e).slice(0, 500); }
  await admin.from("vistoria_envios").insert({
    ano, semana, email: copia.length ? `${para} + ${copia.length} em cópia` : para,
    status: ok ? "enviado" : "falhou", erro: erro || null,
  });
  const resultado = { ok, ano, semana, para, copia: copia.length };
  const mensagem = ok
    ? (teste ? `Teste da semana ${semana} enviado para ${para}.` : `Enviado para ${para} com ${copia.length} em cópia.`)
    : `O envio falhou: ${erro}`;
  return json({ ...resultado, mensagem });
});
