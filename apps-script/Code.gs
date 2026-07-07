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
 *   (a coluna "ACESSO ACADEMIA" na aba Login Treinamento — use SIM ou NÃO)
 *   OU uma aba separada "ACESSO ACADEMIA" com colunas NOME + ACESSO (Sim/Não)
 *
 * Segurança: senhas são armazenadas como hash SHA-256 com sal (formato sha256$...).
 * No primeiro login com senha em texto puro, o script converte automaticamente para hash.
 * Sessões válidas por 12h ficam na aba "Sessoes"; tentativas de login na aba "LoginTentativas".
 *
 * As abas auxiliares (Progresso, Comentarios, Conteudo) são criadas
 * automaticamente na primeira execução.
 */

var SPREADSHEET_ID = "1TxJC6cboGQiQwu5faAqZZo-vXIpO_6uRI2e_DKIlRgA";
var LOGIN_SHEET = "Login Treinamento"; // nome da aba com os usuários
var ACESSO_ACADEMIA_SHEET = "ACESSO ACADEMIA"; // aba opcional (NOME + ACESSO)

// --- Segurança (sessão, senha, brute-force) ---
var SESSION_SHEET = "Sessoes";
var LOGIN_ATTEMPTS_SHEET = "LoginTentativas";
var SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas
var MAX_LOGIN_ATTEMPTS = 5;
var LOCKOUT_MS = 15 * 60 * 1000; // 15 minutos após N erros
var PASSWORD_HASH_PREFIX = "sha256$";

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
      case "logout":      return json(handleLogout(req));
      case "getState":    return json(handleGetState(req));
      case "setProgress": return json(handleSetProgress(req));
      case "getComments": return json(handleGetComments(req));
      case "addComment":  return json(handleAddComment(req));
      case "getContent":  return json(handleGetContent(req));
      case "addContent":  return json(handleAddContent(req));
      case "getDuvidas":  return json(handleGetDuvidas(req));
      case "addDuvida":   return json(handleAddDuvida(req));
      case "answerDuvida":return json(handleAnswerDuvida(req));
      case "getDesafio":    return json(handleGetDesafio(req));
      case "addDesafioPergunta": return json(handleAddDesafioPergunta(req));
      case "submitDesafioResposta": return json(handleSubmitDesafioResposta(req));
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
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .replace(/[ÁÀÂÃÄ]/g, "A").replace(/[áàâãä]/g, "a")
    .replace(/[ÉÈÊË]/g, "E").replace(/[éèêë]/g, "e")
    .replace(/[ÍÌÎÏ]/g, "I").replace(/[íìîï]/g, "i")
    .replace(/[ÓÒÔÕÖ]/g, "O").replace(/[óòôõö]/g, "o")
    .replace(/[ÚÙÛÜ]/g, "U").replace(/[úùûü]/g, "u")
    .replace(/[Çç]/g, "C")
    .replace(/[Ññ]/g, "N");
}

function headerKey(h) {
  return stripAccents(norm(h)).toUpperCase();
}

function loginSheet() {
  var ss = getSS();
  return ss.getSheetByName(LOGIN_SHEET) || ss.getSheets()[0];
}

// Detecta os índices das colunas pelo nome do cabeçalho (robusto a ordem/edições).
function loginCols(headers) {
  var H = (headers || []).map(headerKey);
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
  if (val === true || val === 1) return true;
  if (val === false || val === 0) return false;
  if (typeof val === "number") return false;
  var v = stripAccents(norm(val)).toUpperCase();
  return v === "SIM" || v === "S" || v === "YES" || v === "Y";
}

function isNao(val) {
  if (val === false || val === 0) return true;
  if (val === true || val === 1) return false;
  if (typeof val === "number") return true;
  var v = stripAccents(norm(val)).toUpperCase();
  return v === "NAO" || v === "N" || v === "NO" || v === "FALSE";
}

