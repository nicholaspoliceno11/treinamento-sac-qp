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
 *   (a coluna "ACESSO BACKOFFICE" na aba Login Treinamento — use SIM ou NÃO;
 *    a coluna legada "ACESSO ACADEMIA" também é aceita)
 *   OU uma aba separada "ACESSO BACKOFFICE" (ou "ACESSO ACADEMIA") com colunas NOME + ACESSO (Sim/Não)
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
var ACESSO_BACKOFFICE_SHEET = "ACESSO BACKOFFICE"; // aba opcional (NOME + ACESSO); legado: "ACESSO ACADEMIA"

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
      case "askMila":       return json(handleAskMila(req));
      case "getMilaFaq":    return json(handleGetMilaFaq(req));
      case "addMilaFaq":    return json(handleAddMilaFaq(req));
      case "updateMilaFaq": return json(handleUpdateMilaFaq(req));
      case "deleteMilaFaq": return json(handleDeleteMilaFaq(req));
      case "getDesafio":    return json(handleGetDesafio(req));
      case "addDesafioPergunta": return json(handleAddDesafioPergunta(req));
      case "submitDesafioResposta": return json(handleSubmitDesafioResposta(req));
      case "listUsers":       return json(handleListUsers(req));
      case "createUser":      return json(handleCreateUser(req));
      case "updateUser":      return json(handleUpdateUser(req));
      case "deleteUser":      return json(handleDeleteUser(req));
      case "changePassword":  return json(handleChangePassword(req));
      case "getInformativos": return json(handleGetInformativos(req));
      case "addInformativo":  return json(handleAddInformativo(req));
      case "markInformativoRead": return json(handleMarkInformativoRead(req));
      case "addInformativoComment": return json(handleAddInformativoComment(req));
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
    acessoBackoffice: find("ACESSO BACKOFFICE", "ACESSO ACADEMIA", "ACESSO PARA TOPICO ACADEMIA", "TOPICO ACADEMIA"),
    bloqueado: find("BLOQUEADO", "BLOQUEADO ACESSO", "ACESSO BLOQUEADO")
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

function acessoBackofficeVal(u) {
  if (!u || u.cols.acessoBackoffice < 0) return "";
  return loginSheet().getRange(u.row, u.cols.acessoBackoffice + 1).getDisplayValue();
}

function backofficeSheetCols(headers) {
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
    acesso: find("ACESSO BACKOFFICE", "ACESSO ACADEMIA", "ACESSO")
  };
}

