/* X09 AI — chat app */
(() => {
  "use strict";

  // ---------- X09 shared physics + account kit (public/x09/) ----------
  X09Space.start({ density: 0.85, opacity: 0.8 });
  X09.init({ site: "ai" });

  // ---------- Elements ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    sidebar: $("sidebar"), scrim: $("scrim"), threads: $("threads"), search: $("search"),
    chat: $("chat"), messages: $("messages"), title: $("threadTitle"),
    form: $("composer"), input: $("input"), send: $("send"), statusText: $("statusText"),
    accountBtn: $("accountBtn"), accountMenu: $("accountMenu"),
    authModal: $("authModal"), authForm: $("authForm"), authEmail: $("authEmail"), authPassword: $("authPassword"),
    authError: $("authError"), authSubmit: $("authSubmit"), authTitle: $("authTitle"),
    plansModal: $("plansModal"), plansList: $("plansList"), toast: $("toast"),
  };

  // ---------- State ----------
  let user = null;            // from /api/me
  let plans = [];             // from /api/plans
  let threads = [];           // [{id, title, updated}]
  let currentId = null;
  let messages = [];          // messages of the open thread [{role, content, at}]
  let mode = "fast";
  let controller = null;
  let authTab = "login";

  const hasPlan = () => !!(user && user.plan);
  const session = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} },
  };

  // ---------- API ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: opts.body ? { "content-type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.status = res.status; err.code = data?.code;
      throw err;
    }
    return data;
  }

  function toast(msg, ms = 3200) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => els.toast.classList.remove("show"), ms);
  }

  // ---------- Modals ----------
  function openModal(m) { m.hidden = false; requestAnimationFrame(() => m.classList.add("open")); }
  function closeModal(m) { m.classList.remove("open"); setTimeout(() => (m.hidden = true), 200); }
  document.querySelectorAll(".modal").forEach((m) => {
    m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) closeModal(m); });
  });

  function showAuth(tab = "login") {
    setAuthTab(tab);
    els.authError.textContent = "";
    openModal(els.authModal);
    setTimeout(() => els.authEmail.focus(), 60);
  }
  function setAuthTab(tab) {
    authTab = tab;
    document.querySelectorAll(".tabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    els.authTitle.textContent = tab === "login" ? "Sign in to X09" : "Create your account";
    els.authSubmit.textContent = tab === "login" ? "Sign in" : "Create account";
    els.authPassword.autocomplete = tab === "login" ? "current-password" : "new-password";
    els.authError.textContent = "";
  }
  document.querySelectorAll(".tabs [data-tab]").forEach((b) => b.addEventListener("click", () => setAuthTab(b.dataset.tab)));

  els.authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = els.authEmail.value.trim();
    const password = els.authPassword.value;
    if (!email || !password) { els.authError.textContent = "Enter your email and password."; return; }
    if (authTab === "signup" && password.length < 8) { els.authError.textContent = "Password must be at least 8 characters."; return; }
    els.authSubmit.disabled = true;
    els.authError.textContent = "";
    try {
      const data = await api(authTab === "login" ? "/api/auth/login" : "/api/auth/signup", { method: "POST", body: { email, password } });
      X09.setUser(data.user);
      els.authPassword.value = "";
      closeModal(els.authModal);
      renderAccount();
      if (hasPlan()) { await loadThreads(); toast("Welcome back, commander."); }
      else showPlans();
    } catch (err) {
      els.authError.textContent = err.message;
    } finally {
      els.authSubmit.disabled = false;
    }
  });

  function fmtNum(n) { return Number(n).toLocaleString(); }

  function renderPlans() {
    els.plansList.innerHTML = "";
    for (const p of plans) {
      const current = user && user.plan === p.key;
      const card = document.createElement("div");
      card.className = "plan" + (p.featured ? " featured" : "") + (current ? " current" : "");
      card.innerHTML = `
        ${p.featured ? '<span class="badge mono">Most popular</span>' : ""}
        <div class="plan-name mono">${p.name}</div>
        <div class="plan-price">${p.price}<span>/${p.interval === "month" ? "mo" : p.interval}</span></div>
        <p class="plan-blurb">${p.blurb}</p>
        <ul>
          <li><b>${fmtNum(p.fast)}</b> Fast messages / mo</li>
          <li><b>${fmtNum(p.deep)}</b> Deep messages / mo</li>
          <li>Synced mission log</li>
          <li>Cancel anytime</li>
        </ul>
        <button class="${p.featured ? "btn-primary" : "btn-ghost"}" data-plan="${p.key}" ${current ? "disabled" : ""}>${current ? "Current plan" : "Choose " + p.name}</button>`;
      els.plansList.appendChild(card);
    }
  }
  async function showPlans() {
    if (!plans.length) { try { plans = (await api("/api/plans")).plans; } catch {} }
    renderPlans();
    openModal(els.plansModal);
  }
  els.plansList.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-plan]");
    if (!b) return;
    if (!user) { closeModal(els.plansModal); showAuth("signup"); return; }
    b.disabled = true; const label = b.textContent; b.textContent = "Opening secure checkout…";
    try {
      session.set("x09.draft", els.input.value || null);
      const { url } = await api("/api/billing/checkout", { method: "POST", body: { plan: b.dataset.plan } });
      location.href = url;
    } catch (err) {
      toast(err.message, 5000);
      b.disabled = false; b.textContent = label;
    }
  });

  // ---------- Account menu ----------
  function initials() {
    if (!user) return "";
    const src = (user.name || "").trim();
    if (src) return src.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
    return user.email[0].toUpperCase();
  }
  function renderAccount() {
    const rail = $("railProfile");
    if (user) { rail.classList.add("has-user"); X09.paintAvatar(rail, user); rail.dataset.tip = user.name || user.email; }
    else { rail.classList.remove("has-user", "has-photo"); rail.style.backgroundImage = ""; rail.innerHTML = RAIL_ICON; rail.dataset.tip = "Sign in"; }
    const btn = els.accountBtn;
    if (!user) {
      btn.textContent = "Sign in"; btn.classList.remove("signed-in", "has-photo"); btn.style.backgroundImage = "";
      els.accountMenu.hidden = true;
      setOnline(true);
      return;
    }
    btn.classList.add("signed-in");
    X09.paintAvatar(btn, user);
    btn.title = user.email;
    $("amEmail").textContent = user.email;
    $("amPlan").textContent = hasPlan() ? `${user.planName} plan${user.subStatus === "past_due" ? " · payment issue" : ""}` : "No active plan";
    $("amUsage").hidden = !hasPlan();
    $("amPlans").textContent = hasPlan() ? "Change plan" : "Choose a plan";
    $("amBilling").hidden = !user.hasBilling;
    if (hasPlan()) {
      const u = user.usage;
      $("amFast").textContent = `${fmtNum(u.fast)} / ${fmtNum(u.fastLimit)}`;
      $("amDeep").textContent = `${fmtNum(u.deep)} / ${fmtNum(u.deepLimit)}`;
      $("amFastBar").style.width = Math.min(100, (u.fast / u.fastLimit) * 100) + "%";
      $("amDeepBar").style.width = Math.min(100, (u.deep / u.deepLimit) * 100) + "%";
      const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 1, 1);
      $("amReset").textContent = `Resets ${next.toLocaleDateString([], { month: "short", day: "numeric" })}`;
    }
  }
  function toggleMenu(show) {
    const open = show ?? els.accountMenu.hidden;
    els.accountMenu.hidden = !open;
    els.accountBtn.setAttribute("aria-expanded", String(open));
  }
  els.accountBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!user) return showAuth("login");
    toggleMenu();
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".account")) toggleMenu(false); });
  $("amPlans").addEventListener("click", async () => {
    toggleMenu(false);
    if (hasPlan() && user.hasBilling) return openPortal();
    showPlans();
  });
  $("amBilling").addEventListener("click", () => { toggleMenu(false); openPortal(); });
  $("amLogout").addEventListener("click", () => { toggleMenu(false); X09.logout(); });
  async function openPortal() {
    try { const { url } = await api("/api/billing/portal", { method: "POST" }); location.href = url; }
    catch (err) { toast(err.message, 5000); }
  }

  // ---------- Profile: the shared X09 account panel (same on every X09 site) ----------
  const RAIL_ICON = $("railProfile").innerHTML;
  function openProfile() {
    if (!user) return showAuth("login");
    toggleMenu(false); closeSide();
    X09.openAccount();
  }
  $("railProfile").addEventListener("click", openProfile);
  $("amProfile").addEventListener("click", openProfile);
  X09.onUser((u) => {
    const wasSignedIn = !!user;
    user = u;
    if (!u && wasSignedIn) { threads = []; currentId = null; messages = []; renderThreads(); renderMessages(); }
    renderAccount();
  });

  async function refreshMe() {
    try { X09.setUser((await api("/api/me")).user); } catch {}
    return user;
  }

  // ---------- Rendering ----------
  const ICON_COPY = '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" stroke-width="2" fill="none"/></svg>';
  const ICON_RETRY = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

  function msgEl(m) {
    const div = document.createElement("div");
    const isUser = m.role === "user";
    div.className = `msg ${isUser ? "user" : "ai"}${m.error ? " error" : ""}`;
    div.innerHTML = `<div class="msg-head"><span class="who">${isUser ? "You" : "X09"}</span><span class="time">${fmtTime(m.at)}</span></div>`;
    if (isUser) {
      const b = document.createElement("div");
      b.className = "bubble"; b.textContent = m.content;
      div.appendChild(b);
    } else {
      div.insertAdjacentHTML("beforeend", `<div class="content"></div>${m.error ? "" : `<div class="actions"><button data-act="copy">${ICON_COPY}Copy</button><button data-act="retry">${ICON_RETRY}Retry</button></div>`}`);
      div.querySelector(".content").innerHTML = md(m.content);
    }
    return div;
  }

  const setHome = (on) => { document.body.classList.toggle("home", on); autosize(); };

  function renderMessages() {
    els.messages.innerHTML = "";
    const has = messages.length > 0;
    setHome(!has);
    const t = threads.find((x) => x.id === currentId);
    els.title.textContent = has && t ? t.title : "";
    messages.forEach((m) => els.messages.appendChild(msgEl(m)));
    scrollDown(true);
  }

  function renderThreads() {
    const q = els.search.value.trim().toLowerCase();
    const list = threads.filter((t) => !q || t.title.toLowerCase().includes(q));
    els.threads.innerHTML = "";
    if (!user) { els.threads.innerHTML = '<div class="no-threads">Sign in to see your mission log.</div>'; return; }
    if (!list.length) { els.threads.innerHTML = `<div class="no-threads">${q ? "No matches." : "No missions yet."}</div>`; return; }
    const day = 864e5, d = new Date();
    const startToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const group = (ts) => ts >= startToday ? "Today" : ts >= startToday - day ? "Yesterday" : ts >= startToday - 7 * day ? "Previous 7 days" : "Older";
    let last = "";
    for (const t of list) {
      const g = group(t.updated);
      if (g !== last) { const l = document.createElement("div"); l.className = "group-label"; l.textContent = g; els.threads.appendChild(l); last = g; }
      const b = document.createElement("button");
      b.className = "thread" + (t.id === currentId ? " active" : "");
      b.innerHTML = `<span class="t"></span><span class="del" role="button" aria-label="Delete" data-del><svg viewBox="0 0 24 24" width="15" height="15"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg></span>`;
      b.querySelector(".t").textContent = t.title;
      b.addEventListener("click", (e) => (e.target.closest("[data-del]") ? deleteThread(t.id) : openThread(t.id)));
      els.threads.appendChild(b);
    }
  }

  function scrollDown(force) {
    const c = els.chat;
    if (force || c.scrollHeight - c.scrollTop - c.clientHeight < 160) c.scrollTop = c.scrollHeight;
  }

  // ---------- Threads (server) ----------
  async function loadThreads() {
    try { threads = (await api("/api/threads")).threads; } catch { threads = []; }
    renderThreads();
  }
  function newThread() {
    stop();
    currentId = null; messages = [];
    renderMessages(); renderThreads(); closeSide();
    els.input.focus();
  }
  async function openThread(id) {
    stop();
    currentId = id; messages = [];
    renderThreads(); closeSide();
    try {
      const data = await api(`/api/threads/${id}`);
      if (currentId !== id) return;
      messages = data.messages;
      renderMessages();
    } catch (err) { toast(err.message); }
  }
  async function deleteThread(id) {
    try { await api(`/api/threads/${id}`, { method: "DELETE" }); } catch (err) { return toast(err.message); }
    threads = threads.filter((t) => t.id !== id);
    if (currentId === id) { currentId = null; messages = []; renderMessages(); }
    renderThreads();
  }

  // ---------- Sending ----------
  function gate() {
    if (!user) { showAuth("signup"); return false; }
    if (!hasPlan()) { showPlans(); return false; }
    return true;
  }

  async function send(text) {
    text = text.trim();
    if (!text || controller) return;
    if (!gate()) { els.input.value = text; autosize(); return; }
    messages.push({ role: "user", content: text, at: Date.now() });
    setHome(false);
    els.messages.appendChild(msgEl(messages[messages.length - 1]));
    await respond({ message: text, threadId: currentId });
  }

  async function respond(payload) {
    const aiMsg = { role: "assistant", content: "", at: Date.now() };
    const node = msgEl(aiMsg);
    const content = node.querySelector(".content");
    content.innerHTML = '<span class="thinking"></span>';
    els.messages.appendChild(node);
    scrollDown(true);
    setBusy(true);
    controller = new AbortController();
    let text = "", failed = null;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, mode }),
        signal: controller.signal,
      });
      if (!res.ok) {
        let data = {}; try { data = await res.json(); } catch {}
        const err = new Error(data.error || "Request failed"); err.status = res.status; err.code = data.code;
        throw err;
      }
      const tid = res.headers.get("x-thread-id");
      if (tid && !currentId) {
        currentId = tid;
        const title = decodeURIComponent(res.headers.get("x-thread-title") || "New mission");
        threads.unshift({ id: tid, title, updated: Date.now() });
        els.title.textContent = title;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const d = line.slice(5).trim();
          if (!d || d === "[DONE]") continue;
          try {
            const j = JSON.parse(d);
            const piece = j.response ?? j.choices?.[0]?.delta?.content ?? "";
            if (piece) { text += piece; content.innerHTML = md(text); content.classList.add("cursor"); scrollDown(); }
          } catch {}
        }
      }
      setOnline(true);
    } catch (err) {
      if (err.name === "AbortError") text = text || "_Transmission stopped._";
      else failed = err;
    }
    controller = null;
    setBusy(false);
    content.classList.remove("cursor");

    if (failed) {
      node.remove();
      if (payload.message) { messages.pop(); els.messages.lastChild?.remove(); els.input.value = payload.message; autosize(); }
      if (!messages.length) setHome(true);
      if (failed.status === 401) { user = null; renderAccount(); showAuth("login"); }
      else if (failed.code === "plan_required") { await refreshMe(); showPlans(); }
      else if (failed.code === "limit_reached") { toast(failed.message, 7000); }
      else { setOnline(false); toast(failed.message, 5000); }
      return;
    }
    aiMsg.content = text || "…";
    content.innerHTML = md(aiMsg.content);
    messages.push(aiMsg);
    const t = threads.find((x) => x.id === currentId);
    if (t) { t.updated = Date.now(); threads = [t, ...threads.filter((x) => x !== t)]; }
    renderThreads();
    refreshMe();
    scrollDown();
  }

  function stop() { if (controller) controller.abort(); }
  function setBusy(b) {
    els.send.classList.toggle("stop", b);
    els.send.setAttribute("aria-label", b ? "Stop" : "Send");
    els.send.disabled = !b && !els.input.value.trim();
  }
  function setOnline(ok) {
    document.querySelectorAll(".pulse").forEach((p) => p.classList.toggle("off", !ok));
    els.statusText.textContent = ok ? "X09 core online" : "Core unreachable";
  }

  // ---------- Events ----------
  function autosize() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 220) + "px";
    if (!controller) els.send.disabled = !els.input.value.trim();
  }
  els.input.addEventListener("input", autosize);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.form.requestSubmit(); }
  });
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (controller) return stop();
    const v = els.input.value;
    if (!gate()) return;
    els.input.value = ""; autosize();
    send(v);
  });
  $("suggestions").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const text = `${b.querySelector("b").textContent} ${b.querySelector("span").textContent}`;
    if (!gate()) { els.input.value = text; autosize(); return; }
    send(text);
  });

  els.messages.addEventListener("click", async (e) => {
    const copyCode = e.target.closest("[data-copy]");
    if (copyCode) {
      try { await navigator.clipboard.writeText(copyCode.closest("pre").querySelector("code").textContent); copyCode.textContent = "Copied"; setTimeout(() => (copyCode.textContent = "Copy"), 1400); } catch {}
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const idx = [...els.messages.children].indexOf(act.closest(".msg"));
    if (act.dataset.act === "copy") {
      try { await navigator.clipboard.writeText(messages[idx].content); act.lastChild.textContent = "Copied"; setTimeout(() => (act.lastChild.textContent = "Copy"), 1400); } catch {}
    } else if (act.dataset.act === "retry" && !controller && currentId) {
      messages = messages.slice(0, idx);
      renderMessages();
      respond({ threadId: currentId, regenerate: true });
    }
  });

  document.querySelectorAll(".mode button").forEach((b) =>
    b.addEventListener("click", () => {
      mode = b.dataset.mode;
      document.querySelectorAll(".mode button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    })
  );

  $("newChat").addEventListener("click", newThread);
  $("newChatTop").addEventListener("click", newThread);
  $("clearAll").addEventListener("click", async () => {
    if (!threads.length || !confirm("Delete your whole mission log? This can't be undone.")) return;
    try { await api("/api/threads", { method: "DELETE" }); } catch (err) { return toast(err.message); }
    threads = []; currentId = null; messages = []; renderMessages(); renderThreads();
  });
  els.search.addEventListener("input", renderThreads);

  const openSide = () => { els.sidebar.classList.add("open"); els.scrim.classList.add("show"); };
  function closeSide() { els.sidebar.classList.remove("open"); els.scrim.classList.remove("show"); }
  $("openSide").addEventListener("click", openSide);
  $("openSideMobile").addEventListener("click", openSide);
  $("closeSide").addEventListener("click", closeSide);
  els.scrim.addEventListener("click", closeSide);

  addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); newThread(); }
    if (e.key === "Escape") {
      document.querySelectorAll(".modal.open").forEach(closeModal);
      closeSide(); toggleMenu(false); stop();
    }
  });

  // ---------- Markdown (small, safe) ----------
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function md(src) {
    const parts = src.split(/```/);
    let html = "";
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf("\n");
        const lang = nl > -1 ? part.slice(0, nl).trim() : "";
        const code = nl > -1 ? part.slice(nl + 1) : part;
        html += `<pre><div class="code-head"><span>${esc(lang || "code")}</span><button class="small-btn" data-copy>Copy</button></div><code>${esc(code.replace(/\n$/, ""))}</code></pre>`;
        return;
      }
      const lines = esc(part).split("\n");
      let list = null, para = [];
      const flushPara = () => { if (para.length) { html += `<p>${inline(para.join("<br>"))}</p>`; para = []; } };
      const flushList = () => { if (list) { html += `<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join("")}</${list.tag}>`; list = null; } };
      for (const line of lines) {
        let m;
        if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { flushPara(); if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; } list.items.push(m[1]); }
        else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flushPara(); if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; } list.items.push(m[1]); }
        else if ((m = line.match(/^#{1,4}\s+(.*)/))) { flushPara(); flushList(); html += `<h3>${inline(m[1])}</h3>`; }
        else if (!line.trim()) { flushPara(); flushList(); }
        else { flushList(); para.push(line); }
      }
      flushPara(); flushList();
    });
    return html;
  }


  // ---------- HUD clock + greeting ----------
  const clock = $("clock");
  function tickClock() {
    const d = new Date();
    clock.textContent = d.toISOString().slice(11, 19) + " UTC";
  }
  tickClock(); setInterval(tickClock, 1000);
  const hr = new Date().getHours();
  $("greeting").textContent = hr < 5 ? "Burning the midnight oil." : hr < 12 ? "Good morning." : hr < 18 ? "Good afternoon." : "Good evening.";


  // ---------- Boot ----------
  (async function boot() {
    const params = new URLSearchParams(location.search);
    const checkout = params.get("checkout");
    if (params.has("checkout") || params.has("portal")) history.replaceState(null, "", "/");

    const draft = session.get("x09.draft");
    if (draft) { els.input.value = draft; session.set("x09.draft", null); }

    renderAccount(); renderThreads(); renderMessages();
    api("/api/plans").then((d) => (plans = d.plans)).catch(() => {});
    await refreshMe();

    if (checkout === "success") {
      toast("Payment received — activating your plan…", 6000);
      // Stripe's webhook can take a few seconds; poll until the plan shows up
      for (let i = 0; i < 12 && !hasPlan(); i++) {
        await new Promise((r) => setTimeout(r, 1500));
        await refreshMe();
      }
      toast(hasPlan() ? `Welcome aboard. ${user.planName} plan active.` : "Payment received. Your plan will activate shortly — refresh in a moment.", 6000);
    } else if (checkout === "cancel") {
      toast("Checkout canceled — no charge was made.");
    }

    if (user) {
      await loadThreads();
      if (!hasPlan() && checkout !== "success") showPlans();
    }
    autosize();
    if (matchMedia("(min-width: 821px)").matches) els.input.focus();
  })();
})();
