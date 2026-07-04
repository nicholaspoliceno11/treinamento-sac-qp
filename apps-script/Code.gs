/**
 * Backend do Portal de Treinamento Quero Passagem.
 *
 * Publique este script como "App da Web" (Implantar > Nova implantação):
 *   - Executar como: Eu (o dono da planilha)
 *   - Quem pode acessar: Qualquer pessoa
 * Copie a URL gerada e cole em assets/config.js (API_URL).
 *
 * A planilha principal (aba de login) deve ter, na linha 1, os cabeçalhos:
 *   NOME COMPLETO | E-MAIL | SENHA TEMPORARIA | SENHA | PERFIL | ANDAMENTO
 *
 * As abas auxiliares (Progresso, Comentarios, Conteudo) são criadas
 * automaticamente na primeira execução.
 */

// ID da sua planilha (o trecho entre /d/ e /edit na URL). Já preenchido.
// Assim o script funciona mesmo sem estar "vinculado" à planilha.
var SPREADSHEET_ID = "1TxJC6cboGQiQwu5faAqZZo-vXIpO_6uRI2e_DKIlRgA";
var LOGIN_SHEET = "Login Treinamento"; // nome da aba com os usuários
var COL = { NOME: 0, EMAIL: 1, SENHA_TEMP: 2, SENHA: 3, PERFIL: 4, ANDAMENTO: 5 };

