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

  var state = {
    session: null,        // { nome, email, perfil, acessoAcademia }
    concluidos: [],       // ["onboarding", ...]
    percent: 0
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
  }
  function saveSession(s) {
    state.session = s;
    try { localStorage.setItem("qp_session", JSON.stringify(s)); } catch (e) {}
  }
  function clearSession() {
    state.session = null;
    state.concluidos = [];
    state.percent = 0;
    try { localStorage.removeItem("qp_session"); } catch (e) {}
  }
  function isAdmin() { return state.session && /admin/i.test(state.session.perfil || ""); }
  function hasAcademiaAccess() { return !state.session || state.session.acessoAcademia !== false; }
  function canAccessTopic(topic) { return topic !== "videos" || hasAcademiaAccess(); }
  function availableTopics() { return TOPICS.filter(function (t) { return canAccessTopic(t.id); }); }
  function availableTopicIds() { return availableTopics().map(function (t) { return t.id; }); }
  function isTrackableTopic(id) { return availableTopicIds().indexOf(id) >= 0; }

  // -------------------------------------------------- overlay de login
  function buildOverlay() {
    if (document.getElementById("qp-login-overlay")) return;
    var ov = document.createElement("div");
    ov.id = "qp-login-overlay";
    ov.innerHTML =
      '<form class="qp-login-card" id="qp-login-form" autocomplete="on">' +
      '  <h2>Treinamento Quero Passagem</h2>' +
      '  <p class="qp-sub">Entre com o e-mail e a senha cadastrados pela gestão.</p>' +
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
            acessoAcademia: res.acessoAcademia
          });
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
    var ids = availableTopicIds();
    var total = ids.length;
    var concluidos = state.concluidos.filter(function (topic) { return ids.indexOf(topic) >= 0; }).length;
    state.percent = total ? Math.round((concluidos / total) * 100) : 0;
  }
  function hydrate() {
    if (!state.session || !apiConfigured()) { recompute(); return Promise.resolve(); }
    return api({ action: "getState", email: state.session.email })
      .then(function (res) {
        if (res && res.ok) {
          state.concluidos = res.concluidos || [];
          if (res.perfil) state.session.perfil = res.perfil;
          if (typeof res.acessoAcademia === "boolean") state.session.acessoAcademia = res.acessoAcademia;
          recompute();
        }
      })
      .catch(function () {});
  }

  function setProgress(topic, done) {
    if (!isTrackableTopic(topic)) return;
    if (done && state.concluidos.indexOf(topic) < 0) state.concluidos.push(topic);
    if (!done) state.concluidos = state.concluidos.filter(function (t) { return t !== topic; });
    recompute();
    refreshProgressUI();
    if (state.session && apiConfigured()) {
      api({ action: "setProgress", email: state.session.email, topic: topic, done: done, total: availableTopicIds().length })
        .then(function (res) {
          if (res && res.ok && res.concluidos) { state.concluidos = res.concluidos; recompute(); refreshProgressUI(); }
        })
        .catch(function () {});
    }
  }

  function refreshProgressUI() {
    var total = availableTopicIds().length;
    var concluidos = state.concluidos.filter(function (topic) { return isTrackableTopic(topic); }).length;
    var bar = document.getElementById("qp-home-bar");
    if (bar) bar.style.width = state.percent + "%";
    var lbl = document.getElementById("qp-home-label");
    if (lbl) lbl.textContent = state.percent + "% concluído (" + concluidos + "/" + total + " tópicos)";
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
  function isAcademiaHref(href) {
    var h = String(href || "").trim().toLowerCase();
    return /#\/videos(?:$|[/?#])/.test(h) || /videos\.md(?:$|[?#])/.test(h);
  }
  function onBlockedAcademiaClick(ev) {
    ev.preventDefault();
    alert("Você não tem acesso ao tópico Academia. Solicite liberação à gestão.");
  }
  function refreshSidebarTopicAccess() {
    var links = document.querySelectorAll("a[href]");
    var blocked = state.session && !hasAcademiaAccess();
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      if (!isAcademiaHref(link.getAttribute("href"))) continue;
      if (blocked) {
        link.classList.add("qp-link-disabled");
        link.setAttribute("aria-disabled", "true");
        if (!link.dataset.qpAcademiaBlocked) {
          link.addEventListener("click", onBlockedAcademiaClick);
          link.dataset.qpAcademiaBlocked = "1";
        }
      } else {
        link.classList.remove("qp-link-disabled");
        link.removeAttribute("aria-disabled");
        if (link.dataset.qpAcademiaBlocked) {
          link.removeEventListener("click", onBlockedAcademiaClick);
          delete link.dataset.qpAcademiaBlocked;
        }
      }
    }
  }

  // -------------------------------------------------- render por página
  function refreshUI() { refreshProgressUI(); renderPage(); }

  function renderPage() {
    // Portal só age quando a API está configurada; caso contrário o site
    // permanece aberto exatamente como antes (rollout sem quebrar nada).
    if (!apiConfigured()) return;
    var section = document.querySelector(".markdown-section");
    if (!section) return;
    refreshSidebarTopicAccess();

    // topbar sempre no topo do conteúdo quando logado
    ensureTopbar(section);

    // remove injeções anteriores
    var old = section.querySelector("#qp-injected");
    if (old) old.parentNode.removeChild(old);

    if (!state.session) return; // overlay cobre a tela

    var topic = currentTopic();
    var wrap = document.createElement("div");
    wrap.id = "qp-injected";

    if (topic === "home") {
      section.appendChild(wrap);
      refreshProgressUI();
      return;
    }

    if (!canAccessTopic(topic)) {
      wrap.appendChild(buildTopicBlocked(topic));
      section.appendChild(wrap);
      return;
    }

    // Bloco "concluído" (só nos tópicos que contam progresso)
    if (isTrackableTopic(topic)) wrap.appendChild(buildComplete(topic));

    // Conteúdo adicional (admin adiciona; todos veem)
    wrap.appendChild(buildContentSection(topic));

    // Comentários (todos os perfis)
    wrap.appendChild(buildCommentsSection(topic));

    section.appendChild(wrap);
    refreshProgressUI();

    if (apiConfigured()) { loadContent(topic); loadComments(topic); }
  }

  function buildTopicBlocked(topic) {
    var topicInfo = TOPICS.find(function (t) { return t.id === topic; });
    var topicName = topicInfo ? topicInfo.titulo : topic;
    var sec = document.createElement("div");
    sec.className = "qp-section";
    sec.innerHTML =
      '<h3 class="qp-section-title">Acesso restrito</h3>' +
      '<p>Este tópico é liberado somente para usuários autorizados.</p>' +
      '<p>Se você precisa acessar <strong>' + esc(topicName) + '</strong>, fale com a gestão para marcar "SIM" na coluna de acesso da Academia na planilha.</p>';
    return sec;
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
    api({ action: "getContent", topic: topic, email: state.session && state.session.email })
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
    api({ action: "getComments", topic: topic, email: state.session && state.session.email })
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
    hook.doneEach(function () { renderPage(); });
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
