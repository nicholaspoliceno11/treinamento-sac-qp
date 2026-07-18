/* =========================================================================
 * Portal de Treinamento Quero Passagem
 * Login por planilha (via Apps Script), perfis, progresso e comentários.
 * ========================================================================= */
(function () {
  "use strict";

  var APP_VERSION = "21";

  // Tópicos que contam para a barra de progresso (rota -> título)
  var TOPICS = [
    { id: "onboarding", titulo: "Onboarding" },
    { id: "atendimento", titulo: "Atendimento" },
    { id: "metodo3d", titulo: "Método 3D" },
    { id: "prazos", titulo: "Financeiro / Prazos" },
    { id: "antt", titulo: "ANTT" },
    { id: "cms", titulo: "CMS" },
    { id: "videos", titulo: "Backoffice / Treinamentos" }
  ];
  var TOPIC_IDS = TOPICS.map(function (t) { return t.id; });
  var TOTAL = TOPICS.length;
  var BACKOFFICE_TOPIC = "videos";

  var state = {
    session: null,        // { nome, email, perfil, acessoBackoffice, token }
    concluidos: [],       // ["onboarding", ...]
    percent: 0,
    accessResolved: false, // true após login/hydrate confirmarem acesso na API
    pendingWeakPassword: null // senha usada no login (para troca obrigatória opcional)
  };
  var milaChatOpen = false;
  var milaGreeted = false;

  // -------------------------------------------------- utilidades
  function getApiUrl() {
    var override = null;
    try { override = localStorage.getItem("qp_api_url"); } catch (e) {}
    return (override || (window.QP_CONFIG && window.QP_CONFIG.API_URL) || "").trim();
  }
  function apiConfigured() { return !!getApiUrl(); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function isHttpUrl(u) { return /^https?:\/\//i.test(String(u || "").trim()); }

  function ytEmbed(url) {
    // Domínio nocookie + rel=0/modestbranding: reduz marca do YouTube e mantém
    // a reprodução dentro do portal (sem sugerir "assistir no YouTube").
    var m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/);
    if (m) return "https://www.youtube-nocookie.com/embed/" + m[1] + "?rel=0&modestbranding=1&playsinline=1";
    var v = String(url).match(/vimeo\.com\/(\d+)/);
    if (v) return "https://player.vimeo.com/video/" + v[1];
    return null;
  }

  function isImageSrc(v) {
    v = String(v || "").trim();
    return isHttpUrl(v) || /^data:image\//i.test(v);
  }

  // Comprime/redimensiona a imagem no navegador e devolve um data URI JPEG
  // pequeno o suficiente para caber numa célula da planilha (limite ~50k chars).
  var IMG_MAX_CHARS = 45000;
  var INFO_FILE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
  function compressImageFile(file, cb) {
    if (!file) { cb(null, "Selecione uma imagem."); return; }
    if (!/^image\//.test(file.type)) { cb(null, "O arquivo precisa ser uma imagem."); return; }
    var reader = new FileReader();
    reader.onerror = function () { cb(null, "Não foi possível ler a imagem."); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { cb(null, "Imagem inválida ou corrompida."); };
      img.onload = function () {
        var dims = [1200, 1000, 800, 640, 480];
        var quals = [0.8, 0.7, 0.6, 0.5, 0.4];
        for (var d = 0; d < dims.length; d++) {
          var scale = Math.min(1, dims[d] / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); // fundo p/ PNG transparente
          ctx.drawImage(img, 0, 0, w, h);
          for (var q = 0; q < quals.length; q++) {
            var dataUrl = canvas.toDataURL("image/jpeg", quals[q]);
            if (dataUrl.length <= IMG_MAX_CHARS) { cb(dataUrl, null); return; }
          }
        }
        cb(null, "Imagem muito grande mesmo após compressão. Use uma imagem menor.");
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function readFileAsBase64(file, cb) {
    if (!file) { cb(null, null, "Selecione um arquivo."); return; }
    if (file.size > INFO_FILE_MAX_BYTES) {
      cb(null, null, "Arquivo muito grande (máx. 20 MB).");
      return;
    }
    var reader = new FileReader();
    reader.onerror = function () { cb(null, null, "Não foi possível ler o arquivo."); };
    reader.onload = function () {
      var dataUrl = String(reader.result || "");
      var parts = dataUrl.split(",");
      cb(parts[1] || "", file.type || "", null);
    };
    reader.readAsDataURL(file);
  }

  function fmtTime(ts) {
    try {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (e) { return ""; }
  }

  function api(payload) {
    var url = getApiUrl();
    if (!url) return Promise.reject({ code: "noapi" });
    if (state.session && state.session.token) {
      payload.sessionToken = state.session.token;
    }
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow"
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res && res.error === "auth" && state.session) {
        clearSession();
        showOverlay(true);
        loginMsg("Sessão expirada. Entre novamente.", "error");
        refreshUI();
      }
      return res;
    });
  }

  // -------------------------------------------------- sessão (somente memória — cada acesso ao link pede login)
  function loadSession() {
    try { localStorage.removeItem("qp_session"); } catch (e) {}
    try { sessionStorage.removeItem("qp_session"); } catch (e) {}
    state.session = null;
    state.accessResolved = false;
  }
  function saveSession(sess) {
    state.session = sess;
    state.accessResolved = true;
  }
  function clearSession() {
    state.session = null;
    state.concluidos = [];
    state.percent = 0;
    state.accessResolved = false;
    state.pendingWeakPassword = null;
  }
  function isAdmin() { return state.session && /admin/i.test(state.session.perfil || ""); }
  function parseBackofficeAccess(val) {
    if (val === true || val === 1) return true;
    if (val === false || val === 0 || val == null) return false;
    if (typeof val === "number") return false;
    var v = String(val).trim().toLowerCase();
    try { v = v.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) {}
    return v === "sim" || v === "s" || v === "yes" || v === "y";
  }
  function isBackofficeProfile() {
    return state.session && /backoffice/i.test(state.session.perfil || "");
  }
  function hasBackofficeAccess() {
    if (!state.session) return false;
    if (isAdmin()) return true;
    if (isBackofficeProfile()) return true;
    if (!state.accessResolved) return false;
    return parseBackofficeAccess(state.session.acessoBackoffice);
  }
  function canAccessTopic(topic) {
    if (topic === BACKOFFICE_TOPIC) return hasBackofficeAccess();
    return true;
  }
  function effectiveTotal() {
    return hasBackofficeAccess() ? TOTAL : TOTAL - 1;
  }
  function effectiveConcluidos() {
    return state.concluidos.filter(function (t) { return canAccessTopic(t); });
  }

  // -------------------------------------------------- overlay de login
  function bindOverlay() {
    var form = document.getElementById("qp-login-form");
    if (!form || form._qpBound) return;
    form._qpBound = true;
    form.addEventListener("submit", onLogin);
  }

  function showOverlay(show) {
    var ov = document.getElementById("qp-login-overlay");
    if (ov) ov.classList.toggle("qp-show", !!show);
    document.body.classList.toggle("qp-portal-locked", !!show);
  }
  function loginMsg(text, type) {
    var el = document.getElementById("qp-login-msg");
    if (!el) return;
    el.className = "qp-login-msg " + (type === "info" ? "qp-info" : "qp-error");
    el.textContent = text;
    if (!text) el.className = "qp-login-msg";
  }

  function passwordRequirementsText() {
    return "Mínimo 8 caracteres, 1 letra maiúscula, 1 número e 1 símbolo.";
  }

  function isStrongPasswordClient(pw) {
    pw = String(pw || "");
    if (pw.length < 8) return false;
    if (!/[A-Z]/.test(pw)) return false;
    if (!/[0-9]/.test(pw)) return false;
    if (!/[^A-Za-z0-9]/.test(pw)) return false;
    return true;
  }

  function ensureWeakPasswordModal() {
    var modal = document.getElementById("qp-weak-pw-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "qp-weak-pw-modal";
    modal.className = "qp-modal";
    modal.innerHTML =
      '<div class="qp-modal-card qp-weak-pw-card">' +
      '  <h3>Atualize sua senha</h3>' +
      '  <p class="qp-hint">Sua senha atual é fraca. Crie uma senha mais segura para continuar usando o portal com segurança.</p>' +
      '  <ul class="qp-pw-rules">' +
      '    <li>Mínimo de 8 caracteres</li>' +
      '    <li>Pelo menos 1 letra maiúscula</li>' +
      '    <li>Pelo menos 1 número</li>' +
      '    <li>Pelo menos 1 símbolo (ex.: ! @ # $)</li>' +
      '  </ul>' +
      '  <label for="qp-weak-pw-new">Nova senha</label>' +
      '  <input id="qp-weak-pw-new" type="password" autocomplete="new-password" placeholder="Digite a nova senha">' +
      '  <label for="qp-weak-pw-confirm">Confirmar nova senha</label>' +
      '  <input id="qp-weak-pw-confirm" type="password" autocomplete="new-password" placeholder="Repita a nova senha">' +
      '  <p class="qp-admin-pw-error" id="qp-weak-pw-error"></p>' +
      '  <div class="qp-modal-actions">' +
      '    <button type="button" class="qp-btn qp-btn-ghost" id="qp-weak-pw-later">Fazer depois</button>' +
      '    <button type="button" class="qp-btn qp-btn-primary" id="qp-weak-pw-save">Salvar nova senha</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.querySelector("#qp-weak-pw-later").addEventListener("click", function () { closeWeakPasswordModal(true); });
    modal.querySelector("#qp-weak-pw-save").addEventListener("click", submitWeakPasswordChange);
    modal.addEventListener("click", function (ev) {
      if (ev.target === modal) closeWeakPasswordModal(true);
    });
    return modal;
  }

  function closeWeakPasswordModal(later) {
    var modal = document.getElementById("qp-weak-pw-modal");
    if (modal) modal.classList.remove("qp-show");
    var err = document.getElementById("qp-weak-pw-error");
    if (err) err.textContent = "";
    var n = document.getElementById("qp-weak-pw-new");
    var c = document.getElementById("qp-weak-pw-confirm");
    if (n) n.value = "";
    if (c) c.value = "";
    if (!later) {
      state.pendingWeakPassword = null;
      if (state.session) state.session.mustChangePassword = false;
    }
    hydrate().then(refreshUI);
  }

  function showWeakPasswordModal(currentPassword) {
    state.pendingWeakPassword = currentPassword || null;
    var modal = ensureWeakPasswordModal();
    var err = document.getElementById("qp-weak-pw-error");
    if (err) err.textContent = "";
    modal.classList.add("qp-show");
    setTimeout(function () {
      var input = document.getElementById("qp-weak-pw-new");
      if (input) input.focus();
    }, 50);
  }

  function submitWeakPasswordChange() {
    if (!state.session || !state.pendingWeakPassword) {
      closeWeakPasswordModal();
      return;
    }
    var nova = document.getElementById("qp-weak-pw-new").value || "";
    var conf = document.getElementById("qp-weak-pw-confirm").value || "";
    var err = document.getElementById("qp-weak-pw-error");
    var btn = document.getElementById("qp-weak-pw-save");

    if (!nova || !conf) {
      err.textContent = "Preencha e confirme a nova senha.";
      return;
    }
    if (nova !== conf) {
      err.textContent = "A confirmação não confere com a nova senha.";
      return;
    }
    if (!isStrongPasswordClient(nova)) {
      err.textContent = passwordRequirementsText();
      return;
    }
    if (nova === state.pendingWeakPassword) {
      err.textContent = "A nova senha deve ser diferente da atual.";
      return;
    }

    btn.disabled = true;
    api({
      action: "changePassword",
      email: state.session.email,
      senhaAtual: state.pendingWeakPassword,
      novaSenha: nova
    })
      .then(function (res) {
        if (res && res.ok) {
          state.pendingWeakPassword = null;
          if (state.session) state.session.mustChangePassword = false;
          var modal = document.getElementById("qp-weak-pw-modal");
          if (modal) modal.classList.remove("qp-show");
          alert("Senha atualizada com sucesso!");
          return hydrate().then(refreshUI);
        }
        if (res && res.error === "senha_atual") {
          err.textContent = "Não foi possível validar a senha atual. Faça login novamente.";
        } else if (res && res.error === "senha_fraca") {
          err.textContent = res.message || passwordRequirementsText();
        } else {
          err.textContent = (res && res.message) || "Não foi possível atualizar a senha.";
        }
      })
      .catch(function () { err.textContent = "Falha de conexão."; })
      .then(function () { btn.disabled = false; });
  }

  function onLogin(ev) {
    ev.preventDefault();
    var email = (document.getElementById("qp-email").value || "").trim();
    var senha = document.getElementById("qp-senha").value || "";
    var btn = document.getElementById("qp-login-btn");
    if (!email || !senha) { loginMsg("Preencha e-mail e senha.", "error"); return; }
    if (!apiConfigured()) {
      loginMsg("Configuração da API pendente. Fale com a gestão / TI.", "error");
      return;
    }
    btn.disabled = true; btn.textContent = "Entrando...";
    loginMsg("", null);
    api({ action: "login", email: email, senha: senha })
      .then(function (res) {
        if (res && res.ok) {
          saveSession({
            nome: res.nome,
            email: res.email || email,
            perfil: res.perfil,
            acessoBackoffice: parseBackofficeAccess(
              res.acessoBackoffice != null ? res.acessoBackoffice : res.acessoAcademia
            ),
            token: res.sessionToken || "",
            mustChangePassword: !!res.weakPassword
          });
          state.accessResolved = true;
          showOverlay(false);
          if (res.weakPassword) {
            showWeakPasswordModal(senha);
            refreshUI();
            return;
          }
          document.getElementById("qp-login-form").reset();
          return hydrate().then(refreshUI);
        }
        if (res && res.error === "bloqueado") {
          var secs = res.retryAfter || 900;
          loginMsg("Muitas tentativas incorretas. Aguarde " + Math.ceil(secs / 60) + " min e tente de novo.", "error");
        } else if (res && res.error === "senha") {
          var msg = "Senha incorreta. Solicite a atualização da sua senha com a gestão.";
          if (res.attemptsLeft != null && res.attemptsLeft <= 2) {
            msg += " Restam " + res.attemptsLeft + " tentativa(s) antes do bloqueio temporário.";
          }
          loginMsg(msg, "error");
        } else if (res && res.error === "usuario") {
          loginMsg("E-mail não encontrado no cadastro. Fale com a gestão.", "error");
        } else if (res && res.error === "conta_bloqueada") {
          loginMsg("Sua conta está bloqueada. Fale com a gestão.", "error");
        } else {
          loginMsg((res && res.message) || "Não foi possível entrar. Tente novamente.", "error");
        }
      })
      .catch(function () {
        loginMsg("Falha de conexão com o servidor. Tente novamente em instantes.", "error");
      })
      .then(function () { btn.disabled = false; btn.textContent = "Entrar"; });
  }

  function logout() {
    if (state.session && state.session.token && apiConfigured()) {
      api({ action: "logout", email: state.session.email }).catch(function () {});
    }
    clearSession();
    refreshUI();
    showOverlay(true);
  }

  // -------------------------------------------------- progresso
  function recompute() {
    var total = effectiveTotal() || 1;
    state.percent = Math.round((effectiveConcluidos().length / total) * 100);
  }
  function hydrate() {
    if (!state.session || !apiConfigured()) {
      recompute();
      return Promise.resolve(false);
    }
    return api({ action: "getState", email: state.session.email })
      .then(function (res) {
        if (res && res.ok) {
          state.concluidos = res.concluidos || [];
          if (res.perfil) state.session.perfil = res.perfil;
          state.session.acessoBackoffice = parseBackofficeAccess(
            res.acessoBackoffice != null ? res.acessoBackoffice : res.acessoAcademia
          );
          state.accessResolved = true;
          recompute();
          return true;
        }
        if (res && res.error === "auth") {
          clearSession();
          showOverlay(true);
          loginMsg("Sessão expirada. Entre novamente.", "error");
          return false;
        }
        clearSession();
        showOverlay(true);
        return false;
      })
      .catch(function () {
        // Sem conexão com a API: mantém sessão local para não bloquear o acesso
        state.accessResolved = true;
        return !!state.session;
      });
  }

  function setProgress(topic, done) {
    if (done && state.concluidos.indexOf(topic) < 0) state.concluidos.push(topic);
    if (!done) state.concluidos = state.concluidos.filter(function (t) { return t !== topic; });
    recompute();
    refreshProgressUI();
    if (state.session && apiConfigured()) {
      api({ action: "setProgress", email: state.session.email, topic: topic, done: done, total: effectiveTotal() })
        .then(function (res) {
          if (res && res.ok && res.concluidos) { state.concluidos = res.concluidos; recompute(); refreshProgressUI(); }
        })
        .catch(function () {});
    }
  }

  function refreshProgressUI() {
    var bar = document.getElementById("qp-home-bar");
    if (bar) bar.style.width = state.percent + "%";
    var lbl = document.getElementById("qp-home-label");
    if (lbl) lbl.textContent = state.percent + "% concluído (" + effectiveConcluidos().length + "/" + effectiveTotal() + " tópicos)";
    var mb = document.getElementById("qp-mini-bar");
    if (mb) mb.style.width = state.percent + "%";
    var ml = document.getElementById("qp-mini-label");
    if (ml) ml.textContent = state.percent + "% concluído";
  }

  // -------------------------------------------------- rota atual
  function currentTopic() {
    var h = (location.hash || "").replace(/^#\/?/, "");
    h = h.split("?")[0].replace(/\/$/, "");
    if (!h || /^readme$/i.test(h)) return "home";
    return h;
  }
  function isTopic(id) { return TOPIC_IDS.indexOf(id) >= 0; }

  // -------------------------------------------------- controle de acesso por tópico
  function applySidebarRestrictions() {
    if (!apiConfigured() || !state.session) return;
    var sidebar = document.querySelector(".sidebar-nav");
    if (!sidebar) return;
    var allowed = hasBackofficeAccess();
    sidebar.querySelectorAll("li").forEach(function (li) {
      var isBackoffice = !!li.querySelector('a[href*="videos"]') ||
        /backoffice/i.test(((li.querySelector("p, strong") || {}).textContent || ""));
      if (isBackoffice) {
        li.style.display = allowed ? "" : "none";
        var parentLi = li.parentElement && li.parentElement.closest("li");
        if (parentLi && /backoffice/i.test(parentLi.textContent || "")) {
          parentLi.style.display = allowed ? "" : "none";
        }
        return;
      }
      var isAdminNav = !!li.querySelector('a[href*="admin-usuarios"]') ||
        !!li.querySelector('a[href*="admin-mila"]') ||
        /administra/i.test(((li.querySelector("p, strong") || {}).textContent || ""));
      if (isAdminNav) {
        li.style.display = isAdmin() ? "" : "none";
        var adminParent = li.parentElement && li.parentElement.closest("li");
        if (adminParent && /administra/i.test(adminParent.textContent || "")) {
          adminParent.style.display = isAdmin() ? "" : "none";
        }
      }
    });
  }

  function ensureSidebarAuth() {
    if (!apiConfigured()) return;
    var sidebar = document.querySelector("aside.sidebar") || document.querySelector(".sidebar");
    if (!sidebar) return;
    var box = document.getElementById("qp-sidebar-auth");
    if (!state.session) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = document.createElement("div");
      box.id = "qp-sidebar-auth";
      sidebar.appendChild(box);
    }
    box.innerHTML =
      '<div class="qp-sidebar-user">' + esc(state.session.nome || state.session.email) + "</div>" +
      '<div class="qp-sidebar-perfil">' + esc(state.session.perfil || "") + "</div>" +
      '<button type="button" class="qp-btn qp-btn-ghost qp-sidebar-logout" id="qp-sidebar-logout">Sair</button>';
    box.querySelector("#qp-sidebar-logout").addEventListener("click", logout);
  }

  function enforceAccess(section) {
    if (!apiConfigured() || !state.session) return false;
    var topic = currentTopic();
    var blocked = document.getElementById("qp-restricted");
    if ((topic === "admin-usuarios" || topic === "admin-mila") && !isAdmin()) {
      section.classList.add("qp-backoffice-blocked");
      Array.from(section.children).forEach(function (el) {
        if (el.id !== "qp-restricted" && el.id !== "qp-topbar" && el.id !== "qp-injected") {
          el.style.display = "none";
          el.setAttribute("data-qp-hidden", "1");
        }
      });
      if (!blocked) {
        blocked = document.createElement("div");
        blocked.id = "qp-restricted";
        blocked.className = "qp-restricted";
        blocked.innerHTML =
          "<h2>🔒 Acesso restrito</h2>" +
          "<p>Esta área é exclusiva para <strong>administradores</strong>.</p>";
        section.insertBefore(blocked, section.firstChild);
      } else {
        blocked.innerHTML =
          "<h2>🔒 Acesso restrito</h2>" +
          "<p>Esta área é exclusiva para <strong>administradores</strong>.</p>";
      }
      blocked.style.display = "";
      return true;
    }
    if (!canAccessTopic(topic)) {
      section.classList.add("qp-backoffice-blocked");
      Array.from(section.children).forEach(function (el) {
        if (el.id !== "qp-restricted" && el.id !== "qp-topbar" && el.id !== "qp-injected") {
          el.style.display = "none";
          el.setAttribute("data-qp-hidden", "1");
        }
      });
      if (!blocked) {
        blocked = document.createElement("div");
        blocked.id = "qp-restricted";
        blocked.className = "qp-restricted";
        blocked.innerHTML =
          "<h2>🔒 Acesso restrito</h2>" +
          "<p>Você não tem permissão para acessar o <strong>Backoffice</strong>.</p>" +
          "<p class=\"qp-hint\">Acesso restrito a perfil <em>Backoffice</em> ou coluna <em>ACESSO BACKOFFICE = SIM</em>.</p>";
        section.insertBefore(blocked, section.firstChild);
      }
      blocked.style.display = "";
      return true;
    }
    section.classList.remove("qp-backoffice-blocked");
    if (blocked) blocked.style.display = "none";
    Array.from(section.children).forEach(function (el) {
      if (el.getAttribute("data-qp-hidden") === "1") {
        el.style.display = "";
        el.removeAttribute("data-qp-hidden");
      }
    });
    return false;
  }

  // -------------------------------------------------- render por página
  function refreshUI() {
    applySidebarRestrictions();
    ensureSidebarAuth();
    refreshProgressUI();
    ensureTopbar();
    ensureWeakPasswordBanner();
    refreshMilaWidget();
    renderPage();
  }

  function ensureWeakPasswordBanner() {
    if (!state.session || !state.session.mustChangePassword || !state.pendingWeakPassword) {
      var old = document.getElementById("qp-weak-pw-banner");
      if (old) old.remove();
      return;
    }
    if (document.getElementById("qp-weak-pw-modal") &&
        document.getElementById("qp-weak-pw-modal").classList.contains("qp-show")) return;
    var banner = document.getElementById("qp-weak-pw-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "qp-weak-pw-banner";
      banner.className = "qp-weak-pw-banner";
      banner.innerHTML =
        '<span>Sua senha precisa ser atualizada para maior segurança.</span>' +
        '<button type="button" class="qp-btn qp-btn-primary" id="qp-weak-pw-banner-btn">Atualizar agora</button>';
      var mount = document.querySelector("main .content") || document.querySelector(".content");
      if (mount) mount.insertBefore(banner, mount.firstChild);
      banner.querySelector("#qp-weak-pw-banner-btn").addEventListener("click", function () {
        showWeakPasswordModal(state.pendingWeakPassword);
      });
    }
  }

  function renderPage() {
    // Portal só age quando a API está configurada; caso contrário o site
    // permanece aberto exatamente como antes (rollout sem quebrar nada).
    if (!apiConfigured()) return;
    var section = document.querySelector(".markdown-section");
    if (!section) return;

    ensureTopbar();

    // remove injeções anteriores
    var old = section.querySelector("#qp-injected");
    if (old) old.parentNode.removeChild(old);

    if (!state.session) return; // overlay cobre a tela

    if (enforceAccess(section)) return;

    var topic = currentTopic();
    var wrap = document.createElement("div");
    wrap.id = "qp-injected";

    if (topic === "admin-usuarios") {
      if (isAdmin()) wrap.appendChild(buildAdminUsersSection());
      section.appendChild(wrap);
      if (isAdmin()) loadAdminUsers();
      return;
    }

    if (topic === "admin-mila") {
      if (isAdmin()) wrap.appendChild(buildAdminMilaSection());
      section.appendChild(wrap);
      if (isAdmin()) loadAdminMila();
      return;
    }

    if (topic === "home") {
      wrap.appendChild(buildInformativosSection());
      section.appendChild(wrap);
      loadInformativos();
      refreshProgressUI();
      return;
    }

    // Bloco "concluído" (só nos tópicos que contam progresso)
    if (isTopic(topic)) wrap.appendChild(buildComplete(topic));

    // Desafio do Dia (quiz)
    if (topic === "desafio") wrap.appendChild(buildDesafioSection());

    // Conteúdo adicional (admin adiciona; todos veem)
    wrap.appendChild(buildContentSection(topic));

    // Comentários (todos os perfis)
    wrap.appendChild(buildCommentsSection(topic));

    section.appendChild(wrap);
    refreshProgressUI();

    if (apiConfigured()) {
      loadContent(topic);
      loadComments(topic);
      if (topic === "desafio") loadDesafio();
    }
  }

  function ensureTopbar() {
    var existing = document.getElementById("qp-topbar");
    if (!state.session) {
      if (existing) existing.classList.remove("qp-show");
      return;
    }
    if (!existing) {
      existing = document.createElement("div");
      existing.id = "qp-topbar";
      existing.innerHTML =
        '<span class="qp-user"></span>' +
        '<span class="qp-badge"></span>' +
        '<div class="qp-mini-progress"><div id="qp-mini-bar"></div></div>' +
        '<span class="qp-mini-label" id="qp-mini-label">0% concluído</span>' +
        '<button class="qp-btn qp-btn-ghost" id="qp-logout">Sair</button>';
      existing.querySelector("#qp-logout").addEventListener("click", logout);
    }
    // Fora do .markdown-section — o Docsify recria o conteúdo e apagava o topbar
    var mount = document.querySelector("main .content") || document.querySelector(".content");
    var article = mount && mount.querySelector(".markdown-section");
    if (mount) {
      if (existing.parentElement !== mount) mount.insertBefore(existing, article || mount.firstChild);
      else if (article && existing.nextElementSibling !== article) mount.insertBefore(existing, article);
    }
    existing.classList.add("qp-show");
    existing.querySelector(".qp-user").textContent = "Olá, " + (state.session.nome || state.session.email);
    var badge = existing.querySelector(".qp-badge");
    badge.textContent = state.session.perfil || "";
    badge.classList.toggle("qp-admin", isAdmin());
    refreshProgressUI();
  }

  // -------- concluído
  function buildComplete(topic) {
    var done = state.concluidos.indexOf(topic) >= 0;
    var box = document.createElement("div");
    box.className = "qp-complete" + (done ? " qp-done" : "");
    var cid = "qp-chk-" + topic;
    box.innerHTML =
      '<input type="checkbox" id="' + cid + '" ' + (done ? "checked" : "") + '>' +
      '<label for="' + cid + '">Marcar este tópico como concluído</label>';
    box.querySelector("input").addEventListener("change", function () {
      setProgress(topic, this.checked);
      box.classList.toggle("qp-done", this.checked);
    });
    return box;
  }

  // -------- conteúdo (admin)
  function buildContentSection(topic) {
    var sec = document.createElement("div");
    sec.className = "qp-section";
    var html = '<h3 class="qp-section-title">Material complementar</h3>' +
               '<div id="qp-content-list"><p class="qp-empty">Carregando…</p></div>';
    if (isAdmin()) {
      html +=
        '<div class="qp-form">' +
        '  <div class="qp-row">' +
        '    <select id="qp-content-tipo">' +
        '      <option value="texto">Texto</option>' +
        '      <option value="video">Vídeo (link YouTube/Vimeo)</option>' +
        '      <option value="imagem">Imagem (anexar arquivo)</option>' +
        '    </select>' +
        '  </div>' +
        '  <textarea id="qp-content-valor" placeholder="Digite o texto, ou cole o link do vídeo"></textarea>' +
        '  <input type="file" id="qp-content-file" accept="image/*" style="display:none">' +
        '  <p class="qp-hint" id="qp-content-hint">Somente administradores podem adicionar material.</p>' +
        '  <button class="qp-btn qp-btn-add" id="qp-content-add">Adicionar material</button>' +
        '</div>';
    }
    sec.innerHTML = html;
    if (isAdmin()) {
      var sel = sec.querySelector("#qp-content-tipo");
      var ta = sec.querySelector("#qp-content-valor");
      var fileInput = sec.querySelector("#qp-content-file");
      var hint = sec.querySelector("#qp-content-hint");
      function syncTipo() {
        var isImg = sel.value === "imagem";
        fileInput.style.display = isImg ? "" : "none";
        ta.style.display = isImg ? "none" : "";
        if (sel.value === "texto") hint.textContent = "Digite o texto do material complementar.";
        else if (sel.value === "video") hint.textContent = "Cole o link do YouTube/Vimeo — o vídeo toca dentro do portal, sem abrir o YouTube.";
        else hint.textContent = "Anexe uma imagem (JPG/PNG). Ela é redimensionada e otimizada automaticamente.";
      }
      sel.addEventListener("change", syncTipo);
      syncTipo();
      sec.querySelector("#qp-content-add").addEventListener("click", function () { addContent(topic); });
    }
    return sec;
  }

  function loadContent(topic) {
    api({ action: "getContent", topic: topic })
      .then(function (res) { renderContent((res && res.blocks) || []); })
      .catch(function () { renderContent([]); });
  }
  function renderContent(blocks) {
    var list = document.getElementById("qp-content-list");
    if (!list) return;
    if (!blocks.length) { list.innerHTML = '<p class="qp-empty">Nenhum material complementar ainda.</p>'; return; }
    list.innerHTML = blocks.map(function (b) {
      var body = "";
      if (b.tipo === "texto") body = "<div>" + esc(b.valor).replace(/\n/g, "<br>") + "</div>";
      else if (b.tipo === "imagem" && isImageSrc(b.valor)) body = '<img src="' + esc(b.valor) + '" alt="material">';
      else if (b.tipo === "video") {
        var emb = ytEmbed(b.valor);
        // Sempre embutido: nunca renderiza link externo, e o overlay (.qp-video-guard)
        // + oncontextmenu bloqueiam clicar no título/logo p/ abrir no YouTube.
        if (emb) body = '<div class="qp-video" oncontextmenu="return false">' +
          '<iframe src="' + esc(emb) + '" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>' +
          '<span class="qp-video-guard" aria-hidden="true"></span>' +
          '</div>';
        else body = '<p class="qp-empty">Vídeo indisponível para exibição segura no portal (use um link do YouTube ou Vimeo).</p>';
      }
      return '<div class="qp-block">' + body +
        '<div class="qp-meta">Adicionado por ' + esc(b.autor || "admin") + " • " + esc(fmtTime(b.ts)) + "</div></div>";
    }).join("");
  }

  function addContent(topic) {
    var tipo = document.getElementById("qp-content-tipo").value;
    var btn = document.getElementById("qp-content-add");

    function send(valor) {
      btn.disabled = true;
      api({ action: "addContent", email: state.session.email, topic: topic, tipo: tipo, valor: valor })
        .then(function (res) {
          if (res && res.ok) {
            var ta = document.getElementById("qp-content-valor"); if (ta) ta.value = "";
            var f = document.getElementById("qp-content-file"); if (f) f.value = "";
            loadContent(topic);
          }
          else if (res && res.error === "perfil") alert("Apenas administradores podem adicionar material.");
          else alert((res && res.message) || "Não foi possível adicionar.");
        })
        .catch(function () { alert("Falha de conexão."); })
        .then(function () { btn.disabled = false; btn.textContent = "Adicionar material"; });
    }

    if (tipo === "imagem") {
      var fileInput = document.getElementById("qp-content-file");
      var file = fileInput && fileInput.files && fileInput.files[0];
      if (!file) { alert("Selecione uma imagem para anexar."); return; }
      btn.disabled = true; btn.textContent = "Processando imagem…";
      compressImageFile(file, function (dataUrl, err) {
        if (err) { btn.disabled = false; btn.textContent = "Adicionar material"; alert(err); return; }
        send(dataUrl);
      });
      return;
    }

    var valor = (document.getElementById("qp-content-valor").value || "").trim();
    if (!valor) return;
    if (tipo === "video" && !isHttpUrl(valor)) {
      alert("Para vídeo, cole uma URL começando com http(s)://");
      return;
    }
    send(valor);
  }

  // -------- comentários (todos)
  function buildCommentsSection(topic) {
    var sec = document.createElement("div");
    sec.className = "qp-section";
    sec.innerHTML =
      '<h3 class="qp-section-title">Comentários e dúvidas</h3>' +
      '<div id="qp-comments-list"><p class="qp-empty">Carregando…</p></div>' +
      '<div class="qp-form">' +
      '  <textarea id="qp-comment-text" placeholder="Escreva um comentário ou dúvida para todos verem..."></textarea>' +
      '  <button class="qp-btn qp-btn-add" id="qp-comment-add">Comentar</button>' +
      '</div>';
    sec.querySelector("#qp-comment-add").addEventListener("click", function () { addComment(topic); });
    return sec;
  }

  function loadComments(topic) {
    api({ action: "getComments", topic: topic })
      .then(function (res) { renderComments((res && res.comments) || []); })
      .catch(function () { renderComments([]); });
  }
  function renderComments(comments) {
    var list = document.getElementById("qp-comments-list");
    if (!list) return;
    if (!comments.length) { list.innerHTML = '<p class="qp-empty">Seja o primeiro a comentar.</p>'; return; }
    list.innerHTML = comments.map(function (c) {
      var admin = /admin/i.test(c.perfil || "");
      return '<div class="qp-comment">' +
        '<div class="qp-c-head">' + esc(c.nome || c.email) +
        '<span class="qp-badge' + (admin ? " qp-admin" : "") + '">' + esc(c.perfil || "") + "</span>" +
        '<span class="qp-c-time">' + esc(fmtTime(c.ts)) + "</span></div>" +
        '<div class="qp-c-body">' + esc(c.texto) + "</div></div>";
    }).join("");
  }

  function addComment(topic) {
    var ta = document.getElementById("qp-comment-text");
    var texto = (ta.value || "").trim();
    if (!texto) return;
    var btn = document.getElementById("qp-comment-add");
    btn.disabled = true;
    api({ action: "addComment", email: state.session.email, topic: topic, texto: texto })
      .then(function (res) { if (res && res.ok) { ta.value = ""; loadComments(topic); } else alert((res && res.message) || "Não foi possível comentar."); })
      .catch(function () { alert("Falha de conexão."); })
      .then(function () { btn.disabled = false; });
  }

  // -------- Informativos (boletim na home)
  function canMarkInformativoRead() {
    return state.session && !isAdmin();
  }

  function buildInformativosSection() {
    var sec = document.createElement("div");
    sec.className = "qp-section qp-informativos";
    var html =
      '<h3 class="qp-section-title">📢 Informativos</h3>' +
      '<p class="qp-hint qp-informativos-intro">Novas regras, atualizações e comunicados da equipe.</p>' +
      '<div id="qp-informativos-list"><p class="qp-empty">Carregando…</p></div>';
    if (isAdmin()) {
      html +=
        '<div class="qp-form qp-informativos-admin">' +
        '  <h4>Publicar novo informativo</h4>' +
        '  <input type="text" id="qp-info-titulo" placeholder="Título do informativo">' +
        '  <textarea id="qp-info-texto" placeholder="Descreva a nova regra ou atualização…" rows="4"></textarea>' +
        '  <div class="qp-row">' +
        '    <label for="qp-info-anexo-tipo">Anexo (opcional)</label>' +
        '    <select id="qp-info-anexo-tipo">' +
        '      <option value="">Nenhum</option>' +
        '      <option value="imagem">Foto (JPG/PNG)</option>' +
        '      <option value="pdf">PDF</option>' +
        '      <option value="video">Vídeo (link ou arquivo)</option>' +
        '    </select>' +
        '  </div>' +
        '  <input type="file" id="qp-info-anexo-file" style="display:none">' +
        '  <input type="text" id="qp-info-anexo-url" placeholder="Cole o link do YouTube ou Vimeo" style="display:none">' +
        '  <p class="qp-hint" id="qp-info-anexo-hint"></p>' +
        '  <button class="qp-btn qp-btn-add" id="qp-info-add">Publicar informativo</button>' +
        '</div>';
    }
    sec.innerHTML = html;
    if (isAdmin()) {
      var sel = sec.querySelector("#qp-info-anexo-tipo");
      var fileInput = sec.querySelector("#qp-info-anexo-file");
      var urlInput = sec.querySelector("#qp-info-anexo-url");
      var hint = sec.querySelector("#qp-info-anexo-hint");
      function syncInfoAnexo() {
        var tipo = sel.value;
        fileInput.style.display = tipo ? "" : "none";
        urlInput.style.display = tipo === "video" ? "" : "none";
        fileInput.value = "";
        urlInput.value = "";
        if (tipo === "imagem") {
          fileInput.accept = "image/*";
          hint.textContent = "Anexe uma foto (JPG/PNG). Ela é redimensionada automaticamente.";
        } else if (tipo === "pdf") {
          fileInput.accept = "application/pdf,.pdf";
          hint.textContent = "Anexe um PDF (até 20 MB).";
        } else if (tipo === "video") {
          fileInput.accept = "video/mp4,video/webm,.mp4,.webm";
          hint.textContent = "Cole um link do YouTube/Vimeo ou anexe um arquivo MP4/WebM (até 20 MB).";
        } else {
          hint.textContent = "";
        }
      }
      sel.addEventListener("change", syncInfoAnexo);
      syncInfoAnexo();
      sec.querySelector("#qp-info-add").addEventListener("click", addInformativo);
    }
    return sec;
  }

  function loadInformativos() {
    api({ action: "getInformativos", email: state.session.email })
      .then(function (res) {
        if (res && res.ok) renderInformativos(res.informativos || []);
        else renderInformativos([], (res && res.message) || "Não foi possível carregar os informativos.");
      })
      .catch(function () { renderInformativos([], "Falha de conexão."); });
  }

  function renderInformativoAnexo(info) {
    var tipo = info.anexoTipo;
    var val = info.anexoValor;
    if (!tipo || !val) return "";
    var nome = info.anexoNome || "anexo";
    var body = "";

    if (tipo === "imagem" && isImageSrc(val)) {
      body = '<img src="' + esc(val) + '" alt="' + esc(nome) + '">';
    } else if (tipo === "pdf") {
      body =
        '<iframe src="' + esc(val) + '" loading="lazy" title="' + esc(nome) + '"></iframe>' +
        '<a class="qp-info-anexo-link" href="' + esc(val) + '" target="_blank" rel="noopener">Abrir PDF em nova aba</a>';
    } else if (tipo === "video") {
      var emb = ytEmbed(val);
      if (emb) {
        body =
          '<div class="qp-video" oncontextmenu="return false">' +
          '<iframe src="' + esc(emb) + '" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>' +
          '<span class="qp-video-guard" aria-hidden="true"></span>' +
          "</div>";
      } else if (/drive\.google\.com/i.test(val)) {
        body = '<iframe src="' + esc(val) + '" loading="lazy" title="' + esc(nome) + '"></iframe>';
      } else {
        body = '<p class="qp-empty">Vídeo indisponível para exibição no portal.</p>';
      }
    }

    if (!body) return "";
    return '<div class="qp-info-anexo qp-info-anexo-' + esc(tipo) + '">' +
      '<div class="qp-info-anexo-label">📎 ' + esc(nome) + "</div>" +
      body + "</div>";
  }

  function renderInformativoComments(info) {
    var comments = info.comentarios || [];
    var html = '<div class="qp-info-comments">';
    if (!comments.length) {
      html += '<p class="qp-empty qp-info-comments-empty">Nenhum comentário ainda.</p>';
    } else {
      html += comments.map(function (c) {
        var admin = /admin/i.test(c.perfil || "");
        return '<div class="qp-comment qp-info-comment">' +
          '<div class="qp-c-head">' + esc(c.nome || c.email) +
          '<span class="qp-badge' + (admin ? " qp-admin" : "") + '">' + esc(c.perfil || "") + "</span>" +
          '<span class="qp-c-time">' + esc(fmtTime(c.ts)) + "</span></div>" +
          '<div class="qp-c-body">' + esc(c.texto) + "</div></div>";
      }).join("");
    }
    html +=
      '<div class="qp-form qp-info-comment-form">' +
      '  <textarea class="qp-info-comment-text" data-info-id="' + esc(info.id) + '" placeholder="Deixe um comentário ou dúvida sobre este informativo…"></textarea>' +
      '  <button type="button" class="qp-btn qp-btn-add qp-info-comment-add" data-info-id="' + esc(info.id) + '">Comentar</button>' +
      "</div></div>";
    return html;
  }

  function renderInformativoLeituras(info) {
    var leituras = info.leituras || [];
    if (!leituras.length) {
      return '<p class="qp-info-leituras-empty">Ninguém confirmou a leitura ainda.</p>';
    }
    return '<ul class="qp-info-leituras-list">' + leituras.map(function (l) {
      return "<li><strong>" + esc(l.nome || l.email) + "</strong>" +
        ' <span class="qp-badge">' + esc(l.perfil || "") + "</span>" +
        ' <span class="qp-c-time">' + esc(fmtTime(l.ts)) + "</span></li>";
    }).join("") + "</ul>";
  }

  function renderInformativos(items, errMsg) {
    var list = document.getElementById("qp-informativos-list");
    if (!list) return;
    if (errMsg) { list.innerHTML = '<p class="qp-empty">' + esc(errMsg) + "</p>"; return; }
    if (!items.length) {
      list.innerHTML = '<p class="qp-empty">Nenhum informativo publicado ainda.</p>';
      return;
    }

    list.innerHTML = items.map(function (info) {
      var readBlock = "";
      if (canMarkInformativoRead()) {
        if (info.lido) {
          readBlock = '<div class="qp-info-read qp-info-read-done">✓ Você confirmou que leu este informativo</div>';
        } else {
          readBlock = '<button type="button" class="qp-btn qp-btn-primary qp-info-read-btn" data-info-id="' + esc(info.id) + '">Li e estou ciente</button>';
        }
      }

      var adminBlock = "";
      if (isAdmin()) {
        adminBlock =
          '<div class="qp-info-leituras">' +
          '  <h5>Confirmações de leitura (' + esc(String(info.totalLeituras || 0)) + ")</h5>" +
          renderInformativoLeituras(info) +
          "</div>";
      } else if (info.totalLeituras > 0) {
        adminBlock = '<p class="qp-info-read-count">' + esc(String(info.totalLeituras)) + " pessoa(s) já confirmaram a leitura.</p>";
      }

      return '<article class="qp-informativo" data-info-id="' + esc(info.id) + '">' +
        '<header class="qp-info-head">' +
        '  <h4>' + esc(info.titulo || "Informativo") + "</h4>" +
        '  <div class="qp-meta">Publicado por ' + esc(info.autor || "admin") + " • " + esc(fmtTime(info.criadoEm)) + "</div>" +
        "</header>" +
        '<div class="qp-info-body">' + esc(info.texto || "").replace(/\n/g, "<br>") + "</div>" +
        renderInformativoAnexo(info) +
        readBlock +
        adminBlock +
        renderInformativoComments(info) +
        "</article>";
    }).join("");

    list.querySelectorAll(".qp-info-read-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        markInformativoRead(btn.getAttribute("data-info-id"), btn);
      });
    });
    list.querySelectorAll(".qp-info-comment-add").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var infoId = btn.getAttribute("data-info-id");
        var ta = list.querySelector('.qp-info-comment-text[data-info-id="' + infoId + '"]');
        addInformativoComment(infoId, ta, btn);
      });
    });
  }

  function addInformativo() {
    var titulo = (document.getElementById("qp-info-titulo").value || "").trim();
    var texto = (document.getElementById("qp-info-texto").value || "").trim();
    if (!titulo || !texto) { alert("Preencha título e texto do informativo."); return; }

    var anexoTipo = (document.getElementById("qp-info-anexo-tipo").value || "").trim();
    var fileInput = document.getElementById("qp-info-anexo-file");
    var urlInput = document.getElementById("qp-info-anexo-url");
    var file = fileInput && fileInput.files && fileInput.files[0];
    var videoUrl = (urlInput && urlInput.value || "").trim();
    var btn = document.getElementById("qp-info-add");

    function resetForm() {
      document.getElementById("qp-info-titulo").value = "";
      document.getElementById("qp-info-texto").value = "";
      document.getElementById("qp-info-anexo-tipo").value = "";
      if (fileInput) fileInput.value = "";
      if (urlInput) urlInput.value = "";
      document.getElementById("qp-info-anexo-tipo").dispatchEvent(new Event("change"));
    }

    function publish(payload) {
      btn.disabled = true;
      btn.textContent = "Publicando…";
      api(payload)
        .then(function (res) {
          if (res && res.ok) {
            resetForm();
            loadInformativos();
          } else alert((res && res.message) || "Não foi possível publicar.");
        })
        .catch(function () { alert("Falha de conexão."); })
        .then(function () { btn.disabled = false; btn.textContent = "Publicar informativo"; });
    }

    var basePayload = {
      action: "addInformativo",
      email: state.session.email,
      titulo: titulo,
      texto: texto,
      anexoTipo: anexoTipo || ""
    };

    if (!anexoTipo) {
      publish(basePayload);
      return;
    }

    if (anexoTipo === "imagem") {
      if (!file) { alert("Selecione uma foto para anexar."); return; }
      btn.disabled = true;
      btn.textContent = "Processando imagem…";
      compressImageFile(file, function (dataUrl, err) {
        if (err) { btn.disabled = false; btn.textContent = "Publicar informativo"; alert(err); return; }
        publish(Object.assign({}, basePayload, {
          anexoValor: dataUrl,
          anexoNome: file.name || "foto.jpg"
        }));
      });
      return;
    }

    if (anexoTipo === "pdf") {
      if (!file) { alert("Selecione um PDF para anexar."); return; }
      btn.disabled = true;
      btn.textContent = "Enviando PDF…";
      readFileAsBase64(file, function (b64, mime, err) {
        if (err) { btn.disabled = false; btn.textContent = "Publicar informativo"; alert(err); return; }
        publish(Object.assign({}, basePayload, {
          anexoBase64: b64,
          anexoMime: mime || "application/pdf",
          anexoNome: file.name || "documento.pdf"
        }));
      });
      return;
    }

    if (anexoTipo === "video") {
      if (file) {
        btn.disabled = true;
        btn.textContent = "Enviando vídeo…";
        readFileAsBase64(file, function (b64, mime, err) {
          if (err) { btn.disabled = false; btn.textContent = "Publicar informativo"; alert(err); return; }
          publish(Object.assign({}, basePayload, {
            anexoBase64: b64,
            anexoMime: mime || "video/mp4",
            anexoNome: file.name || "video.mp4"
          }));
        });
        return;
      }
      if (!videoUrl) { alert("Cole um link de vídeo ou anexe um arquivo MP4/WebM."); return; }
      if (!isHttpUrl(videoUrl)) { alert("Use uma URL começando com http(s)://"); return; }
      publish(Object.assign({}, basePayload, {
        anexoValor: videoUrl,
        anexoNome: "vídeo"
      }));
      return;
    }

    alert("Tipo de anexo inválido.");
  }

  function markInformativoRead(infoId, btn) {
    if (!infoId) return;
    btn.disabled = true;
    api({ action: "markInformativoRead", email: state.session.email, informativoId: infoId })
      .then(function (res) {
        if (res && res.ok) loadInformativos();
        else alert((res && res.message) || "Não foi possível registrar a leitura.");
      })
      .catch(function () { alert("Falha de conexão."); })
      .then(function () { if (btn) btn.disabled = false; });
  }

  function addInformativoComment(infoId, ta, btn) {
    var texto = (ta && ta.value || "").trim();
    if (!texto) return;
    btn.disabled = true;
    api({ action: "addInformativoComment", email: state.session.email, informativoId: infoId, texto: texto })
      .then(function (res) {
        if (res && res.ok) {
          ta.value = "";
          loadInformativos();
        } else alert((res && res.message) || "Não foi possível comentar.");
      })
      .catch(function () { alert("Falha de conexão."); })
      .then(function () { btn.disabled = false; });
  }

  // -------- Desafio do Dia (quiz)
  function buildDesafioSection() {
    var sec = document.createElement("div");
    sec.className = "qp-section qp-desafio";
    var html =
      '<h3 class="qp-section-title">🎯 Desafio do Dia</h3>' +
      '<div id="qp-desafio-root"><p class="qp-empty">Carregando perguntas…</p></div>';
    if (isAdmin()) {
      html +=
        '<div class="qp-form qp-desafio-admin">' +
        '  <h4>Nova pergunta (múltipla escolha)</h4>' +
        '  <textarea id="qp-desafio-pergunta" placeholder="Digite a pergunta do desafio…" rows="3"></textarea>' +
        '  <div class="qp-desafio-opcoes">' +
        '    <label>A) <input id="qp-desafio-a" type="text" placeholder="Opção A"></label>' +
        '    <label>B) <input id="qp-desafio-b" type="text" placeholder="Opção B"></label>' +
        '    <label>C) <input id="qp-desafio-c" type="text" placeholder="Opção C (opcional)"></label>' +
        '    <label>D) <input id="qp-desafio-d" type="text" placeholder="Opção D (opcional)"></label>' +
        '  </div>' +
        '  <div class="qp-row">' +
        '    <label for="qp-desafio-correta">Resposta correta</label>' +
        '    <select id="qp-desafio-correta"><option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="D">D</option></select>' +
        '    <label class="qp-check"><input id="qp-desafio-ativo" type="checkbox" checked> Ativa (visível para atendentes)</label>' +
        '  </div>' +
        '  <button class="qp-btn qp-btn-add" id="qp-desafio-add">Publicar pergunta</button>' +
        '</div>';
    }
    sec.innerHTML = html;
    return sec;
  }

  function latestDesafioMap(respostas) {
    var map = {};
    (respostas || []).forEach(function (r) {
      if (!map[r.questaoId] || String(r.ts) > String(map[r.questaoId].ts)) map[r.questaoId] = r;
    });
    return map;
  }

  function loadDesafio() {
    api({ action: "getDesafio", email: state.session.email })
      .then(function (res) {
        if (res && res.ok) renderDesafio(res.perguntas || [], res.respostas || []);
        else renderDesafio([], []);
      })
      .catch(function () { renderDesafio([], []); });
    var btn = document.getElementById("qp-desafio-add");
    if (btn && !btn._qpBound) {
      btn._qpBound = true;
      btn.addEventListener("click", addDesafioPergunta);
    }
  }

  function renderDesafio(perguntas, respostas) {
    var root = document.getElementById("qp-desafio-root");
    if (!root) return;
    var latest = latestDesafioMap(respostas);
    var visiveis = isAdmin() ? perguntas : perguntas.filter(function (q) { return q.ativo; });

    if (!visiveis.length) {
      root.innerHTML = '<p class="qp-empty">' +
        (isAdmin() ? "Nenhuma pergunta cadastrada. Use o formulário abaixo para criar." : "Nenhum desafio disponível no momento. Volte em breve!") +
        "</p>";
      return;
    }

    root.innerHTML = visiveis.map(function (q) {
      return renderDesafioPergunta(q, latest[q.id]);
    }).join("");

    root.querySelectorAll("[data-desafio-submit]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        submitDesafioResposta(btn.getAttribute("data-qid"), btn.closest(".qp-quiz"));
      });
    });
  }

  function renderDesafioPergunta(q, ultima) {
    var letras = ["A", "B", "C", "D"];
    var html = '<div class="qp-quiz" data-qid="' + esc(q.id) + '">';
    html += '<p class="qp-quiz-q">' + esc(q.pergunta) + "</p>";

    if (isAdmin()) {
      html += '<p class="qp-hint">Correta: <strong>' + esc(q.correta || "?") + "</strong>" +
        (q.ativo ? "" : " • <em>Inativa</em>") + "</p>";
    }

    if (ultima && ultima.acertou) {
      html += '<div class="qp-quiz-result qp-quiz-ok">✅ Parabéns! Você acertou.</div>';
      return html + "</div>";
    }

    if (ultima && !ultima.acertou) {
      html += '<div class="qp-quiz-result qp-quiz-err">❌ Resposta incorreta. Você escolheu <strong>' +
        esc(ultima.escolha) + "</strong>. Tente novamente!</div>";
    }

    html += '<div class="qp-quiz-opcoes">';
    letras.forEach(function (L) {
      var txt = (q.opcoes && q.opcoes[L]) || "";
      if (!txt) return;
      html += '<label class="qp-quiz-opt"><input type="radio" name="desafio-' + esc(q.id) +
        '" value="' + L + '"><span class="qp-quiz-letter">' + L + ")</span> " + esc(txt) + "</label>";
    });
    html += "</div>";
    html += '<button type="button" class="qp-btn qp-btn-primary qp-quiz-btn" data-desafio-submit data-qid="' +
      esc(q.id) + '">Enviar resposta</button>';
    return html + "</div>";
  }

  function submitDesafioResposta(questaoId, box) {
    if (!box) return;
    var picked = box.querySelector('input[name="desafio-' + questaoId + '"]:checked');
    if (!picked) { alert("Selecione uma opção antes de enviar."); return; }
    var btn = box.querySelector(".qp-quiz-btn");
    if (btn) btn.disabled = true;
    api({
      action: "submitDesafioResposta",
      email: state.session.email,
      questaoId: questaoId,
      escolha: picked.value
    })
      .then(function (res) {
        if (res && res.ok) loadDesafio();
        else alert((res && res.message) || "Não foi possível enviar.");
      })
      .catch(function () { alert("Falha de conexão."); })
      .then(function () { if (btn) btn.disabled = false; });
  }

  function addDesafioPergunta() {
    var pergunta = (document.getElementById("qp-desafio-pergunta").value || "").trim();
    var opcoes = {
      A: (document.getElementById("qp-desafio-a").value || "").trim(),
      B: (document.getElementById("qp-desafio-b").value || "").trim(),
      C: (document.getElementById("qp-desafio-c").value || "").trim(),
      D: (document.getElementById("qp-desafio-d").value || "").trim()
    };
    var correta = document.getElementById("qp-desafio-correta").value;
    var ativo = document.getElementById("qp-desafio-ativo").checked;
    if (!pergunta) { alert("Digite a pergunta."); return; }
    var btn = document.getElementById("qp-desafio-add");
    btn.disabled = true;
    api({
      action: "addDesafioPergunta",
      email: state.session.email,
      pergunta: pergunta,
      opcoes: opcoes,
      correta: correta,
      ativo: ativo
    })
      .then(function (res) {
        if (res && res.ok) {
          document.getElementById("qp-desafio-pergunta").value = "";
          document.getElementById("qp-desafio-a").value = "";
          document.getElementById("qp-desafio-b").value = "";
          document.getElementById("qp-desafio-c").value = "";
          document.getElementById("qp-desafio-d").value = "";
          loadDesafio();
        } else if (res && res.error === "perfil") alert("Apenas administradores podem criar perguntas.");
        else alert((res && res.message) || "Não foi possível publicar.");
      })
      .catch(function () { alert("Falha de conexão."); })
      .then(function () { btn.disabled = false; });
  }

  // -------- administração de atendentes
  function ensureAdminPasswordModal() {
    var modal = document.getElementById("qp-admin-pw-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "qp-admin-pw-modal";
    modal.className = "qp-modal";
    modal.innerHTML =
      '<div class="qp-modal-card">' +
      '  <h3 id="qp-admin-pw-title">Confirmar alteração</h3>' +
      '  <p class="qp-hint" id="qp-admin-pw-desc">Digite sua senha de administrador para continuar.</p>' +
      '  <label for="qp-admin-pw-input">Sua senha</label>' +
      '  <input id="qp-admin-pw-input" type="password" autocomplete="current-password" placeholder="Senha do administrador">' +
      '  <p class="qp-admin-pw-error" id="qp-admin-pw-error"></p>' +
      '  <div class="qp-modal-actions">' +
      '    <button type="button" class="qp-btn qp-btn-ghost" id="qp-admin-pw-cancel">Cancelar</button>' +
      '    <button type="button" class="qp-btn qp-btn-primary" id="qp-admin-pw-confirm">Confirmar</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.querySelector("#qp-admin-pw-cancel").addEventListener("click", closeAdminPasswordModal);
    modal.addEventListener("click", function (ev) {
      if (ev.target === modal) closeAdminPasswordModal();
    });
    return modal;
  }

  var adminPwCallback = null;

  function closeAdminPasswordModal() {
    var modal = document.getElementById("qp-admin-pw-modal");
    if (modal) modal.classList.remove("qp-show");
    adminPwCallback = null;
    var input = document.getElementById("qp-admin-pw-input");
    if (input) input.value = "";
    var err = document.getElementById("qp-admin-pw-error");
    if (err) err.textContent = "";
  }

  function withAdminPassword(title, description, onConfirm) {
    var modal = ensureAdminPasswordModal();
    document.getElementById("qp-admin-pw-title").textContent = title || "Confirmar alteração";
    document.getElementById("qp-admin-pw-desc").textContent = description || "Digite sua senha de administrador para continuar.";
    var input = document.getElementById("qp-admin-pw-input");
    var err = document.getElementById("qp-admin-pw-error");
    var btn = document.getElementById("qp-admin-pw-confirm");
    err.textContent = "";
    input.value = "";
    adminPwCallback = onConfirm;
    modal.classList.add("qp-show");
    setTimeout(function () { input.focus(); }, 50);

    function submit() {
      var senha = input.value || "";
      if (!senha) { err.textContent = "Informe sua senha."; return; }
      btn.disabled = true;
      onConfirm(senha, function (ok, message) {
        btn.disabled = false;
        if (ok) closeAdminPasswordModal();
        else err.textContent = message || "Senha incorreta.";
      });
    }

    btn.onclick = submit;
    input.onkeydown = function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); submit(); }
      if (ev.key === "Escape") closeAdminPasswordModal();
    };
  }

  function adminApi(action, extra, adminSenha) {
    var payload = { action: action, email: state.session.email, adminSenha: adminSenha };
    Object.keys(extra || {}).forEach(function (k) { payload[k] = extra[k]; });
    return api(payload);
  }

  function adminActionError(res) {
    if (res && res.error === "senha_admin") return "Senha de administrador incorreta.";
    if (res && res.error === "perfil") return "Apenas administradores podem fazer isso.";
    return (res && res.message) || "Não foi possível concluir a operação.";
  }

  function buildAdminUsersSection() {
    var sec = document.createElement("div");
    sec.className = "qp-section qp-admin-users";
    sec.innerHTML =
      '<h3 class="qp-section-title">Gerenciar atendentes</h3>' +
      '<p class="qp-hint">Cadastre, edite, bloqueie ou remova usuários. Toda alteração pede sua senha de administrador.</p>' +
      '<div id="qp-users-list"><p class="qp-empty">Carregando usuários…</p></div>' +
      '<div class="qp-form qp-admin-user-form">' +
      '  <h4 id="qp-user-form-title">Novo atendente</h4>' +
      '  <input type="hidden" id="qp-user-edit-email" value="">' +
      '  <label for="qp-user-nome">Nome completo</label>' +
      '  <input id="qp-user-nome" type="text" placeholder="Nome do atendente">' +
      '  <label for="qp-user-email">E-mail</label>' +
      '  <input id="qp-user-email" type="email" placeholder="email@empresa.com">' +
      '  <label for="qp-user-senha">Senha inicial</label>' +
      '  <input id="qp-user-senha" type="password" placeholder="Mín. 8 caracteres, 1 maiúscula, 1 número, 1 símbolo">' +
      '  <div class="qp-row">' +
      '    <label for="qp-user-perfil">Perfil</label>' +
      '    <select id="qp-user-perfil"><option value="Atendente">Atendente</option><option value="Backoffice">Backoffice</option><option value="Administrador">Administrador</option></select>' +
      '    <label class="qp-check"><input id="qp-user-backoffice" type="checkbox"> Acesso Backoffice</label>' +
      '    <label class="qp-check"><input id="qp-user-bloqueado" type="checkbox"> Bloquear acesso</label>' +
      '  </div>' +
      '  <div class="qp-row">' +
      '    <button type="button" class="qp-btn qp-btn-primary" id="qp-user-save">Cadastrar atendente</button>' +
      '    <button type="button" class="qp-btn qp-btn-ghost" id="qp-user-cancel-edit" style="display:none">Cancelar edição</button>' +
      '  </div>' +
      '</div>';
    sec.querySelector("#qp-user-save").addEventListener("click", saveAdminUser);
    sec.querySelector("#qp-user-cancel-edit").addEventListener("click", resetAdminUserForm);
    return sec;
  }

  function resetAdminUserForm() {
    document.getElementById("qp-user-edit-email").value = "";
    document.getElementById("qp-user-nome").value = "";
    document.getElementById("qp-user-email").value = "";
    document.getElementById("qp-user-senha").value = "";
    document.getElementById("qp-user-perfil").value = "Atendente";
    document.getElementById("qp-user-backoffice").checked = false;
    document.getElementById("qp-user-bloqueado").checked = false;
    document.getElementById("qp-user-email").disabled = false;
    document.getElementById("qp-user-form-title").textContent = "Novo atendente";
    document.getElementById("qp-user-save").textContent = "Cadastrar atendente";
    document.getElementById("qp-user-cancel-edit").style.display = "none";
    var senhaLbl = document.querySelector('label[for="qp-user-senha"]');
    if (senhaLbl) senhaLbl.textContent = "Senha inicial";
    document.getElementById("qp-user-senha").placeholder = "Mín. 8 caracteres, 1 maiúscula, 1 número, 1 símbolo";
  }

  function fillAdminUserForm(user) {
    document.getElementById("qp-user-edit-email").value = user.email;
    document.getElementById("qp-user-nome").value = user.nome || "";
    document.getElementById("qp-user-email").value = user.email || "";
    document.getElementById("qp-user-email").disabled = true;
    document.getElementById("qp-user-senha").value = "";
    document.getElementById("qp-user-perfil").value = /admin/i.test(user.perfil || "")
      ? "Administrador"
      : /backoffice/i.test(user.perfil || "") ? "Backoffice" : "Atendente";
    document.getElementById("qp-user-backoffice").checked = !!user.acessoBackoffice;
    document.getElementById("qp-user-bloqueado").checked = !!user.bloqueado;
    document.getElementById("qp-user-form-title").textContent = "Editar: " + (user.nome || user.email);
    document.getElementById("qp-user-save").textContent = "Salvar alterações";
    document.getElementById("qp-user-cancel-edit").style.display = "";
    var senhaLbl = document.querySelector('label[for="qp-user-senha"]');
    if (senhaLbl) senhaLbl.textContent = "Nova senha (opcional)";
    document.getElementById("qp-user-senha").placeholder = "Deixe em branco para manter a atual";
  }

  function loadAdminUsers() {
    api({ action: "listUsers", email: state.session.email })
      .then(function (res) {
        if (res && res.ok) renderAdminUsers(res.users || []);
        else renderAdminUsers([], adminActionError(res));
      })
      .catch(function () { renderAdminUsers([], "Falha de conexão."); });
  }

  function renderAdminUsers(users, errMsg) {
    var list = document.getElementById("qp-users-list");
    if (!list) return;
    if (errMsg) { list.innerHTML = '<p class="qp-empty">' + esc(errMsg) + "</p>"; return; }
    if (!users.length) { list.innerHTML = '<p class="qp-empty">Nenhum usuário cadastrado.</p>'; return; }

    var selfEmail = (state.session.email || "").toLowerCase();
    list.innerHTML =
      '<div class="qp-users-table-wrap"><table class="qp-users-table">' +
      "<thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Backoffice</th><th>Status</th><th>Progresso</th><th>Ações</th></tr></thead><tbody>" +
      users.map(function (u) {
        var isSelf = (u.email || "").toLowerCase() === selfEmail;
        var status = u.bloqueado
          ? '<span class="qp-user-status qp-user-blocked">Bloqueado</span>'
          : '<span class="qp-user-status qp-user-active">Ativo</span>';
        var actions =
          '<button type="button" class="qp-btn qp-btn-ghost qp-user-edit" data-email="' + esc(u.email) + '">Editar</button>';
        if (!isSelf) {
          actions += ' <button type="button" class="qp-btn qp-btn-danger qp-user-delete" data-email="' + esc(u.email) + '" data-nome="' + esc(u.nome || u.email) + '">Excluir</button>';
        }
        return "<tr>" +
          "<td>" + esc(u.nome || "—") + "</td>" +
          "<td>" + esc(u.email) + "</td>" +
          "<td>" + esc(u.perfil || "Atendente") + "</td>" +
          "<td>" + (u.acessoBackoffice ? "Sim" : "Não") + "</td>" +
          "<td>" + status + "</td>" +
          "<td>" + esc(u.andamento || "0%") + "</td>" +
          "<td class=\"qp-users-actions\">" + actions + "</td>" +
          "</tr>";
      }).join("") +
      "</tbody></table></div>";

    list.querySelectorAll(".qp-user-edit").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var email = btn.getAttribute("data-email");
        var user = users.filter(function (u) { return u.email === email; })[0];
        if (user) fillAdminUserForm(user);
      });
    });
    list.querySelectorAll(".qp-user-delete").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var email = btn.getAttribute("data-email");
        var nome = btn.getAttribute("data-nome");
        deleteAdminUser(email, nome);
      });
    });
  }

  function saveAdminUser() {
    var editEmail = (document.getElementById("qp-user-edit-email").value || "").trim();
    var nome = (document.getElementById("qp-user-nome").value || "").trim();
    var email = (document.getElementById("qp-user-email").value || "").trim();
    var senha = document.getElementById("qp-user-senha").value || "";
    var perfil = document.getElementById("qp-user-perfil").value;
    var acessoBackoffice = document.getElementById("qp-user-backoffice").checked;
    var bloqueado = document.getElementById("qp-user-bloqueado").checked;

    if (!nome || !email) { alert("Preencha nome e e-mail."); return; }

    if (editEmail) {
      withAdminPassword("Salvar alterações", "Confirme sua senha para atualizar " + nome + ".", function (adminSenha, done) {
        var changes = { nome: nome, perfil: perfil, acessoBackoffice: acessoBackoffice, bloqueado: bloqueado };
        if (senha) changes.senha = senha;
        adminApi("updateUser", { targetEmail: editEmail, changes: changes }, adminSenha)
          .then(function (res) {
            if (res && res.ok) {
              resetAdminUserForm();
              loadAdminUsers();
              done(true);
            } else done(false, adminActionError(res));
          })
          .catch(function () { done(false, "Falha de conexão."); });
      });
      return;
    }

    if (!senha) { alert("Informe uma senha inicial para o novo atendente."); return; }

    withAdminPassword("Cadastrar atendente", "Confirme sua senha para criar o usuário " + nome + ".", function (adminSenha, done) {
      adminApi("createUser", {
        user: { nome: nome, email: email, senha: senha, perfil: perfil, acessoBackoffice: acessoBackoffice, bloqueado: bloqueado }
      }, adminSenha)
        .then(function (res) {
          if (res && res.ok) {
            resetAdminUserForm();
            loadAdminUsers();
            done(true);
          } else done(false, adminActionError(res));
        })
        .catch(function () { done(false, "Falha de conexão."); });
    });
  }

  function deleteAdminUser(email, nome) {
    if (!confirm("Excluir permanentemente o usuário \"" + nome + "\"?")) return;
    withAdminPassword("Excluir usuário", "Confirme sua senha para excluir " + nome + ".", function (adminSenha, done) {
      adminApi("deleteUser", { targetEmail: email }, adminSenha)
        .then(function (res) {
          if (res && res.ok) {
            loadAdminUsers();
            done(true);
          } else done(false, adminActionError(res));
        })
        .catch(function () { done(false, "Falha de conexão."); });
    });
  }

  // -------- Mila — atendente virtual (chat)
  function ensureMilaChat() {
    if (document.getElementById("qp-mila-chat")) return;
    var panel = document.createElement("div");
    panel.id = "qp-mila-chat";
    panel.className = "qp-mila-chat";
    panel.setAttribute("aria-hidden", "true");
    panel.innerHTML =
      '<div class="qp-mila-chat-header">' +
      '  <img src="assets/mila.png" alt="Mila">' +
      '  <div class="qp-mila-chat-title">' +
      '    <strong>Mila</strong>' +
      '    <span>Agente de Treinamento</span>' +
      '  </div>' +
      '  <button type="button" class="qp-mila-chat-close" id="qp-mila-close" aria-label="Fechar">×</button>' +
      '</div>' +
      '<div class="qp-mila-messages" id="qp-mila-messages"></div>' +
      '<div class="qp-mila-input-row">' +
      '  <textarea id="qp-mila-input" rows="2" placeholder="Digite sua dúvida…"></textarea>' +
      '  <button type="button" class="qp-btn qp-btn-primary" id="qp-mila-send">Enviar</button>' +
      '</div>';
    document.body.appendChild(panel);

    panel.querySelector("#qp-mila-close").addEventListener("click", closeMilaChat);
    panel.querySelector("#qp-mila-send").addEventListener("click", function () { sendMilaQuestion(); });
    panel.querySelector("#qp-mila-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMilaQuestion(); }
    });

    var floatBtn = document.getElementById("mila-float");
    if (floatBtn) {
      floatBtn.addEventListener("click", function () {
        if (!apiConfigured() || !state.session) return;
        if (milaChatOpen) closeMilaChat();
        else openMilaChat();
      });
    }
  }

  function refreshMilaWidget() {
    ensureMilaChat();
    var floatBtn = document.getElementById("mila-float");
    var panel = document.getElementById("qp-mila-chat");
    var active = apiConfigured() && !!state.session;
    if (floatBtn) floatBtn.style.display = active ? "" : "none";
    if (!active) {
      closeMilaChat();
      milaGreeted = false;
      if (panel) {
        var msgs = panel.querySelector("#qp-mila-messages");
        if (msgs) msgs.innerHTML = "";
      }
    }
  }

  function openMilaChat() {
    ensureMilaChat();
    if (!state.session) return;
    var panel = document.getElementById("qp-mila-chat");
    if (!panel) return;
    milaChatOpen = true;
    panel.classList.add("qp-open");
    panel.setAttribute("aria-hidden", "false");
    var floatBtn = document.getElementById("mila-float");
    if (floatBtn) floatBtn.classList.add("qp-mila-open");
    if (!milaGreeted) {
      milaGreeted = true;
      appendMilaMessage("mila",
        "Olá" + (state.session.nome ? ", " + state.session.nome.split(" ")[0] : "") +
        "! Eu sou a Mila 👋\n\nSou sua agente de treinamento virtual. Pergunte sobre procedimentos, regras ou o portal que eu te ajudo com base na nossa base de conhecimento!");
    }
    var input = document.getElementById("qp-mila-input");
    if (input) input.focus();
  }

  function closeMilaChat() {
    milaChatOpen = false;
    var panel = document.getElementById("qp-mila-chat");
    if (panel) {
      panel.classList.remove("qp-open");
      panel.setAttribute("aria-hidden", "true");
    }
    var floatBtn = document.getElementById("mila-float");
    if (floatBtn) floatBtn.classList.remove("qp-mila-open");
  }

  function appendMilaMessage(role, text, extras) {
    var box = document.getElementById("qp-mila-messages");
    if (!box) return;
    var el = document.createElement("div");
    el.className = "qp-mila-msg qp-mila-msg-" + (role === "user" ? "user" : "mila");
    var body = '<div class="qp-mila-msg-body">' + esc(text).replace(/\n/g, "<br>") + "</div>";
    if (extras && extras.sugestoes && extras.sugestoes.length) {
      body += '<div class="qp-mila-sugestoes">' + extras.sugestoes.map(function (s) {
        return '<button type="button" class="qp-mila-sugestao" data-q="' + esc(s) + '">' + esc(s) + "</button>";
      }).join("") + "</div>";
    }
    el.innerHTML = body;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    el.querySelectorAll(".qp-mila-sugestao").forEach(function (btn) {
      btn.addEventListener("click", function () {
        sendMilaQuestion(btn.getAttribute("data-q"));
      });
    });
  }

  function sendMilaQuestion(prefill) {
    if (!state.session) return;
    var input = document.getElementById("qp-mila-input");
    var btn = document.getElementById("qp-mila-send");
    var pergunta = String(prefill != null ? prefill : (input && input.value || "")).trim();
    if (!pergunta) return;

    if (input && prefill == null) input.value = "";
    appendMilaMessage("user", pergunta);
    if (btn) btn.disabled = true;

    var typing = document.createElement("div");
    typing.className = "qp-mila-msg qp-mila-msg-mila qp-mila-typing";
    typing.innerHTML = '<div class="qp-mila-msg-body">Mila está digitando…</div>';
    var box = document.getElementById("qp-mila-messages");
    if (box) { box.appendChild(typing); box.scrollTop = box.scrollHeight; }

    api({ action: "askMila", email: state.session.email, pergunta: pergunta })
      .then(function (res) {
        if (typing.parentNode) typing.parentNode.removeChild(typing);
        if (res && res.ok) {
          appendMilaMessage("mila", res.resposta || "Não consegui responder agora.", {
            sugestoes: res.semMatch ? (res.sugestoes || []) : []
          });
        } else {
          appendMilaMessage("mila", (res && res.message) || "Não consegui consultar a base agora. Tente novamente em instantes.");
        }
      })
      .catch(function () {
        if (typing.parentNode) typing.parentNode.removeChild(typing);
        appendMilaMessage("mila", "Falha de conexão. Verifique sua internet e tente de novo.");
      })
      .then(function () { if (btn) btn.disabled = false; });
  }

  function buildAdminMilaSection() {
    var sec = document.createElement("div");
    sec.className = "qp-section qp-admin-mila";
    sec.innerHTML =
      '<h3 class="qp-section-title">Base de conhecimento da Mila</h3>' +
      '<p class="qp-hint">Cadastre perguntas e respostas que a Mila usa para responder automaticamente no chat. Use <strong>palavras-chave</strong> (separadas por vírgula) para melhorar o reconhecimento.</p>' +
      '<div id="qp-mila-faq-list"><p class="qp-empty">Carregando…</p></div>' +
      '<div class="qp-form qp-mila-faq-form">' +
      '  <h4 id="qp-mila-faq-form-title">Nova pergunta</h4>' +
      '  <input type="hidden" id="qp-mila-faq-edit-id" value="">' +
      '  <label for="qp-mila-faq-pergunta">Pergunta (como o atendente pode perguntar)</label>' +
      '  <input id="qp-mila-faq-pergunta" type="text" placeholder="Ex.: Como funciona o reembolso por PIX?">' +
      '  <label for="qp-mila-faq-resposta">Resposta da Mila</label>' +
      '  <textarea id="qp-mila-faq-resposta" rows="4" placeholder="Texto que a Mila vai responder…"></textarea>' +
      '  <label for="qp-mila-faq-chaves">Palavras-chave (opcional)</label>' +
      '  <input id="qp-mila-faq-chaves" type="text" placeholder="pix, reembolso, estorno, devolução">' +
      '  <label class="qp-check"><input id="qp-mila-faq-ativo" type="checkbox" checked> Ativa (visível para a Mila)</label>' +
      '  <div class="qp-row">' +
      '    <button type="button" class="qp-btn qp-btn-primary" id="qp-mila-faq-save">Salvar pergunta</button>' +
      '    <button type="button" class="qp-btn qp-btn-ghost" id="qp-mila-faq-cancel" style="display:none">Cancelar edição</button>' +
      '  </div>' +
      '</div>';
    sec.querySelector("#qp-mila-faq-save").addEventListener("click", saveAdminMilaFaq);
    sec.querySelector("#qp-mila-faq-cancel").addEventListener("click", resetAdminMilaForm);
    return sec;
  }

  function resetAdminMilaForm() {
    document.getElementById("qp-mila-faq-edit-id").value = "";
    document.getElementById("qp-mila-faq-pergunta").value = "";
    document.getElementById("qp-mila-faq-resposta").value = "";
    document.getElementById("qp-mila-faq-chaves").value = "";
    document.getElementById("qp-mila-faq-ativo").checked = true;
    document.getElementById("qp-mila-faq-form-title").textContent = "Nova pergunta";
    document.getElementById("qp-mila-faq-save").textContent = "Salvar pergunta";
    document.getElementById("qp-mila-faq-cancel").style.display = "none";
  }

  function fillAdminMilaForm(item) {
    document.getElementById("qp-mila-faq-edit-id").value = item.id;
    document.getElementById("qp-mila-faq-pergunta").value = item.pergunta || "";
    document.getElementById("qp-mila-faq-resposta").value = item.resposta || "";
    document.getElementById("qp-mila-faq-chaves").value = item.palavrasChave || "";
    document.getElementById("qp-mila-faq-ativo").checked = !!item.ativo;
    document.getElementById("qp-mila-faq-form-title").textContent = "Editar pergunta";
    document.getElementById("qp-mila-faq-save").textContent = "Salvar alterações";
    document.getElementById("qp-mila-faq-cancel").style.display = "";
  }

  function loadAdminMila() {
    api({ action: "getMilaFaq", email: state.session.email })
      .then(function (res) {
        if (res && res.ok) renderAdminMila(res.faq || []);
        else renderAdminMila([], adminActionError(res));
      })
      .catch(function () { renderAdminMila([], "Falha de conexão."); });
  }

  function renderAdminMila(items, errMsg) {
    var list = document.getElementById("qp-mila-faq-list");
    if (!list) return;
    if (errMsg) { list.innerHTML = '<p class="qp-empty">' + esc(errMsg) + "</p>"; return; }
    if (!items.length) { list.innerHTML = '<p class="qp-empty">Nenhuma pergunta cadastrada. A Mila ainda não tem base de conhecimento.</p>'; return; }

    list.innerHTML =
      '<div class="qp-mila-faq-table-wrap"><table class="qp-users-table qp-mila-faq-table">' +
      "<thead><tr><th>Pergunta</th><th>Palavras-chave</th><th>Status</th><th>Ações</th></tr></thead><tbody>" +
      items.map(function (item) {
        var status = item.ativo
          ? '<span class="qp-user-status qp-user-active">Ativa</span>'
          : '<span class="qp-user-status qp-user-blocked">Inativa</span>';
        return "<tr>" +
          "<td>" + esc(item.pergunta) + "</td>" +
          "<td>" + esc(item.palavrasChave || "—") + "</td>" +
          "<td>" + status + "</td>" +
          '<td class="qp-users-actions">' +
          '<button type="button" class="qp-btn qp-btn-ghost qp-mila-faq-edit" data-id="' + esc(item.id) + '">Editar</button> ' +
          '<button type="button" class="qp-btn qp-btn-danger qp-mila-faq-delete" data-id="' + esc(item.id) + '">Excluir</button>' +
          "</td></tr>";
      }).join("") +
      "</tbody></table></div>";

    list.querySelectorAll(".qp-mila-faq-edit").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        var item = items.filter(function (f) { return f.id === id; })[0];
        if (item) fillAdminMilaForm(item);
      });
    });
    list.querySelectorAll(".qp-mila-faq-delete").forEach(function (btn) {
      btn.addEventListener("click", function () {
        deleteAdminMilaFaq(btn.getAttribute("data-id"));
      });
    });
  }

  function saveAdminMilaFaq() {
    var editId = (document.getElementById("qp-mila-faq-edit-id").value || "").trim();
    var pergunta = (document.getElementById("qp-mila-faq-pergunta").value || "").trim();
    var resposta = (document.getElementById("qp-mila-faq-resposta").value || "").trim();
    var palavrasChave = (document.getElementById("qp-mila-faq-chaves").value || "").trim();
    var ativo = document.getElementById("qp-mila-faq-ativo").checked;
    if (!pergunta || !resposta) { alert("Preencha pergunta e resposta."); return; }

    var btn = document.getElementById("qp-mila-faq-save");
    btn.disabled = true;
    var payload = editId
      ? { action: "updateMilaFaq", email: state.session.email, id: editId, changes: { pergunta: pergunta, resposta: resposta, palavrasChave: palavrasChave, ativo: ativo } }
      : { action: "addMilaFaq", email: state.session.email, pergunta: pergunta, resposta: resposta, palavrasChave: palavrasChave, ativo: ativo };

    api(payload)
      .then(function (res) {
        if (res && res.ok) {
          resetAdminMilaForm();
          loadAdminMila();
        } else alert(adminActionError(res));
      })
      .catch(function () { alert("Falha de conexão."); })
      .then(function () { btn.disabled = false; });
  }

  function deleteAdminMilaFaq(id) {
    if (!id || !confirm("Excluir esta pergunta da base da Mila?")) return;
    api({ action: "deleteMilaFaq", email: state.session.email, id: id })
      .then(function (res) {
        if (res && res.ok) loadAdminMila();
        else alert(adminActionError(res));
      })
      .catch(function () { alert("Falha de conexão."); });
  }

  // -------------------------------------------------- plugin Docsify
  function plugin(hook) {
    hook.doneEach(function () { ensureTopbar(); ensureSidebarAuth(); renderPage(); applySidebarRestrictions(); });
    hook.ready(function () {
      window.addEventListener("hashchange", function () {
        applySidebarRestrictions();
        ensureSidebarAuth();
        renderPage();
      });
    });
  }
  window.$docsify = window.$docsify || {};
  window.$docsify.plugins = (window.$docsify.plugins || []).concat(plugin);

  // -------------------------------------------------- init
  function init() {
    if (typeof console !== "undefined" && console.info) {
      console.info("[QP Portal] versão " + APP_VERSION);
    }
    if (!apiConfigured()) {
      showOverlay(false);
      return;
    }
    bindOverlay();
    ensureMilaChat();
    loadSession();
    showOverlay(true);
    refreshUI();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.QPApp = { logout: logout, state: state };
})();
