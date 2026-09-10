/**
 * Auditoria de Procedimentos — Dashboards
 * ----------------------------------------
 * Serve dois dashboards (Retirada de Equipamentos e Amigo Indica Amigo)
 * lendo os dados diretamente das abas da planilha.
 *
 * NOMES DE ABA ESPERADOS (ajuste se forem diferentes na sua planilha):
 *   - "RETIRADA DE EQUIPAMENTOS E MATERIAIS"
 *   - "AMIGO INDIQUE AMIGO"
 *
 * Depois de colar este arquivo + os dois .html no editor de Apps Script,
 * publique com "Implantar > Nova implantação > Aplicativo da Web".
 * Acesse:
 *   .../exec               -> dashboard de Retirada de Equipamentos
 *   .../exec?dash=amigo    -> dashboard de Amigo Indica Amigo
 *
 * PERFORMANCE:
 * Os dados processados ficam em cache por CACHE_TTL_SECONDS. Dentro desse
 * intervalo, novas aberturas do dashboard usam o cache em vez de reler a
 * planilha inteira, o que acelera bastante o carregamento. Se você editar
 * a planilha e quiser ver a mudança na hora, abra a URL com &refresh=1
 * (ex: .../exec?refresh=1 ou .../exec?dash=amigo&refresh=1).
 */

var SHEET_RETIRADA = 'RETIRADA DE EQUIPAMENTOS E MATERIAIS';
var SHEET_AMIGO = 'AMIGO INDIQUE AMIGO';
var CACHE_TTL_SECONDS = 120; // 2 minutos

function doGet(e) {
  var page = (e && e.parameter && e.parameter.dash) || 'retirada';
  var forceRefresh = !!(e && e.parameter && e.parameter.refresh);
  var tpl, title;
  var baseUrl = ScriptApp.getService().getUrl();

  if (page === 'amigo') {
    tpl = HtmlService.createTemplateFromFile('AmigoDashboard');
    tpl.data = getAmigoData_(forceRefresh);
    tpl.baseUrl = baseUrl;
    title = 'Amigo Indica Amigo · Auditoria DTEL';
  } else {
    tpl = HtmlService.createTemplateFromFile('RetiradaDashboard');
    tpl.data = getRetiradaData_(forceRefresh);
    tpl.baseUrl = baseUrl;
    title = 'Retirada de Equipamentos · Auditoria DTEL';
  }

  return tpl.evaluate()
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Normaliza texto: tira espaços extras/quebras de linha e põe em maiúsculas. */
function norm_(v) {
  if (v === null || v === undefined || v === '') return null;
  return String(v).trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Formata datas do Sheets (Date object) como 'yyyy-MM-dd'. */
function fmtDate_(v) {
  if (!v) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  return String(v);
}

/**
 * Descobre a última linha com dado real numa coluna específica, mesmo que
 * a aba tenha formatação aplicada muito além dos dados (o que infla
 * getLastRow()/getDataRange() e deixa a leitura mais lenta que o necessário).
 */
function findLastDataRow_(sheet, colIndex1Based) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  var colValues = sheet.getRange(2, colIndex1Based, lastRow - 1, 1).getValues();
  for (var i = colValues.length - 1; i >= 0; i--) {
    var v = colValues[i][0];
    if (v !== '' && v !== null && v !== undefined) {
      return i + 2; // +2: volta pro índice 1-based e compensa o início na linha 2
    }
  }
  return 1;
}

/** Lê e faz o parse de um valor JSON guardado em cache, em pedaços (chunks). */
function cacheGetJson_(key) {
  try {
    var cache = CacheService.getScriptCache();
    var countStr = cache.get(key + ':count');
    if (!countStr) return null;
    var count = parseInt(countStr, 10);
    var parts = [];
    for (var i = 0; i < count; i++) {
      var part = cache.get(key + ':' + i);
      if (part === null) return null; // algum pedaço expirou, cache inválido
      parts.push(part);
    }
    return JSON.parse(parts.join(''));
  } catch (err) {
    return null;
  }
}

/** Guarda um objeto em cache como JSON, dividido em pedaços de até ~90KB. */
function cachePutJson_(key, obj, ttlSeconds) {
  try {
    var cache = CacheService.getScriptCache();
    var str = JSON.stringify(obj);
    var chunkSize = 90000;
    var count = Math.max(1, Math.ceil(str.length / chunkSize));
    var toStore = {};
    for (var i = 0; i < count; i++) {
      toStore[key + ':' + i] = str.substring(i * chunkSize, (i + 1) * chunkSize);
    }
    toStore[key + ':count'] = String(count);
    cache.putAll(toStore, ttlSeconds);
  } catch (err) {
    // se o cache falhar (ex: dado grande demais), segue sem cache
  }
}

/**
 * Lê a aba "RETIRADA DE EQUIPAMENTOS E MATERIAIS" e devolve um array de
 * objetos no mesmo formato usado pelo dashboard (data_auditoria, mes, ano,
 * tecnico, tipo_servico, os, status, tipo, observacao).
 */
function getRetiradaData_(forceRefresh) {
  var cacheKey = 'retirada_v1';
  if (!forceRefresh) {
    var cached = cacheGetJson_(cacheKey);
    if (cached) return cached;
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RETIRADA);
  if (!sheet) throw new Error('Aba não encontrada: ' + SHEET_RETIRADA);

  var lastRow = findLastDataRow_(sheet, 5); // coluna 5 = Técnico
  var numCols = 10; // colunas A..J
  var values = lastRow >= 2 ? sheet.getRange(1, 1, lastRow, numCols).getValues() : [];
  var rows = [];

  // Colunas (0-indexed):
  // 0 Data auditoria | 1 Data serviço | 2 Mês | 3 Ano | 4 Técnico
  // 5 Tipo de serviço | 6 O.S | 7 Status | 8 Tipo (motivo NC) | 9 Observação
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    var tecnico = r[4];
    var status = r[7];
    if (!tecnico && !status) continue; // pula linhas vazias

    var tipoServico = norm_(r[5]);
    // corrige valor truncado que aparece na planilha original
    if (tipoServico === 'RETIRADA EQUIPAMENTO E MATERIA') {
      tipoServico = 'RETIRADA EQUIPAMENTO E MATERIAL';
    }

    rows.push({
      data_auditoria: fmtDate_(r[0]),
      mes: norm_(r[2]),
      ano: r[3],
      tecnico: norm_(tecnico),
      tipo_servico: tipoServico,
      os: r[6],
      status: norm_(status),
      tipo: norm_(r[8]),
      observacao: r[9] || null
    });
  }

  cachePutJson_(cacheKey, rows, CACHE_TTL_SECONDS);
  return rows;
}