// Lê aba separada de acesso ao Backoffice (NOME + ACESSO). Aceita nome legado "ACESSO ACADEMIA".
function backofficeAccessFromSheet(u) {
  var sh = getSS().getSheetByName(ACESSO_BACKOFFICE_SHEET) || getSS().getSheetByName("ACESSO ACADEMIA");
  if (!sh) return null;
  var values = sh.getDataRange().getValues();
  if (!values.length) return null;
  var cols = backofficeSheetCols(values[0]);
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

function hasBackofficeAccess(u) {
  if (!u) return false;
  if (/admin/i.test(cell(u, "perfil"))) return true;
  if (/backoffice/i.test(cell(u, "perfil"))) return true;
  // Coluna na aba Login Treinamento (lê o texto exibido: Sim/Não)
  if (u.cols.acessoBackoffice >= 0) {
    var val = acessoBackofficeVal(u);
    if (isAccessError(val)) return false;
    if (isNao(val)) return false;
    return isSim(val);
  }
  // Aba separada "ACESSO BACKOFFICE" (ou legado "ACESSO ACADEMIA")
  var fromSheet = backofficeAccessFromSheet(u);
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
  if (!/[A-Z]/.test(p)) return false;
  if (!/[0-9]/.test(p)) return false;
  if (!/[^A-Za-z0-9]/.test(p)) return false;
  return true;
}

function passwordRequirementsMessage() {
  return "A senha deve ter no mínimo 8 caracteres, 1 letra maiúscula, 1 número e 1 símbolo.";
}

function verifyUserPassword(u, plain) {
  var prov = normPw(plain);
  if (!prov) return false;
  var s1 = u.cols.senha >= 0 ? normPw(u.data[u.cols.senha]) : "";
  var s2 = u.cols.senhaTemp >= 0 ? normPw(u.data[u.cols.senhaTemp]) : "";
  return (s1 !== "" && verifyStoredPassword(s1, prov)) ||
         (s2 !== "" && verifyStoredPassword(s2, prov));
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
  if (isUserBlocked(u)) {
    return { ok: false, error: "conta_bloqueada" };
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
    acessoBackoffice: !!hasBackofficeAccess(u),
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
    acessoBackoffice: !!hasBackofficeAccess(u),
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

/* ---------------- Mila — atendente virtual (FAQ) ---------------- */
var MILA_FAQ_HEADERS = ["ID", "PERGUNTA", "RESPOSTA", "PALAVRAS_CHAVE", "ATIVO", "CRIADO_POR", "CRIADO_EM"];
var MILA_STOP_WORDS = ["a","o","e","de","da","do","das","dos","em","um","uma","uns","umas","os","as","que","com","por","para","no","na","nos","nas","eu","voce","como","qual","quais","me","minha","meu","se","sua","seu","ao","aos","e","ou","ja","mais","muito","pouco","ser","esta","este","isso","essa","esse"];

function milaFaqSheet() { return ensureSheet("MilaFAQ", MILA_FAQ_HEADERS); }

function milaNormalize(s) {
  return stripAccents(norm(s)).toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function milaTokens(s) {
  var parts = milaNormalize(s).split(" ");
  var out = [];
  var i, w;
  for (i = 0; i < parts.length; i++) {
    w = parts[i];
    if (w.length >= 2 && MILA_STOP_WORDS.indexOf(w) < 0) out.push(w);
  }
  return out;
}

function parseMilaFaqRow(row) {
  return {
    id: norm(row[0]),
    pergunta: norm(row[1]),
    resposta: norm(row[2]),
    palavrasChave: norm(row[3]),
    ativo: isSim(row[4]),
    criadoPor: norm(row[5]),
    criadoEm: norm(row[6])
  };
}

function listMilaFaq(onlyActive) {
  var data = milaFaqSheet().getDataRange().getValues();
  var out = [];
  var i, item;
  for (i = 1; i < data.length; i++) {
    item = parseMilaFaqRow(data[i]);
    if (!item.id || !item.pergunta) continue;
    if (onlyActive && !item.ativo) continue;
    out.push(item);
  }
  return out;
}

function findMilaFaqRow(id) {
  var data = milaFaqSheet().getDataRange().getValues();
  var target = norm(id);
  var i;
  for (i = 1; i < data.length; i++) {
    if (norm(data[i][0]) === target) return i + 1;
  }
  return -1;
}

function milaScore(userQ, faq) {
  var u = milaNormalize(userQ);
  var p = milaNormalize(faq.pergunta);
  var score = 0;
  var userTokens, faqTokens, matches, i, j, k, key, keys;

  if (!u || !p) return 0;
  if (u === p) return 100;
  if (p.indexOf(u) >= 0 || u.indexOf(p) >= 0) return 88;

  if (faq.palavrasChave) {
    keys = faq.palavrasChave.split(/[,;|]/);
    for (k = 0; k < keys.length; k++) {
      key = milaNormalize(keys[k]);
      if (key && (u === key || u.indexOf(key) >= 0 || key.indexOf(u) >= 0)) score = Math.max(score, 82);
    }
  }

  userTokens = milaTokens(userQ);
  faqTokens = milaTokens(faq.pergunta + " " + (faq.palavrasChave || ""));
  if (!userTokens.length || !faqTokens.length) return score;

  matches = 0;
  for (i = 0; i < userTokens.length; i++) {
    for (j = 0; j < faqTokens.length; j++) {
      if (userTokens[i] === faqTokens[j]) { matches++; break; }
      if (userTokens[i].length >= 4 && faqTokens[j].indexOf(userTokens[i]) >= 0) { matches += 0.85; break; }
      if (faqTokens[j].length >= 4 && userTokens[i].indexOf(faqTokens[j]) >= 0) { matches += 0.85; break; }
    }
  }
  score = Math.max(score, Math.round((matches / userTokens.length) * 75));
  return Math.min(100, score);
}

function handleAskMila(req) {
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  var pergunta = norm(req.pergunta);
  if (!pergunta) return { ok: false, message: "Digite uma pergunta" };

  var faqs = listMilaFaq(true);
  var best = null;
  var bestScore = 0;
  var suggestions = [];
  var i, sc, item;

  for (i = 0; i < faqs.length; i++) {
    sc = milaScore(pergunta, faqs[i]);
    if (sc > bestScore) { bestScore = sc; best = faqs[i]; }
    if (sc >= 28) suggestions.push({ pergunta: faqs[i].pergunta, score: sc });
  }
  suggestions.sort(function (a, b) { return b.score - a.score; });

  if (best && bestScore >= 42) {
    return {
      ok: true,
      resposta: best.resposta,
      perguntaBase: best.pergunta,
      score: bestScore,
      matchId: best.id
    };
  }

  return {
    ok: true,
    semMatch: true,
    resposta: "Hmm, não encontrei uma resposta exata para isso na minha base. Tente reformular ou toque em uma sugestão abaixo. Você também pode usar a Central de Dúvidas para falar com a liderança! 🙂",
    sugestoes: suggestions.slice(0, 4).map(function (s) { return s.pergunta; })
  };
}

function handleGetMilaFaq(req) {
  var auth = requireAdmin(req);
  if (!auth.ok) return auth;
  return { ok: true, faq: listMilaFaq(false) };
}

function handleAddMilaFaq(req) {
  var auth = requireAdmin(req);
  if (!auth.ok) return auth;
  var pergunta = norm(req.pergunta);
  var resposta = norm(req.resposta);
  if (!pergunta || !resposta) return { ok: false, message: "Pergunta e resposta são obrigatórias" };
  var id = "M" + new Date().getTime();
  milaFaqSheet().appendRow([
    id, pergunta, resposta, norm(req.palavrasChave),
    req.ativo === false ? "NAO" : "SIM",
    cell(auth.user, "nome"), new Date().toISOString()
  ]);
  return { ok: true, id: id };
}

function handleUpdateMilaFaq(req) {
  var auth = requireAdmin(req);
  if (!auth.ok) return auth;
  var id = norm(req.id);
  if (!id) return { ok: false, message: "ID inválido" };
  var row = findMilaFaqRow(id);
  if (row < 0) return { ok: false, message: "Pergunta não encontrada" };
  var changes = req.changes || {};
  var sh = milaFaqSheet();
  if (changes.pergunta != null) sh.getRange(row, 2).setValue(norm(changes.pergunta));
  if (changes.resposta != null) sh.getRange(row, 3).setValue(norm(changes.resposta));
  if (changes.palavrasChave != null) sh.getRange(row, 4).setValue(norm(changes.palavrasChave));
  if (changes.ativo != null) sh.getRange(row, 5).setValue(changes.ativo ? "SIM" : "NAO");
  return { ok: true };
}

function handleDeleteMilaFaq(req) {
  var auth = requireAdmin(req);
  if (!auth.ok) return auth;
  var id = norm(req.id);
  if (!id) return { ok: false, message: "ID inválido" };
  var row = findMilaFaqRow(id);
  if (row < 0) return { ok: false, message: "Pergunta não encontrada" };
  milaFaqSheet().deleteRow(row);
  return { ok: true };
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

/* ---------------- Informativos (boletim na home) ---------------- */
var INFORMATIVOS_HEADERS = ["ID", "TITULO", "TEXTO", "AUTOR", "EMAIL", "CRIADO_EM", "ANEXO_TIPO", "ANEXO_VALOR", "ANEXO_NOME"];
var INFORMATIVO_LEITURAS_HEADERS = ["ID", "INFO_ID", "EMAIL", "NOME", "PERFIL", "TS"];
var INFORMATIVO_COMENTARIOS_HEADERS = ["ID", "INFO_ID", "NOME", "EMAIL", "PERFIL", "TEXTO", "TS"];
var INFORMATIVOS_DRIVE_FOLDER = "QP Portal Informativos";
var MAX_INFO_IMAGE_CHARS = 50000;
var MAX_INFO_FILE_BYTES = 20 * 1024 * 1024; // 20 MB (PDF ou vídeo anexado)

function ensureColumns(sh, headers) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var row1 = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var existing = row1.map(headerKey);
  var needed = headers.map(headerKey);
  var i, col;
  for (i = 0; i < needed.length; i++) {
    if (existing.indexOf(needed[i]) < 0) {
      col = sh.getLastColumn() + 1;
      sh.getRange(1, col).setValue(headers[i]);
    }
  }
}

function informativosSheet() {
  var sh = ensureSheet("Informativos", INFORMATIVOS_HEADERS);
  ensureColumns(sh, INFORMATIVOS_HEADERS);
  return sh;
}

function informativosDriveFolder() {
  var folders = DriveApp.getFoldersByName(INFORMATIVOS_DRIVE_FOLDER);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(INFORMATIVOS_DRIVE_FOLDER);
}

function drivePreviewUrl(fileId) {
  return "https://drive.google.com/file/d/" + fileId + "/preview";
}

function saveInformativoFileFromBase64(base64, mimeType, fileName) {
  var raw = norm(base64);
  if (!raw) return { ok: false, message: "Arquivo vazio" };
  var bytes;
  try {
    bytes = Utilities.base64Decode(raw);
  } catch (e) {
    return { ok: false, message: "Arquivo inválido" };
  }
  if (bytes.length > MAX_INFO_FILE_BYTES) {
    return { ok: false, message: "Arquivo muito grande (máx. 20 MB)" };
  }
  mimeType = norm(mimeType) || "application/octet-stream";
  fileName = norm(fileName) || "anexo";
  var blob = Utilities.newBlob(bytes, mimeType, fileName);
  var file = informativosDriveFolder().createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e2) {}
  return { ok: true, url: drivePreviewUrl(file.getId()), nome: fileName };
}

function informativoLeiturasSheet() { return ensureSheet("InformativoLeituras", INFORMATIVO_LEITURAS_HEADERS); }
function informativoComentariosSheet() { return ensureSheet("InformativoComentarios", INFORMATIVO_COMENTARIOS_HEADERS); }

function listInformativos(userEmail, admin) {
  var infoData = informativosSheet().getDataRange().getValues();
  var leiturasData = informativoLeiturasSheet().getDataRange().getValues();
  var comentariosData = informativoComentariosSheet().getDataRange().getValues();
  var t = norm(userEmail).toLowerCase();
  var leiturasByInfo = {};
  var i, j, k, infoId, id, row, leituras, lido, item;

  for (i = 1; i < leiturasData.length; i++) {
    infoId = norm(leiturasData[i][1]);
    if (!leiturasByInfo[infoId]) leiturasByInfo[infoId] = [];
    leiturasByInfo[infoId].push({
      nome: norm(leiturasData[i][3]),
      email: norm(leiturasData[i][2]),
      perfil: norm(leiturasData[i][4]),
      ts: norm(leiturasData[i][5])
    });
  }

  var comentariosByInfo = {};
  for (j = 1; j < comentariosData.length; j++) {
    id = norm(comentariosData[j][1]);
    if (!comentariosByInfo[id]) comentariosByInfo[id] = [];
    comentariosByInfo[id].push({
      nome: norm(comentariosData[j][2]),
      email: norm(comentariosData[j][3]),
      perfil: norm(comentariosData[j][4]),
      texto: norm(comentariosData[j][5]),
      ts: norm(comentariosData[j][6])
    });
  }

  var out = [];
  for (k = infoData.length - 1; k >= 1; k--) {
    row = infoData[k];
    id = norm(row[0]);
    if (!id) continue;
    leituras = leiturasByInfo[id] || [];
    lido = false;
    for (i = 0; i < leituras.length; i++) {
      if (norm(leituras[i].email).toLowerCase() === t) { lido = true; break; }
    }
    item = {
      id: id,
      titulo: norm(row[1]),
      texto: norm(row[2]),
      autor: norm(row[3]),
      criadoEm: norm(row[5]),
      anexoTipo: norm(row[6]),
      anexoValor: norm(row[7]),
      anexoNome: norm(row[8]),
      lido: lido,
      totalLeituras: leituras.length,
      comentarios: comentariosByInfo[id] || []
    };
    if (admin) item.leituras = leituras;
    out.push(item);
  }
  return out;
}

function findInformativo(id) {
  var data = informativosSheet().getDataRange().getValues();
  var target = norm(id);
  for (var i = 1; i < data.length; i++) {
    if (norm(data[i][0]) === target) return true;
  }
  return false;
}

function hasInformativoRead(infoId, email) {
  var data = informativoLeiturasSheet().getDataRange().getValues();
  var iid = norm(infoId);
  var t = norm(email).toLowerCase();
  for (var i = 1; i < data.length; i++) {
    if (norm(data[i][1]) === iid && norm(data[i][2]).toLowerCase() === t) return true;
  }
  return false;
}

function handleGetInformativos(req) {
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  var email = cell(auth.user, "email");
  var admin = /admin/i.test(cell(auth.user, "perfil"));
  return { ok: true, informativos: listInformativos(email, admin) };
}

function handleAddInformativo(req) {
  var auth = requireAdmin(req);
  if (!auth.ok) return auth;
  var titulo = norm(req.titulo);
  var texto = norm(req.texto);
  if (!titulo || !texto) return { ok: false, message: "Título e texto são obrigatórios" };

  var anexoTipo = norm(req.anexoTipo);
  var anexoValor = "";
  var anexoNome = norm(req.anexoNome);
  var saved;

  if (anexoTipo === "imagem") {
    anexoValor = norm(req.anexoValor);
    if (!anexoValor) return { ok: false, message: "Selecione uma foto para anexar" };
    if (anexoValor.length > MAX_INFO_IMAGE_CHARS) {
      return { ok: false, message: "Imagem muito grande após compressão. Use uma foto menor." };
    }
    if (!anexoNome) anexoNome = "foto.jpg";
  } else if (anexoTipo === "pdf") {
    saved = saveInformativoFileFromBase64(req.anexoBase64, req.anexoMime || "application/pdf", anexoNome || "documento.pdf");
    if (!saved.ok) return saved;
    anexoValor = saved.url;
    anexoNome = saved.nome;
  } else if (anexoTipo === "video") {
    if (norm(req.anexoBase64)) {
      saved = saveInformativoFileFromBase64(req.anexoBase64, req.anexoMime || "video/mp4", anexoNome || "video.mp4");
      if (!saved.ok) return saved;
      anexoValor = saved.url;
      anexoNome = saved.nome;
    } else {
      anexoValor = norm(req.anexoValor);
      if (!anexoValor || !/^https?:\/\//i.test(anexoValor)) {
        return { ok: false, message: "Cole um link de vídeo (YouTube/Vimeo) ou anexe um arquivo MP4/WebM" };
      }
      if (!anexoNome) anexoNome = "vídeo";
    }
  } else if (anexoTipo) {
    return { ok: false, message: "Tipo de anexo inválido" };
  }

  var id = "I" + new Date().getTime();
  informativosSheet().appendRow([
    id, titulo, texto, cell(auth.user, "nome"), cell(auth.user, "email"),
    new Date().toISOString(), anexoTipo, anexoValor, anexoNome
  ]);
  return { ok: true, id: id };
}

function handleMarkInformativoRead(req) {
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  var infoId = norm(req.informativoId);
  if (!infoId) return { ok: false, message: "Informativo inválido" };
  if (!findInformativo(infoId)) return { ok: false, message: "Informativo não encontrado" };
  var email = cell(auth.user, "email");
  if (hasInformativoRead(infoId, email)) return { ok: true, jaLido: true };
  var id = "L" + new Date().getTime();
  informativoLeiturasSheet().appendRow([
    id, infoId, email, cell(auth.user, "nome"), cell(auth.user, "perfil"),
    new Date().toISOString()
  ]);
  return { ok: true };
}

function handleAddInformativoComment(req) {
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  var infoId = norm(req.informativoId);
  var texto = norm(req.texto);
  if (!infoId || !texto) return { ok: false, message: "Comentário vazio" };
  if (!findInformativo(infoId)) return { ok: false, message: "Informativo não encontrado" };
  var id = "C" + new Date().getTime();
  informativoComentariosSheet().appendRow([
    id, infoId, cell(auth.user, "nome"), cell(auth.user, "email"),
    cell(auth.user, "perfil"), texto, new Date().toISOString()
  ]);
  return { ok: true, id: id };
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

/* ---------------- Administração de usuários ---------------- */
function ensureBloqueadoColumn() {
  var sh = loginSheet();
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var cols = loginCols(headers);
  if (cols.bloqueado >= 0) return cols;
  var newCol = lastCol + 1;
  sh.getRange(1, newCol).setValue("BLOQUEADO");
  return loginCols(sh.getRange(1, 1, 1, newCol).getValues()[0]);
}

function bloqueadoVal(u) {
  if (!u || u.cols.bloqueado < 0) return "";
  return loginSheet().getRange(u.row, u.cols.bloqueado + 1).getDisplayValue();
}

function isUserBlocked(u) {
  if (!u || u.cols.bloqueado < 0) return false;
  return isSim(bloqueadoVal(u));
}

function normPerfil(perfil) {
  var p = stripAccents(norm(perfil)).toLowerCase();
  if (/admin/.test(p)) return "Administrador";
  if (/backoffice/.test(p)) return "Backoffice";
  return "Atendente";
}

function verifyAdminPassword(u, senha) {
  return verifyUserPassword(u, senha);
}

function requireAdmin(req) {
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  if (!/admin/i.test(cell(auth.user, "perfil"))) return { ok: false, error: "perfil" };
  return auth;
}

function requireAdminWithPassword(req) {
  var auth = requireAdmin(req);
  if (!auth.ok) return auth;
  if (!verifyAdminPassword(auth.user, req.adminSenha)) {
    return { ok: false, error: "senha_admin" };
  }
  return auth;
}

function revokeSessionsForEmail(email) {
  var sh = sessionsSheet();
  var data = sh.getDataRange().getValues();
  var t = norm(email).toLowerCase();
  for (var i = data.length - 1; i >= 1; i--) {
    if (norm(data[i][0]).toLowerCase() === t) sh.deleteRow(i + 1);
  }
}

function maxLoginColIndex(cols) {
  var max = 0;
  var keys = ["nome", "email", "senha", "senhaTemp", "perfil", "andamento", "acessoBackoffice", "bloqueado"];
  for (var i = 0; i < keys.length; i++) {
    if (cols[keys[i]] > max) max = cols[keys[i]];
  }
  return max;
}

function newLoginRow(cols, data) {
  var width = maxLoginColIndex(cols) + 1;
  var row = [];
  for (var i = 0; i < width; i++) row.push("");
  if (cols.nome >= 0) row[cols.nome] = norm(data.nome);
  if (cols.email >= 0) row[cols.email] = norm(data.email);
  if (cols.senha >= 0) row[cols.senha] = data.senhaHash || "";
  if (cols.perfil >= 0) row[cols.perfil] = normPerfil(data.perfil);
  if (cols.andamento >= 0) row[cols.andamento] = norm(data.andamento) || "0%";
  if (cols.acessoBackoffice >= 0) row[cols.acessoBackoffice] = data.acessoBackoffice ? "SIM" : "NAO";
  if (cols.bloqueado >= 0) row[cols.bloqueado] = data.bloqueado ? "SIM" : "NAO";
  return row;
}

function userPublic(u) {
  return {
    email: cell(u, "email"),
    nome: cell(u, "nome"),
    perfil: cell(u, "perfil") || "Atendente",
    acessoBackoffice: !!hasBackofficeAccess(u),
    bloqueado: isUserBlocked(u),
    andamento: u.cols.andamento >= 0 ? norm(u.data[u.cols.andamento]) : "0%"
  };
}

function listAllUsers() {
  ensureBloqueadoColumn();
  var ld = loginData();
  var out = [];
  for (var i = 1; i < ld.values.length; i++) {
    var row = ld.values[i];
    if (!norm(row[ld.cols.email])) continue;
    out.push(userPublic({ row: i + 1, data: row, cols: ld.cols }));
  }
  out.sort(function (a, b) {
    return String(a.nome).localeCompare(String(b.nome), "pt-BR");
  });
  return out;
}

function handleListUsers(req) {
  var auth = requireAdmin(req);
  if (!auth.ok) return auth;
  return { ok: true, users: listAllUsers() };
}

function handleCreateUser(req) {
  var auth = requireAdminWithPassword(req);
  if (!auth.ok) return auth;
  var user = req.user || {};
  var nome = norm(user.nome);
  var email = norm(user.email);
  var senha = normPw(user.senha);
  if (!nome || !email) return { ok: false, message: "Nome e e-mail são obrigatórios" };
  if (!senha) return { ok: false, message: "Informe uma senha inicial" };
  if (!isStrongPassword(senha)) {
    return { ok: false, message: passwordRequirementsMessage() };
  }
  if (findUser(email)) return { ok: false, message: "E-mail já cadastrado" };

  var cols = ensureBloqueadoColumn();
  loginSheet().appendRow(newLoginRow(cols, {
    nome: nome,
    email: email,
    senhaHash: hashPassword(senha),
    perfil: normPerfil(user.perfil),
    andamento: "0%",
    acessoBackoffice: !!user.acessoBackoffice,
    bloqueado: !!user.bloqueado
  }));
  return { ok: true };
}

function handleUpdateUser(req) {
  var auth = requireAdminWithPassword(req);
  if (!auth.ok) return auth;
  var targetEmail = norm(req.targetEmail);
  if (!targetEmail) return { ok: false, message: "E-mail do usuário não informado" };

  var u = findUser(targetEmail);
  if (!u) return { ok: false, message: "Usuário não encontrado" };

  var adminEmail = cell(auth.user, "email").toLowerCase();
  var changes = req.changes || {};
  var sh = loginSheet();
  var cols = ensureBloqueadoColumn();
  u.cols = cols;

  if (changes.nome != null && cols.nome >= 0) {
    sh.getRange(u.row, cols.nome + 1).setValue(norm(changes.nome));
  }
  if (changes.perfil != null && cols.perfil >= 0) {
    var novoPerfil = normPerfil(changes.perfil);
    if (targetEmail.toLowerCase() === adminEmail && !/admin/i.test(novoPerfil)) {
      return { ok: false, message: "Você não pode remover seu próprio perfil de administrador" };
    }
    sh.getRange(u.row, cols.perfil + 1).setValue(novoPerfil);
  }
  if (changes.acessoBackoffice != null && cols.acessoBackoffice >= 0) {
    sh.getRange(u.row, cols.acessoBackoffice + 1).setValue(changes.acessoBackoffice ? "SIM" : "NAO");
  }
  if (changes.bloqueado != null && cols.bloqueado >= 0) {
    if (targetEmail.toLowerCase() === adminEmail && changes.bloqueado) {
      return { ok: false, message: "Você não pode bloquear sua própria conta" };
    }
    sh.getRange(u.row, cols.bloqueado + 1).setValue(changes.bloqueado ? "SIM" : "NAO");
    if (changes.bloqueado) revokeSessionsForEmail(targetEmail);
  }
  if (changes.senha != null) {
    var novaSenha = normPw(changes.senha);
    if (novaSenha) {
      if (!isStrongPassword(novaSenha)) {
        return { ok: false, message: passwordRequirementsMessage() };
      }
      if (cols.senha >= 0) sh.getRange(u.row, cols.senha + 1).setValue(hashPassword(novaSenha));
      if (cols.senhaTemp >= 0) sh.getRange(u.row, cols.senhaTemp + 1).setValue("");
      revokeSessionsForEmail(targetEmail);
    }
  }

  return { ok: true };
}

function handleDeleteUser(req) {
  var auth = requireAdminWithPassword(req);
  if (!auth.ok) return auth;
  var targetEmail = norm(req.targetEmail);
  if (!targetEmail) return { ok: false, message: "E-mail do usuário não informado" };
  if (targetEmail.toLowerCase() === cell(auth.user, "email").toLowerCase()) {
    return { ok: false, message: "Você não pode excluir sua própria conta" };
  }

  var u = findUser(targetEmail);
  if (!u) return { ok: false, message: "Usuário não encontrado" };

  loginSheet().deleteRow(u.row);
  revokeSessionsForEmail(targetEmail);
  clearLoginAttempts(targetEmail);
  return { ok: true };
}

function handleChangePassword(req) {
  var auth = requireAuth(req);
  if (!auth.ok) return auth;
  var senhaAtual = normPw(req.senhaAtual);
  var novaSenha = normPw(req.novaSenha);
  if (!senhaAtual || !novaSenha) {
    return { ok: false, message: "Informe a senha atual e a nova senha." };
  }
  if (!verifyUserPassword(auth.user, senhaAtual)) {
    return { ok: false, error: "senha_atual" };
  }
  if (!isStrongPassword(novaSenha)) {
    return { ok: false, error: "senha_fraca", message: passwordRequirementsMessage() };
  }
  if (senhaAtual === novaSenha) {
    return { ok: false, message: "A nova senha deve ser diferente da atual." };
  }

  var u = findUser(cell(auth.user, "email"));
  if (!u) return { ok: false, error: "auth" };
  var sh = loginSheet();
  var cols = u.cols;
  if (cols.senha >= 0) sh.getRange(u.row, cols.senha + 1).setValue(hashPassword(novaSenha));
  if (cols.senhaTemp >= 0) sh.getRange(u.row, cols.senhaTemp + 1).setValue("");
  return { ok: true };
}
