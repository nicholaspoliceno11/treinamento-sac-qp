/**
 * Backend do Portal de Treinamento Quero Passagem.
 *
 * Publique este script como "App da Web" (Implantar > Nova implantação):
 *   - Executar como: Eu (o dono da planilha)
 *   - Quem pode acessar: Qualquer pessoa
 * Copie a URL gerada e cole em assets/config.js (API_URL).
 *
 * A aba de login precisa ter, na linha 1, cabeçalhos com estes nomes
 * (a ORDEM não importa — as colunas são detectadas pelo nome):
 *   NOME COMPLETO | E-MAIL | SENHA | PERFIL | ANDAMENTO
 *   (a coluna "SENHA TEMPORARIA" é opcional)
 *   (a coluna "ACESSO ACADEMIA" controla o tópico 🎥 Academia — use SIM ou NÃO)
 *
 * As abas auxiliares (Progresso, Comentarios, Conteudo) são criadas
 * automaticamente na primeira execução.
 */

var SPREADSHEET_ID = "1TxJC6cboGQiQwu5faAqZZo-vXIpO_6uRI2e_DKIlRgA";
var LOGIN_SHEET = "Login Treinamento"; // nome da aba com os usuários

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
      case "getDuvidas":  return json({ ok: true, duvidas: listDuvidas() });
      case "addDuvida":   return json(handleAddDuvida(req));
      case "answerDuvida":return json(handleAnswerDuvida(req));
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

// Remove espaços e caracteres invisíveis (zero-width, BOM, no-break space).
function normPw(s) {
  return String(s == null ? "" : s).replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "").trim();
}

function stripAccents(s) {
  return String(s == null ? "" : s)
    .replace(/[ÁÀÂÃÄ]/g, "A").replace(/[áàâãä]/g, "a")
    .replace(/[ÉÈÊË]/g, "E").replace(/[éèêë]/g, "e")
    .replace(/[ÍÌÎÏ]/g, "I").replace(/[íìîï]/g, "i")
    .replace(/[ÓÒÔÕÖ]/g, "O").replace(/[óòôõö]/g, "o")
    .replace(/[ÚÙÛÜ]/g, "U").replace(/[úùûü]/g, "u")
    .replace(/[Çç]/g, "C");
}

function loginSheet() {
  var ss = getSS();
  return ss.getSheetByName(LOGIN_SHEET) || ss.getSheets()[0];
}

// Detecta os índices das colunas pelo nome do cabeçalho (robusto a ordem/edições).
function loginCols(headers) {
  var H = (headers || []).map(function (h) { return stripAccents(norm(h)).toUpperCase(); });
  function find() {
    for (var a = 0; a < arguments.length; a++) {
      var idx = H.indexOf(arguments[a]);
      if (idx >= 0) return idx;
    }
    return -1;
  }
  return {
    nome: find("NOME COMPLETO", "NOME"),
    email: find("E-MAIL", "EMAIL"),
    senha: find("SENHA"),
    senhaTemp: find("SENHA TEMPORARIA", "SENHA TEMPORARIA "),
    perfil: find("PERFIL"),
    andamento: find("ANDAMENTO"),
    acessoAcademia: find("ACESSO ACADEMIA", "ACESSO PARA TOPICO ACADEMIA", "TOPICO ACADEMIA")
  };
}

function isSim(val) {
  var v = stripAccents(norm(val)).toUpperCase();
  return v === "SIM" || v === "S" || v === "YES" || v === "Y";
}

function hasAcademiaAccess(u) {
  if (!u) return false;
  if (/admin/i.test(cell(u, "perfil"))) return true;
  if (u.cols.acessoAcademia < 0) return false;
  return isSim(u.data[u.cols.acessoAcademia]);
}

function loginData() {
  var sh = loginSheet();
  var values = sh.getDataRange().getValues();
  return { sheet: sh, values: values, cols: loginCols(values[0] || []) };
}

function findUser(email) {
  var ld = loginData();
  var c = ld.cols;
  if (c.email < 0) return null;
  var target = norm(email).toLowerCase();
  for (var i = 1; i < ld.values.length; i++) {
    if (norm(ld.values[i][c.email]).toLowerCase() === target) {
      return { row: i + 1, data: ld.values[i], cols: c };
    }
  }
  return null;
}

function cell(u, key) { return u.cols[key] >= 0 ? norm(u.data[u.cols[key]]) : ""; }

function handleLogin(req) {
  var u = findUser(req.email);
  if (!u) return { ok: false, error: "usuario" };
  var prov = normPw(req.senha);
  var s1 = u.cols.senha >= 0 ? normPw(u.data[u.cols.senha]) : "";
  var s2 = u.cols.senhaTemp >= 0 ? normPw(u.data[u.cols.senhaTemp]) : "";
  var ok = (s1 !== "" && prov === s1) || (s2 !== "" && prov === s2);
  if (!ok) return { ok: false, error: "senha" };
  return {
    ok: true,
    nome: cell(u, "nome"),
    email: cell(u, "email"),
    perfil: cell(u, "perfil") || "Atendente",
    acessoAcademia: hasAcademiaAccess(u)
  };
}