function isAccessError(val) {
  var s = stripAccents(norm(val)).toUpperCase();
  return !s || s.indexOf("REF") >= 0 || s.indexOf("ERROR") >= 0 || s.indexOf("N/A") >= 0 || s.indexOf("VALOR") >= 0;
}

function acessoAcademiaVal(u) {
  if (!u || u.cols.acessoAcademia < 0) return "";
  return loginSheet().getRange(u.row, u.cols.acessoAcademia + 1).getDisplayValue();
}

function academiaSheetCols(headers) {
  var H = (headers || []).map(headerKey);
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
    acesso: find("ACESSO ACADEMIA", "ACESSO")
  };
}

// Lê a aba separada "ACESSO ACADEMIA" (NOME + ACESSO). Retorna null se a aba não existir.
function academiaAccessFromSheet(u) {
  var sh = getSS().getSheetByName(ACESSO_ACADEMIA_SHEET);
  if (!sh) return null;
  var values = sh.getDataRange().getValues();
  if (!values.length) return null;
  var cols = academiaSheetCols(values[0]);
  if (cols.acesso < 0) return null;

  var userNome = stripAccents(cell(u, "nome")).toUpperCase();
  var userEmail = cell(u, "email").toLowerCase();

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var match = false;
    if (cols.email >= 0 && userEmail && norm(row[cols.email]).toLowerCase() === userEmail) {
      match = true;
    } else if (cols.nome >= 0) {
      var rowNome = stripAccents(norm(row[cols.nome])).toUpperCase();
      if (rowNome && rowNome === userNome) match = true;
    }
    if (match) return isSim(row[cols.acesso]);
  }
  return false; // não está na lista = sem acesso
}

function hasAcademiaAccess(u) {
  if (!u) return false;
  if (/admin/i.test(cell(u, "perfil"))) return true;
  // Opção A: coluna na aba Login Treinamento (lê o texto exibido: Sim/Não)
  if (u.cols.acessoAcademia >= 0) {
    var val = acessoAcademiaVal(u);
    if (isAccessError(val)) return false;
    if (isNao(val)) return false;
    return isSim(val);
  }
  // Opção B: aba separada "ACESSO ACADEMIA"
  var fromSheet = academiaAccessFromSheet(u);
  if (fromSheet !== null) return fromSheet;
  return false;
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

/* ---------------- Segurança: hash de senha ---------------- */
function sha256Hex(input) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(input));
  return digest.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
}

function randomSalt() {
  return sha256Hex(Utilities.getUuid() + "|" + new Date().getTime() + "|" + Math.random()).slice(0, 32);
}

function hashPassword(plain) {
  var salt = randomSalt();
  return PASSWORD_HASH_PREFIX + salt + "$" + sha256Hex(salt + normPw(plain));
}

function isHashedPassword(stored) {
  return String(stored || "").indexOf(PASSWORD_HASH_PREFIX) === 0;
}

function verifyStoredPassword(stored, plain) {
  stored = normPw(stored);
  plain = normPw(plain);
  if (!stored || !plain) return false;
  if (isHashedPassword(stored)) {
    var parts = stored.split("$");
    if (parts.length !== 3) return false;
    var salt = parts[1];
    var expected = parts[2];
    return sha256Hex(salt + plain) === expected;
  }
  return stored === plain;
}

function isStrongPassword(plain) {
  var p = normPw(plain);
  if (p.length < 8) return false;
  if (!/[A-Za-z]/.test(p)) return false;
  if (!/[0-9]/.test(p)) return false;
  return true;
}

function migratePasswordCell(u, colKey, plain) {
  var col = u.cols[colKey];
  if (col < 0) return;
  var stored = normPw(u.data[col]);
  if (!stored || isHashedPassword(stored)) return;
  loginSheet().getRange(u.row, col + 1).setValue(hashPassword(plain));
}

