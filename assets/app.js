/* =========================================================================
 * Portal de Treinamento Quero Passagem
 * Login por planilha (via Apps Script), perfis, progresso e comentários.
 * ========================================================================= */
(function () {
  "use strict";

  // Tópicos que contam para a barra de progresso (rota -> título)
  var TOPICS = [
    { id: "onboarding", titulo: "Onboarding" },
    { id: "atendimento", titulo: "Atendimento" },
    { id: "metodo3d", titulo: "Método 3D" },
    { id: "prazos", titulo: "Financeiro / Prazos" },
    { id: "antt", titulo: "ANTT" },
    { id: "cms", titulo: "CMS" },
    { id: "videos", titulo: "Academia / Treinamentos" }
  ];
  var TOPIC_IDS = TOPICS.map(function (t) { return t.id; });
  var TOTAL = TOPICS.length;
  var ACADEMIA_TOPIC = "videos";
  var SESSION_VERSION = 1;

  var state = {
    session: null,        // { nome, email, perfil, acessoAcademia }
    concluidos: [],       // ["onboarding", ...]
    percent: 0,
    accessResolved: false // true após login/hydrate confirmarem acesso na API
  };

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
    var m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{6,})/);
    if (m) return "https://www.youtube.com/embed/" + m[1];
    var v = String(url).match(/vimeo\.com\/(\d+)/);
    if (v) return "https://player.vimeo.com/video/" + v[1];
    return null;
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
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow"
    }).then(function (r) { return r.json(); });
  }

  // -------------------------------------------------- sessão
  function loadSession() {
    try {
      var raw = localStorage.getItem("qp_session");
      state.session = raw ? JSON.parse(raw) : null;
    } catch (e) { state.session = null; }
    if (state.session && state.session._v !== SESSION_VERSION) {
      state.session = null;
      try { localStorage.removeItem("qp_session"); } catch (e) {}
    }
    state.accessResolved = false;
    if (state.session) delete state.session.acessoAcademia;
  }
  function saveSession(s) {
    state.session = s;
    if (state.session) state.session._v = SESSION_VERSION;
    try { localStorage.setItem("qp_session", JSON.stringify(s)); } catch (e) {}
  }
  function clearSession() {
    state.session = null;
    state.concluidos = [];
    state.percent = 0;
    state.accessResolved = false;
    try { localStorage.removeItem("qp_session"); } catch (e) {}
  }
  function isAdmin() { return state.session && /admin/i.test(state.session.perfil || ""); }
  function parseAcademiaAccess(val) {
    if (val === true || val === 1) return true;
    if (val === false || val === 0 || val == null) return false;
    if (typeof val === "number") return false;
    var v = String(val).trim().toLowerCase();
    try { v = v.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) {}
    return v === "sim" || v === "s" || v === "yes" || v === "y";
  }
  function hasAcademiaAccess() {
    if (!state.session) return false;
    if (isAdmin()) return true;
    if (!state.accessResolved) return false;
    return parseAcademiaAccess(state.session.acessoAcademia);
  }
  function canAccessTopic(topic) {
    if (topic === ACADEMIA_TOPIC) return hasAcademiaAccess();
    return true;
  }
  function effectiveTotal() {
    return hasAcademiaAccess() ? TOTAL : TOTAL - 1;
  }
  function effectiveConcluidos() {
    return state.concluidos.filter(function (t) { return canAccessTopic(t); });
  }

  // -------------------------------------------------- overlay de login
  function buildOverlay() {
    if (document.getElementById("qp-login-overlay")) return;
    var ov = document.createElement("div");
    ov.id = "qp-login-overlay";
    ov.innerHTML =
      '<form class="qp-login-card" id="qp-login-form" autocomplete="on">' +
      '  <h2>Treinamento Quero Passagem</h2>' +
      '  <p class="qp-sub">Entre em contato com a gestão para atualizar a senha.</p>' +
      '  <label for="qp-email">E-mail</label>' +
      '  <input id="qp-email" name="email" type="email" required placeholder="seu.email@empresa.com">' +
      '  <label for="qp-senha">Senha</label>' +
      '  <input id="qp-senha" name="password" type="password" required placeholder="Sua senha">' +
      '  <button class="qp-btn qp-btn-primary" type="submit" id="qp-login-btn">Entrar</button>' +
      '  <div class="qp-login-msg" id="qp-login-msg"></div>' +
      '</form>';
    document.body.appendChild(ov);
    document.getElementById("qp-login-form").addEventListener("submit", onLogin);
  }

  function showOverlay(show) {
    var ov = document.getElementById("qp-login-overlay");
    if (ov) ov.classList.toggle("qp-show", !!show);
  }
  function loginMsg(text, type) {
    var el = document.getElementById("qp-login-msg");
    if (!el) return;
    el.className = "qp-login-msg " + (type === "info" ? "qp-info" : "qp-error");
    el.textContent = text;
    if (!text) el.className = "qp-login-msg";
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
            acessoAcademia: parseAcademiaAccess(res.acessoAcademia)
          });
          state.accessResolved = true;
          showOverlay(false);
          document.getElementById("qp-login-form").reset();
          return hydrate().then(refreshUI);
        }
        if (res && res.error === "senha") {
          loginMsg("Senha incorreta. Solicite a atualização da sua senha com a gestão.", "error");
        } else if (res && res.error === "usuario") {
          loginMsg("E-mail não encontrado no cadastro. Fale com a gestão.", "error");
        } else {
          loginMsg((res && res.message) || "Não foi possível entrar. Tente novamente.", "error");
        }
      })
      .catch(function () {
        loginMsg("Falha de conexão com o servidor. Tente novamente em instantes.", "error");
      })
      .then(function () { btn.disabled = false; btn.textContent = "Entrar"; });
  }

  function logout() { clearSession(); refreshUI(); showOverlay(true); }

  // -------------------------------------------------- progresso
  function recompute() {
    var total = effectiveTotal() || 1;
    state.percent = Math.round((effectiveConcluidos().length / total) * 100);
  }
  function hydrate() {
    if (!state.session || !apiConfigured()) { recompute(); return Promise.resolve(); }
    return api({ action: "getState", email: state.session.email })
      .then(function (res) {
        if (res && res.ok) {
          state.concluidos = res.concluidos || [];
          if (res.perfil) state.session.perfil = res.perfil;
          state.session.acessoAcademia = parseAcademiaAccess(res.acessoAcademia);
          state.accessResolved = true;
          try { localStorage.setItem("qp_session", JSON.stringify(state.session)); } catch (e) {}
          recompute();
        }
      })
      .catch(function () {});
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
    var allowed = hasAcademiaAccess();
    sidebar.querySelectorAll("li").forEach(function (li) {
      var isAcademia = !!li.querySelector('a[href*="videos"]') ||
        /academia/i.test(((li.querySelector("p, strong") || {}).textContent || ""));
      if (!isAcademia) return;
      li.style.display = allowed ? "" : "none";
      var parentLi = li.parentElement && li.parentElement.closest("li");
      if (parentLi && /academia/i.test(parentLi.textContent || "")) {
        parentLi.style.display = allowed ? "" : "none";
      }
    });
  }

  function enforceAccess(section) {
    if (!apiConfigured() || !state.session) return false;
    var topic = currentTopic();
    var blocked = document.getElementById("qp-restricted");
    if (!canAccessTopic(topic)) {
      section.classList.add("qp-academia-blocked");
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
          "<p>Você não tem permissão para acessar a <strong>Academia</strong>.</p>" +
          "<p class=\"qp-hint\">Solicite liberação com a gestão (coluna <em>ACESSO ACADEMIA = SIM</em> na planilha).</p>";
        section.insertBefore(blocked, section.firstChild);
      }
      blocked.style.display = "";
      return true;
    }
    section.classList.remove("qp-academia-blocked");
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
  function refreshUI() { applySidebarRestrictions(); refreshProgressUI(); renderPage(); }

  function renderPage() {
    // Portal só age quando a API está configurada; caso contrário o site
    // permanece aberto exatamente como antes (rollout sem quebrar nada).
    if (!apiConfigured()) return;
    var section = document.querySelector(".markdown-section");
    if (!section) return;

    // topbar sempre no topo do conteúdo quando logado
    ensureTopbar(section);

    // remove injeções anteriores
    var old = section.querySelector("#qp-injected");
    if (old) old.parentNode.removeChild(old);

    if (!state.session) return; // overlay cobre a tela

    if (enforceAccess(section)) return;

    var topic = currentTopic();
    var wrap = document.createElement("div");
    wrap.id = "qp-injected";

    if (topic === "home") {
      section.appendChild(wrap);
      refreshProgressUI();
      return;
    }

    // Bloco "concluído" (só nos tópicos que contam progresso)
    if (isTopic(topic)) wrap.appendChild(buildComplete(topic));

    // Conteúdo adicional (admin adiciona; todos veem)
    wrap.appendChild(buildContentSection(topic));

    // Comentários (todos os perfis)
    wrap.appendChild(buildCommentsSection(topic));

    section.appendChild(wrap);
    refreshProgressUI();

    if (apiConfigured()) { loadContent(topic); loadComments(topic); }
  }

  function ensureTopbar(section) {
    var existing = document.getElementById("qp-topbar");
    if (!state.session) { if (existing) existing.classList.remove("qp-show"); return; }
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
    // sempre garantir que fica no topo do conteúdo atual
    if (section.firstChild !== existing) section.insertBefore(existing, section.firstChild);
    existing.classList.add("qp-show");
    existing.querySelector(".qp-user").textContent = "Olá, " + (state.session.nome || state.session.email);
    var badge = existing.querySelector(".qp-badge");
    badge.textContent = state.session.perfil || "";
    badge.classList.toggle("qp-admin", isAdmin());
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
        '      <option value="imagem">Imagem (URL)</option>' +
        '    </select>' +
        '  </div>' +
        '  <textarea id="qp-content-valor" placeholder="Digite o texto, ou cole o link do vídeo/imagem"></textarea>' +
        '  <p class="qp-hint">Somente administradores podem adicionar material. Vídeos e imagens são adicionados por link/URL.</p>' +
        '  <button class="qp-btn qp-btn-add" id="qp-content-add">Adicionar material</button>' +
        '</div>';
    }
    sec.innerHTML = html;
    if (isAdmin()) {
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
      else if (b.tipo === "imagem" && isHttpUrl(b.valor)) body = '<img src="' + esc(b.valor) + '" alt="material">';
      else if (b.tipo === "video") {
        var emb = ytEmbed(b.valor);
        if (emb) body = '<div class="qp-video"><iframe src="' + esc(emb) + '" allowfullscreen loading="lazy"></iframe></div>';
        else if (isHttpUrl(b.valor)) body = '<a href="' + esc(b.valor) + '" target="_blank" rel="noopener">Assistir vídeo</a>';
      }
      return '<div class="qp-block">' + body +
        '<div class="qp-meta">Adicionado por ' + esc(b.autor || "admin") + " • " + esc(fmtTime(b.ts)) + "</div></div>";
    }).join("");
  }

  function addContent(topic) {
    var tipo = document.getElementById("qp-content-tipo").value;
    var valor = (document.getElementById("qp-content-valor").value || "").trim();
    if (!valor) return;
    if ((tipo === "imagem" || tipo === "video") && !isHttpUrl(valor)) {
      alert("Para imagem/vídeo, cole uma URL começando com http(s)://");
      return;
    }
    var btn = document.getElementById("qp-content-add");
    btn.disabled = true;
    api({ action: "addContent", email: state.session.email, topic: topic, tipo: tipo, valor: valor })
      .then(function (res) {
        if (res && res.ok) { document.getElementById("qp-content-valor").value = ""; loadContent(topic); }
        else if (res && res.error === "perfil") alert("Apenas administradores podem adicionar material.");
        else alert((res && res.message) || "Não foi possível adicionar.");
      })
      .catch(function () { alert("Falha de conexão."); })
      .then(function () { btn.disabled = false; });
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

  // -------------------------------------------------- plugin Docsify
  function plugin(hook) {
    hook.doneEach(function () { renderPage(); applySidebarRestrictions(); });
    hook.ready(function () {
      window.addEventListener("hashchange", function () {
        applySidebarRestrictions();
        renderPage();
      });
    });
  }
  window.$docsify = window.$docsify || {};
  window.$docsify.plugins = (window.$docsify.plugins || []).concat(plugin);

  // -------------------------------------------------- init
  function init() {
    // Sem API configurada => portal inativo e site aberto como hoje.
    if (!apiConfigured()) return;
    buildOverlay();
    loadSession();
    if (state.session) {
      hydrate().then(refreshUI);
      showOverlay(false);
    } else {
      refreshUI();
      showOverlay(true);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.QPApp = { logout: logout, state: state };
})();