function getSS() {
  return SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

function doGet() {
  return json({ ok: true, service: "treinamento-qp", time: new Date().toISOString() });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) {}
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    switch (req.action) {
      case "login":       return json(handleLogin(req));
      case "getState":    return json(handleGetState(req));
      case "setProgress": return json(handleSetProgress(req));
      case "getComments": return json({ ok: true, comments: readTable("Comentarios", req.topic) });
      case "addComment":  return json(handleAddComment(req));
      case "getContent":  return json({ ok: true, blocks: readTable("Conteudo", req.topic) });
      case "addContent":  return json(handleAddContent(req));
      case "debug":       return json(handleDebug(req));
      default:            return json({ ok: false, message: "Ação desconhecida" });
    }
  } catch (err) {
    return json({ ok: false, message: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (err2) {}
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function norm(s) { return String(s == null ? "" : s).trim(); }

// Normalização para senha: remove espaços comuns e caracteres invisíveis
// (zero-width, BOM, no-break space) que às vezes vêm colados ao colar na planilha.
function normPw(s) {
  return String(s == null ? "" : s).replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "").trim();
}

function loginSheet() {
  var ss = getSS();
  return ss.getSheetByName(LOGIN_SHEET) || ss.getSheets()[0];
}

function findUser(email) {
  var sh = loginSheet();
  var data = sh.getDataRange().getValues();
  var target = norm(email).toLowerCase();
  for (var i = 1; i < data.length; i++) {
    if (norm(data[i][COL.EMAIL]).toLowerCase() === target) {
      return { row: i + 1, data: data[i] };
    }
  }
  return null;
}

function handleLogin(req) {
  var u = findUser(req.email);
  if (!u) return { ok: false, error: "usuario" };
  var prov = normPw(req.senha);
  var s1 = normPw(u.data[COL.SENHA]);          // coluna SENHA
  var s2 = normPw(u.data[COL.SENHA_TEMP]);     // coluna SENHA TEMPORARIA
  var ok = (s1 !== "" && prov === s1) || (s2 !== "" && prov === s2);
  if (!ok) return { ok: false, error: "senha" };
  return {
    ok: true,
    nome: norm(u.data[COL.NOME]),
    email: norm(u.data[COL.EMAIL]),
    perfil: norm(u.data[COL.PERFIL]) || "Atendente"
  };
}

/**
 * Diagnóstico seguro (protegido por token). Não expõe a senha,
 * apenas tamanhos/estrutura para depurar problemas de cadastro.
 */
function handleDebug(req) {
  if (req.token !== "qp-debug") return { ok: false, error: "token" };
  var sh = loginSheet();
  var data = sh.getDataRange().getValues();
  var u = findUser(req.email);
  var out = { ok: true, sheetName: sh.getName(), numCols: (data[0] || []).length, headers: data[0] || [] };
  if (u) {
    out.found = true;
    out.rowNumber = u.row;
    out.perfil = norm(u.data[COL.PERFIL]);
    out.emailStored = norm(u.data[COL.EMAIL]);
    out.provLen = normPw(req.senha).length;
    out.senhaLen = normPw(u.data[COL.SENHA]).length;
    out.senhaTempLen = normPw(u.data[COL.SENHA_TEMP]).length;
    out.matchSenha = normPw(req.senha) === normPw(u.data[COL.SENHA]);
    out.matchTemp = normPw(req.senha) === normPw(u.data[COL.SENHA_TEMP]);
    out.cells = u.data.map(function (v) { return String(v).length + ":" + String(v).substring(0, 3); });
  } else {
    out.found = false;
  }
  return out;
}

function handleGetState(req) {
  var u = findUser(req.email);
  if (!u) return { ok: false, error: "usuario" };
  return {
    ok: true,
    nome: norm(u.data[COL.NOME]),
    perfil: norm(u.data[COL.PERFIL]) || "Atendente",
    concluidos: completedTopics(req.email)
  };
}

/* ---------------- Progresso ---------------- */
function progressoSheet() { return ensureSheet("Progresso", ["EMAIL", "TOPICO", "TS"]); }

function completedTopics(email) {
  var sh = progressoSheet();
  var data = sh.getDataRange().getValues();
  var t = norm(email).toLowerCase();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    if (norm(data[i][0]).toLowerCase() === t) out.push(norm(data[i][1]));
  }
  return out;
}

function handleSetProgress(req) {
  var sh = progressoSheet();
  var data = sh.getDataRange().getValues();
  var email = norm(req.email), topic = norm(req.topic);
  var t = email.toLowerCase();
  var rowIndex = -1;
  for (var i = 1; i < data.length; i++) {
    if (norm(data[i][0]).toLowerCase() === t && norm(data[i][1]) === topic) { rowIndex = i + 1; break; }
  }
  if (req.done && rowIndex < 0) sh.appendRow([email, topic, new Date().toISOString()]);
  if (!req.done && rowIndex > 0) sh.deleteRow(rowIndex);

  var concluidos = completedTopics(email);
  var total = Number(req.total) || concluidos.length || 1;
  var percent = Math.round((concluidos.length / total) * 100);
  writeAndamento(email, percent);
  return { ok: true, concluidos: concluidos, percent: percent };
}

function writeAndamento(email, percent) {
  var u = findUser(email);
  if (u) loginSheet().getRange(u.row, COL.ANDAMENTO + 1).setValue(percent + "%");
}

/* ---------------- Comentários e Conteúdo ---------------- */
function handleAddComment(req) {
  var u = findUser(req.email);
  if (!u) return { ok: false, error: "usuario" };
  var sh = ensureSheet("Comentarios", ["TOPICO", "NOME", "EMAIL", "PERFIL", "TEXTO", "TS"]);
  sh.appendRow([
    norm(req.topic), norm(u.data[COL.NOME]), norm(u.data[COL.EMAIL]),
    norm(u.data[COL.PERFIL]), norm(req.texto), new Date().toISOString()
  ]);
  return { ok: true };
}

function handleAddContent(req) {
  var u = findUser(req.email);
  if (!u) return { ok: false, error: "usuario" };
  if (!/admin/i.test(norm(u.data[COL.PERFIL]))) return { ok: false, error: "perfil" };
  var sh = ensureSheet("Conteudo", ["TOPICO", "TIPO", "VALOR", "AUTOR", "EMAIL", "TS"]);
  sh.appendRow([
    norm(req.topic), norm(req.tipo), norm(req.valor),
    norm(u.data[COL.NOME]), norm(u.data[COL.EMAIL]), new Date().toISOString()
  ]);
  return { ok: true };
}

/**
 * Lê Comentarios/Conteudo filtrando por tópico e devolve objetos
 * no formato esperado pelo front-end.
 */
function readTable(sheetName, topic) {
  var headers = sheetName === "Comentarios"
    ? ["TOPICO", "NOME", "EMAIL", "PERFIL", "TEXTO", "TS"]
    : ["TOPICO", "TIPO", "VALOR", "AUTOR", "EMAIL", "TS"];
  var sh = ensureSheet(sheetName, headers);
  var data = sh.getDataRange().getValues();
  var tp = norm(topic);
  var out = [];
  for (var i = 1; i < data.length; i++) {
    if (norm(data[i][0]) !== tp) continue;
    if (sheetName === "Comentarios") {
      out.push({ nome: norm(data[i][1]), email: norm(data[i][2]), perfil: norm(data[i][3]), texto: norm(data[i][4]), ts: norm(data[i][5]) });
    } else {
      out.push({ tipo: norm(data[i][1]), valor: norm(data[i][2]), autor: norm(data[i][3]), ts: norm(data[i][5]) });
    }
  }
  return out;
}

function ensureSheet(name, headers) {
  var ss = getSS();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
  }
  return sh;
}