/**
 * Lê a aba "AMIGO INDIQUE AMIGO" e devolve um array de objetos no mesmo
 * formato usado pelo dashboard (data, base, cod_indicador, cliente_indicador,
 * cod_indicado, cliente_indicado, desconto_aplicado, observacao, status,
 * setor, vendedor).
 */
function getAmigoData_(forceRefresh) {
  var cacheKey = 'amigo_v1';
  if (!forceRefresh) {
    var cached = cacheGetJson_(cacheKey);
    if (cached) return cached;
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_AMIGO);
  if (!sheet) throw new Error('Aba não encontrada: ' + SHEET_AMIGO);

  var lastRow = findLastDataRow_(sheet, 4); // coluna 4 = Cliente indicador
  var numCols = 11; // colunas A..K
  var values = lastRow >= 2 ? sheet.getRange(1, 1, lastRow, numCols).getValues() : [];
  var rows = [];

  // Colunas (0-indexed):
  // 0 Data | 1 Base | 2 Cód. Cliente indicador | 3 Cliente indicador
  // 4 Cód. Cliente indicado | 5 Cliente indicado | 6 Desconto aplicado?
  // 7 Observação | 8 Status | 9 Setor | 10 Vendedor
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    var clienteIndicador = r[3];
    var status = r[8];
    if (!clienteIndicador && !status) continue; // pula linhas vazias

    rows.push({
      data: fmtDate_(r[0]),
      base: norm_(r[1]),
      cod_indicador: r[2],
      cliente_indicador: norm_(clienteIndicador),
      cod_indicado: r[4],
      cliente_indicado: norm_(r[5]),
      desconto_aplicado: norm_(r[6]),
      observacao: r[7] || null,
      status: norm_(status),
      setor: norm_(r[9]),
      vendedor: norm_(r[10])
    });
  }

  cachePutJson_(cacheKey, rows, CACHE_TTL_SECONDS);
  return rows;
}

/**
 * Funções auxiliares para chamar via google.script.run a partir do front-end,
 * caso você queira atualizar os dados sem recarregar a página inteira.
 */
function fetchRetiradaData() {
  return getRetiradaData_(false);
}

function fetchAmigoData() {
  return getAmigoData_(false);
}