function migratePasswordsOnLogin(u, plain) {
  migratePasswordCell(u, "senha", plain);
  migratePasswordCell(u, "senhaTemp", plain);
}

/**
 * Executar manualmente no editor Apps Script (uma vez) para hashear
 * todas as senhas em texto puro já cadastradas na planilha.
 */
function migrateAllPasswordsInSheet() {
  var ld = loginData();
  var c = ld.cols;
  var n = 0;
  for (var i = 1; i < ld.values.length; i++) {
    var row = ld.values[i];
    var u = { row: i + 1, data: row, cols: c };
    if (c.senha >= 0) {
      var s = normPw(row[c.senha]);
      if (s && !isHashedPassword(s)) {
        loginSheet().getRange(i + 1, c.senha + 1).setValue(hashPassword(s));
        n++;
      }
    }
    if (c.senhaTemp >= 0) {
      var t = normPw(row[c.senhaTemp]);
      if (t && !isHashedPassword(t)) {
        loginSheet().getRange(i + 1, c.senhaTemp + 1).setValue(hashPassword(t));
        n++;
      }
    }
  }
  return "Senhas migradas: " + n;
}

/* ---------------- Segurança: sessão / token ---------------- */
function sessionsSheet() { return ensureSheet(SESSION_SHEET, ["EMAIL", "TOKEN", "EXPIRES_AT"]); }

function purgeExpiredSessions() {
  var sh = sessionsSheet();
  var data = sh.getDataRange().getValues();
  var now = Date.now();
  for (var i = data.length - 1; i >= 1; i--) {
    var exp = new Date(data[i][2]).getTime();
    if (isNaN(exp) || exp < now) sh.deleteRow(i + 1);
  }
}

function createSession(email) {
  purgeExpiredSessions();
  var sh = sessionsSheet();
  var data = sh.getDataRange().getValues();
  var t = norm(email).toLowerCase();
  for (var i = data.length - 1; i >= 1; i--) {
    if (norm(data[i][0]).toLowerCase() === t) sh.deleteRow(i + 1);
  }
  var token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  var expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  sh.appendRow([norm(email), token, expires]);
  return token;
}

function findSessionByToken(token) {
  var tok = norm(token);
  if (!tok) return null;
  var sh = sessionsSheet();
  var data = sh.getDataRange().getValues();
  var now = Date.now();
  for (var i = 1; i < data.length; i++) {
    if (norm(data[i][1]) !== tok) continue;
    var exp = new Date(data[i][2]).getTime();
    if (isNaN(exp) || exp < now) return null;
    return { email: norm(data[i][0]), token: tok, row: i + 1 };
  }
  return null;
}

function validateSession(email, token) {
  var sess = findSessionByToken(token);
  if (!sess) return null;
  if (norm(sess.email).toLowerCase() !== norm(email).toLowerCase()) return null;
  return sess;
}

function revokeSession(email, token) {
  var sh = sessionsSheet();
  var data = sh.getDataRange().getValues();
  var t = norm(email).toLowerCase();
  var tok = norm(token);
  for (var i = data.length - 1; i >= 1; i--) {
    if (norm(data[i][1]) === tok && norm(data[i][0]).toLowerCase() === t) {
      sh.deleteRow(i + 1);
      return true;
    }
  }
  return false;
}

function requireAuth(req) {
  var email = norm(req.email);
  var token = norm(req.sessionToken);
  if (!email || !token) return { ok: false, error: "auth" };
  if (!validateSession(email, token)) return { ok: false, error: "auth" };
  var u = findUser(email);
  if (!u) return { ok: false, error: "auth" };
  return { ok: true, user: u };
}

function requireSession(req) {
  var token = norm(req.sessionToken);
  if (!token) return { ok: false, error: "auth" };
  var sess = findSessionByToken(token);
  if (!sess) return { ok: false, error: "auth" };
  return { ok: true, email: sess.email };
}