function handleGetState(req) {
  var u = findUser(req.email);
  if (!u) return { ok: false, error: "usuario" };
  return {
    ok: true,
    nome: cell(u, "nome"),
    perfil: cell(u, "perfil") || "Atendente",
    acessoAcademia: hasAcademiaAccess(u),
    concluidos: completedTopics(req.email)
  };
}

/**
 * Diagnóstico seguro (protegido por token). Não expõe a senha,
 * apenas tamanhos/estrutura para depurar problemas de cadastro.
 */
function handleDebug(req) {
  if (req.token !== "qp-debug") return { ok: false, error: "token" };
  var ld = loginData();
  var u = findUser(req.email);
  var out = { ok: true, sheetName: ld.sheet.getName(), numCols: (ld.values[0] || []).length, headers: ld.values[0] || [], cols: ld.cols };
  if (u) {
    out.found = true;
    out.rowNumber = u.row;
    out.perfil = cell(u, "perfil");
    out.provLen = normPw(req.senha).length;
    out.senhaLen = u.cols.senha >= 0 ? normPw(u.data[u.cols.senha]).length : -1;
    out.senhaTempLen = u.cols.senhaTemp >= 0 ? normPw(u.data[u.cols.senhaTemp]).length : -1;
    out.matchSenha = u.cols.senha >= 0 && normPw(req.senha) === normPw(u.data[u.cols.senha]);
    out.matchTemp = u.cols.senhaTemp >= 0 && normPw(req.senha) === normPw(u.data[u.cols.senhaTemp]);
  } else {
    out.found = false;
  }
  return out;
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
  if (u && u.cols.andamento >= 0) {
    loginSheet().getRange(u.row, u.cols.andamento + 1).setValue(percent + "%");
  }
}

/* ---------------- Comentários e Conteúdo ---------------- */
function handleAddComment(req) {
  var u = findUser(req.email);
  if (!u) return { ok: false, error: "usuario" };
  var sh = ensureSheet("Comentarios", ["TOPICO", "NOME", "EMAIL", "PERFIL", "TEXTO", "TS"]);
  sh.appendRow([
    norm(req.topic), cell(u, "nome"), cell(u, "email"),
    cell(u, "perfil"), norm(req.texto), new Date().toISOString()
  ]);
  return { ok: true };
}

function handleAddContent(req) {
  var u = findUser(req.email);
  if (!u) return { ok: false, error: "usuario" };
  if (!/admin/i.test(cell(u, "perfil"))) return { ok: false, error: "perfil" };
  var sh = ensureSheet("Conteudo", ["TOPICO", "TIPO", "VALOR", "AUTOR", "EMAIL", "TS"]);
  sh.appendRow([
    norm(req.topic), norm(req.tipo), norm(req.valor),
    cell(u, "nome"), cell(u, "email"), new Date().toISOString()
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

/* ---------------- Fórum de Dúvidas ---------------- */
var DUVIDAS_HEADERS = ["ID", "NOME", "EMAIL", "PERFIL", "DUVIDA", "RESPOSTA", "RESPONDIDO_POR", "CRIADO_EM", "RESPONDIDO_EM"];

function duvidasSheet() { return ensureSheet("Duvidas", DUVIDAS_HEADERS); }

function listDuvidas() {
  var data = duvidasSheet().getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    out.push({
      id: norm(data[i][0]), nome: norm(data[i][1]), perfil: norm(data[i][3]),
      duvida: norm(data[i][4]), resposta: norm(data[i][5]),
      respondidoPor: norm(data[i][6]), criadoEm: norm(data[i][7]), respondidoEm: norm(data[i][8])
    });
  }
  return out.reverse(); // mais recentes primeiro
}

function handleAddDuvida(req) {
  var u = findUser(req.email);
  if (!u) return { ok: false, error: "usuario" };
  var texto = norm(req.texto);
  if (!texto) return { ok: false, message: "Dúvida vazia" };
  var id = "D" + new Date().getTime();
  duvidasSheet().appendRow([
    id, cell(u, "nome"), cell(u, "email"), cell(u, "perfil"),
    texto, "", "", new Date().toISOString(), ""
  ]);
  return { ok: true, id: id };
}

function handleAnswerDuvida(req) {
  var u = findUser(req.email);
  if (!u) return { ok: false, error: "usuario" };
  if (!/admin/i.test(cell(u, "perfil"))) return { ok: false, error: "perfil" };
  var resposta = norm(req.resposta);
  if (!resposta) return { ok: false, message: "Resposta vazia" };
  var sh = duvidasSheet();
  var data = sh.getDataRange().getValues();
  var id = norm(req.id);
  for (var i = 1; i < data.length; i++) {
    if (norm(data[i][0]) === id) {
      sh.getRange(i + 1, 6).setValue(resposta);                    // RESPOSTA
      sh.getRange(i + 1, 7).setValue(cell(u, "nome"));             // RESPONDIDO_POR
      sh.getRange(i + 1, 9).setValue(new Date().toISOString());    // RESPONDIDO_EM
      return { ok: true };
    }
  }
  return { ok: false, message: "Dúvida não encontrada" };
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