/* ---------------- Segurança: brute-force no login ---------------- */
function loginAttemptsSheet() {
  return ensureSheet(LOGIN_ATTEMPTS_SHEET, ["EMAIL", "FAILURES", "LOCKED_UNTIL", "LAST_ATTEMPT"]);
}

function findLoginAttemptRow(email) {
  var sh = loginAttemptsSheet();
  var data = sh.getDataRange().getValues();
  var t = norm(email).toLowerCase();
  for (var i = 1; i < data.length; i++) {
    if (norm(data[i][0]).toLowerCase() === t) {
      return {
        row: i + 1,
        failures: Number(data[i][1]) || 0,
        lockedUntil: norm(data[i][2]),
        lastAttempt: norm(data[i][3])
      };
    }
  }
  return null;
}

function checkLoginLockout(email) {
  var row = findLoginAttemptRow(email);
  if (!row) return { locked: false, attemptsLeft: MAX_LOGIN_ATTEMPTS };
  if (row.lockedUntil) {
    var until = new Date(row.lockedUntil).getTime();
    if (!isNaN(until) && until > Date.now()) {
      return { locked: true, retryAfter: Math.ceil((until - Date.now()) / 1000) };
    }
  }
  if (row.failures >= MAX_LOGIN_ATTEMPTS) {
    clearLoginAttempts(email);
    return { locked: false, attemptsLeft: MAX_LOGIN_ATTEMPTS };
  }
  return { locked: false, attemptsLeft: Math.max(0, MAX_LOGIN_ATTEMPTS - row.failures) };
}

function recordFailedLogin(email) {
  var sh = loginAttemptsSheet();
  var now = new Date().toISOString();
  var row = findLoginAttemptRow(email);
  if (!row) {
    sh.appendRow([norm(email), 1, "", now]);
    return 1;
  }
  var failures = row.failures + 1;
  var lockedUntil = "";
  if (failures >= MAX_LOGIN_ATTEMPTS) {
    lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
  }
  sh.getRange(row.row, 2, 1, 3).setValues([[failures, lockedUntil, now]]);
  return failures;
}

function clearLoginAttempts(email) {
  var sh = loginAttemptsSheet();
  var data = sh.getDataRange().getValues();
  var t = norm(email).toLowerCase();
  for (var i = data.length - 1; i >= 1; i--) {
    if (norm(data[i][0]).toLowerCase() === t) sh.deleteRow(i + 1);
  }
}

function handleLogin(req) {
  var email = norm(req.email);
  var lock = checkLoginLockout(email);
  if (lock.locked) return { ok: false, error: "bloqueado", retryAfter: lock.retryAfter };

  var u = findUser(email);
  if (!u) {
    recordFailedLogin(email);
    return { ok: false, error: "usuario" };
  }

  var prov = normPw(req.senha);
  var s1 = u.cols.senha >= 0 ? normPw(u.data[u.cols.senha]) : "";
  var s2 = u.cols.senhaTemp >= 0 ? normPw(u.data[u.cols.senhaTemp]) : "";
  var ok = (s1 !== "" && verifyStoredPassword(s1, prov)) ||
           (s2 !== "" && verifyStoredPassword(s2, prov));
  if (!ok) {
    recordFailedLogin(email);
    lock = checkLoginLockout(email);
    if (lock.locked) return { ok: false, error: "bloqueado", retryAfter: lock.retryAfter };
    return { ok: false, error: "senha", attemptsLeft: lock.attemptsLeft };
  }

  clearLoginAttempts(email);
  migratePasswordsOnLogin(u, prov);

  var weakPassword = !isStrongPassword(prov);
  var userEmail = cell(u, "email");
  return {
    ok: true,
    sessionToken: createSession(userEmail),
    nome: cell(u, "nome"),
    email: userEmail,
    perfil: cell(u, "perfil") || "Atendente",
    acessoAcademia: !!hasAcademiaAccess(u),
    weakPassword: weakPassword
  };
}

function handleLogout(req) {
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  revokeSession(cell(auth.user, "email"), norm(req.sessionToken));
  return { ok: true };
}

function handleGetState(req) {
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  var u = auth.user;
  return {
    ok: true,
    nome: cell(u, "nome"),
    perfil: cell(u, "perfil") || "Atendente",
    acessoAcademia: !!hasAcademiaAccess(u),
    concluidos: completedTopics(cell(u, "email"))
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
    out.senhaHashed = u.cols.senha >= 0 && isHashedPassword(u.data[u.cols.senha]);
    out.senhaTempHashed = u.cols.senhaTemp >= 0 && isHashedPassword(u.data[u.cols.senhaTemp]);
    out.matchSenha = u.cols.senha >= 0 && verifyStoredPassword(u.data[u.cols.senha], req.senha);
    out.matchTemp = u.cols.senhaTemp >= 0 && verifyStoredPassword(u.data[u.cols.senhaTemp], req.senha);
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
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  var email = cell(auth.user, "email");
  var sh = progressoSheet();
  var data = sh.getDataRange().getValues();
  var topic = norm(req.topic);
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
function handleGetComments(req) {
  var sess = requireSession(req);
  if (!sess.ok) return sess;
  return { ok: true, comments: readTable("Comentarios", req.topic) };
}

function handleAddComment(req) {
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  var u = auth.user;
  var sh = ensureSheet("Comentarios", ["TOPICO", "NOME", "EMAIL", "PERFIL", "TEXTO", "TS"]);
  sh.appendRow([
    norm(req.topic), cell(u, "nome"), cell(u, "email"),
    cell(u, "perfil"), norm(req.texto), new Date().toISOString()
  ]);
  return { ok: true };
}

function handleGetContent(req) {
  var sess = requireSession(req);
  if (!sess.ok) return sess;
  return { ok: true, blocks: readTable("Conteudo", req.topic) };
}

function handleAddContent(req) {
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  var u = auth.user;
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

function handleGetDuvidas(req) {
  var sess = requireSession(req);
  if (!sess.ok) return sess;
  return { ok: true, duvidas: listDuvidas() };
}

function handleAddDuvida(req) {
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  var u = auth.user;
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
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  var u = auth.user;
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

/* ---------------- Desafio do Dia (quiz) ---------------- */
var DESAFIO_PERGUNTAS_HEADERS = ["ID", "PERGUNTA", "OPCAO_A", "OPCAO_B", "OPCAO_C", "OPCAO_D", "CORRETA", "ATIVO", "CRIADO_POR", "CRIADO_EM"];
var DESAFIO_RESPOSTAS_HEADERS = ["ID", "QUESTAO_ID", "EMAIL", "NOME", "ESCOLHA", "ACERTOU", "TS"];

function desafioPerguntasSheet() { return ensureSheet("DesafioPerguntas", DESAFIO_PERGUNTAS_HEADERS); }
function desafioRespostasSheet() { return ensureSheet("DesafioRespostas", DESAFIO_RESPOSTAS_HEADERS); }

function parseDesafioPergunta(row) {
  return {
    id: norm(row[0]),
    pergunta: norm(row[1]),
    opcoes: {
      A: norm(row[2]),
      B: norm(row[3]),
      C: norm(row[4]),
      D: norm(row[5])
    },
    correta: norm(row[6]),
    ativo: isSim(row[7]),
    criadoPor: norm(row[8]),
    criadoEm: norm(row[9])
  };
}

function listDesafioPerguntas(admin) {
  var data = desafioPerguntasSheet().getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var q = parseDesafioPergunta(data[i]);
    if (!q.id || !q.pergunta) continue;
    if (!admin && !q.ativo) continue;
    var item = {
      id: q.id,
      pergunta: q.pergunta,
      opcoes: q.opcoes,
      ativo: q.ativo,
      criadoPor: q.criadoPor,
      criadoEm: q.criadoEm
    };
    if (admin) item.correta = q.correta;
    out.push(item);
  }
  return out;
}

function findDesafioPergunta(id) {
  var data = desafioPerguntasSheet().getDataRange().getValues();
  var target = norm(id);
  for (var i = 1; i < data.length; i++) {
    var q = parseDesafioPergunta(data[i]);
    if (q.id === target) return q;
  }
  return null;
}

function listDesafioRespostasPorEmail(email) {
  var data = desafioRespostasSheet().getDataRange().getValues();
  var t = norm(email).toLowerCase();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    if (norm(data[i][2]).toLowerCase() !== t) continue;
    out.push({
      id: norm(data[i][0]),
      questaoId: norm(data[i][1]),
      escolha: norm(data[i][4]),
      acertou: isSim(data[i][5]),
      ts: norm(data[i][6])
    });
  }
  return out;
}

function latestDesafioResposta(email, questaoId) {
  var all = listDesafioRespostasPorEmail(email);
  var qid = norm(questaoId);
  var latest = null;
  for (var i = 0; i < all.length; i++) {
    if (all[i].questaoId !== qid) continue;
    if (!latest || String(all[i].ts) > String(latest.ts)) latest = all[i];
  }
  return latest;
}

function handleGetDesafio(req) {
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  var u = auth.user;
  var email = cell(u, "email");
  var admin = /admin/i.test(cell(u, "perfil"));
  return {
    ok: true,
    perguntas: listDesafioPerguntas(admin),
    respostas: listDesafioRespostasPorEmail(email)
  };
}

function handleAddDesafioPergunta(req) {
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  var u = auth.user;
  if (!/admin/i.test(cell(u, "perfil"))) return { ok: false, error: "perfil" };
  var pergunta = norm(req.pergunta);
  if (!pergunta) return { ok: false, message: "Pergunta vazia" };
  var op = req.opcoes || {};
  var a = norm(op.A), b = norm(op.B), c = norm(op.C), d = norm(op.D);
  if (!a || !b) return { ok: false, message: "Informe ao menos as opções A e B" };
  var correta = stripAccents(norm(req.correta)).toUpperCase();
  if ("ABCD".indexOf(correta) < 0) return { ok: false, message: "Resposta correta inválida (use A, B, C ou D)" };
  if (correta === "C" && !c) return { ok: false, message: "Opção C está vazia" };
  if (correta === "D" && !d) return { ok: false, message: "Opção D está vazia" };
  var ativo = req.ativo !== false;
  var id = "Q" + new Date().getTime();
  desafioPerguntasSheet().appendRow([
    id, pergunta, a, b, c, d, correta, ativo ? "SIM" : "NAO",
    cell(u, "nome"), new Date().toISOString()
  ]);
  return { ok: true, id: id };
}

function handleSubmitDesafioResposta(req) {
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  var u = auth.user;
  var email = cell(u, "email");
  var questaoId = norm(req.questaoId);
  var escolha = stripAccents(norm(req.escolha)).toUpperCase();
  if (!questaoId || "ABCD".indexOf(escolha) < 0) return { ok: false, message: "Dados inválidos" };
  var q = findDesafioPergunta(questaoId);
  if (!q || !q.ativo) return { ok: false, message: "Pergunta não encontrada ou inativa" };
  var latest = latestDesafioResposta(email, questaoId);
  if (latest && latest.acertou) return { ok: true, acertou: true, jaAcertou: true };
  var correta = stripAccents(norm(q.correta)).toUpperCase();
  var acertou = escolha === correta;
  var id = "R" + new Date().getTime();
  desafioRespostasSheet().appendRow([
    id, questaoId, email, cell(u, "nome"), escolha,
    acertou ? "SIM" : "NAO", new Date().toISOString()
  ]);
  return { ok: true, acertou: acertou };
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
