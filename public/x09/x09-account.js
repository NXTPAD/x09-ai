/* ============================================================
   X09 account kit — shared by X09 Hub, X09 AI and X09 Docs.
   Identical in every repo (public/x09/x09-account.js).

   One X09 account works on every site (the sign-in cookie is shared across x09hub.com),
   so this panel shows the same profile, photo and plans everywhere.

     X09.init({ site: "hub" | "ai" | "docs", onUser(user) })
     X09.openAccount()          profile, photo, every X09 plan, billing, password, delete
     X09.openAuth("login"|"signup")
     X09.mountSwitcher(el)      the app switcher (Hub / AI / Docs)
     X09.mountLogo(el, size)    the animated X09 logo
     X09.paintAvatar(el, user)  profile photo or initials on any element
   ============================================================ */
(() => {
  "use strict";
  const SITES = [
    { key: "hub", name: "X09 Hub", host: "x09hub.com", url: "https://x09hub.com", orb: "HUB", note: "Start here · your X09 account" },
    { key: "ai", name: "X09 AI", host: "ai.x09hub.com", url: "https://ai.x09hub.com", orb: "AI", note: "AI co-pilot · chat" },
    { key: "docs", name: "X09 Docs", host: "docs.x09hub.com", url: "https://docs.x09hub.com", orb: "DOC", note: "AI invoices & contracts" },
  ];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString();
  const X = (window.X09 = window.X09 || {});
  let listeners = [];

  async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(path, {
      method, credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.code = data.code; e.status = res.status; throw e; }
    return data;
  }
  X.api = api;

  function setUser(u) {
    X.user = u || null;
    for (const fn of listeners) try { fn(X.user); } catch (e) { console.error(e); }
    document.dispatchEvent(new CustomEvent("x09:user", { detail: X.user }));
    renderSwitcher();
    if (acct && !acct.hidden) renderAccount();
  }
  X.setUser = setUser;
  X.onUser = (fn) => listeners.push(fn);
  X.refresh = async () => { try { setUser((await api("/api/me")).user); } catch {} return X.user; };

  X.initials = (u) => {
    const src = (u?.name || u?.email || "?").trim();
    const parts = src.split(/[\s@._-]+/).filter(Boolean);
    return ((parts[0]?.[0] || "?") + (u?.name && parts[1] ? parts[1][0] : "")).toUpperCase();
  };
  X.paintAvatar = (el, u) => {
    if (!el) return;
    if (u?.avatar) { el.style.backgroundImage = `url("${u.avatar}")`; el.textContent = ""; el.classList.add("has-photo"); }
    else { el.style.backgroundImage = ""; el.textContent = u ? X.initials(u) : ""; el.classList.remove("has-photo"); }
  };

  function toast(msg, ms = 3200) {
    let t = document.getElementById("x09Toast");
    if (!t) { t = document.createElement("div"); t.id = "x09Toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), ms);
  }
  X.toast = toast;

  // ---------- Modals ----------
  const closeSvg = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  function makeModal(id, cls, label) {
    const m = document.createElement("div");
    m.className = "modal"; m.id = id; m.hidden = true;
    m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true"); m.setAttribute("aria-label", label);
    m.innerHTML = `<div class="modal-card ${cls}"><button class="icon-btn modal-close" data-x09-close aria-label="Close">${closeSvg}</button><div class="x09-body"></div></div>`;
    m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-x09-close]")) close(m); });
    document.body.appendChild(m);
    return m;
  }
  function open(m) { m.hidden = false; requestAnimationFrame(() => m.classList.add("open")); }
  function close(m) { m.classList.remove("open"); setTimeout(() => (m.hidden = true), 200); }
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const m of [acct, auth]) if (m && !m.hidden) close(m);
    const sm = document.querySelector(".x09-switch-menu:not([hidden])");
    if (sm) { sm.hidden = true; sm.previousElementSibling?.setAttribute("aria-expanded", "false"); }
  });

  // ---------- Sign in / create account ----------
  let auth, authTab = "login", afterAuth = null;
  X.openAuth = (tab = "login", then) => {
    afterAuth = then || null;
    if (!auth) {
      auth = makeModal("x09AuthModal", "auth-card", "Sign in to X09");
      auth.querySelector(".x09-body").innerHTML = `
        <span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>
        <div class="x09-logo modal-logo" data-x09-logo="46"></div>
        <p class="kicker mono">// One X09 account · every X09 site</p>
        <h2 id="x09AuthTitle">Sign in to X09</h2>
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected="true" data-tab="login">Sign in</button>
          <button role="tab" aria-selected="false" data-tab="signup">Create account</button>
        </div>
        <form id="authForm" novalidate>
          <label>Email<input type="email" name="email" autocomplete="email" required /></label>
          <label>Password<input type="password" name="password" autocomplete="current-password" minlength="8" required /></label>
          <p class="form-error" role="alert"></p>
          <button class="btn-primary" type="submit">Sign in</button>
        </form>
        <p class="fine">Works on X09 Hub, X09 AI and X09 Docs.</p>`;
      X.mountLogo(auth.querySelector("[data-x09-logo]"), 46);
      auth.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
      auth.querySelector("form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target, err = f.querySelector(".form-error"), btn = f.querySelector("button");
        err.textContent = ""; btn.disabled = true;
        try {
          const d = await api(authTab === "login" ? "/api/auth/login" : "/api/auth/signup", { method: "POST", body: { email: f.email.value, password: f.password.value } });
          setUser(d.user); close(auth);
          toast(authTab === "login" ? "Welcome back." : "Account created. Welcome to X09.");
          if (afterAuth) afterAuth(d.user);
        } catch (ex) { err.textContent = ex.message; }
        finally { btn.disabled = false; }
      });
    }
    setTab(tab); open(auth);
    setTimeout(() => auth.querySelector("input[name=email]").focus(), 60);
  };
  function setTab(tab) {
    authTab = tab;
    auth.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    auth.querySelector("#x09AuthTitle").textContent = tab === "login" ? "Sign in to X09" : "Create your X09 account";
    auth.querySelector("button[type=submit]").textContent = tab === "login" ? "Sign in" : "Create account";
    auth.querySelector("input[name=password]").autocomplete = tab === "login" ? "current-password" : "new-password";
    auth.querySelector(".form-error").textContent = "";
  }

  // ---------- Account panel ----------
  let acct, openPlans = null;
  async function loadCatalog() {
    if (X.catalog) return X.catalog;
    try { X.catalog = (await api("/api/plans")).catalog; } catch { X.catalog = []; }
    return X.catalog;
  }
  X.openAccount = async (opts = {}) => {
    if (!X.user) return X.openAuth("login", () => X.openAccount(opts));
    if (!acct) acct = makeModal("x09AccountModal", "profile-card x09-acct", "Your X09 account");
    openPlans = opts.plans || null;
    await loadCatalog();
    renderAccount(); open(acct);
    X.refresh();
  };
  X.closeAccount = () => acct && close(acct);

  function meter(label, used, limit) {
    const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
    return `<div class="meter"><div class="meter-top"><span>${label}</span><span class="mono">${fmt(used)} / ${fmt(limit)}</span></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
  }
  function planCards(prod, current) {
    return `<div class="x09-plans-inline"><div class="plans">${prod.plans.map((p) => {
      const lines = prod.key === "ai"
        ? [`<b>${fmt(p.fast)}</b> Fast messages / mo`, `<b>${fmt(p.deep)}</b> Deep messages / mo`, "Claude Haiku + Sonnet"]
        : [`<b>${fmt(p.docs)}</b> AI drafts / mo`, "Unlimited documents", p.whiteLabel ? "<b>No X09 branding</b>" : "E-signature & PDF"];
      const cur = current === p.key;
      return `<div class="plan${p.featured ? " featured" : ""}${cur ? " current" : ""}">
        ${p.featured ? '<span class="badge mono">Popular</span>' : ""}
        <div class="plan-name mono">${esc(p.name)}</div>
        <div class="plan-price">${esc(p.price)}<span>/mo</span></div>
        <ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>
        <button class="${p.featured ? "btn-primary" : "btn-ghost"}" data-checkout="${prod.key}:${p.key}" ${cur ? "disabled" : ""}>${cur ? "Current" : "Choose"}</button>
      </div>`;
    }).join("")}</div></div>`;
  }
  function renderAccount() {
    const u = X.user;
    if (!u || !acct) return;
    const since = new Date(u.createdAt).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const prods = (X.catalog || []).map((prod) => {
      const s = u.products?.[prod.key] || {};
      const active = !!s.plan;
      const renew = s.renewsAt ? new Date(s.renewsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
      const status = active ? `${esc(s.planName)} · ${esc(s.price)}/mo${s.status === "past_due" ? " · payment issue" : renew ? ` · renews ${renew}` : ""}` : "No plan";
      const meters = !active ? "" : prod.key === "ai"
        ? meter("Fast messages", s.usage.fast, s.usage.fastLimit) + meter("Deep messages", s.usage.deep, s.usage.deepLimit)
        : meter("AI drafts", s.usage.docs, s.usage.docsLimit);
      const here = X.site === prod.key;
      return `<div class="x09-prod${active ? " active" : ""}">
        <div class="x09-prod-top"><span class="x09-switch-orb">${prod.key === "ai" ? "AI" : "DOC"}</span>
          <div class="grow"><b>${esc(prod.name)}</b><p class="pf-sub">${status}</p></div>
          <span class="x09-chip${active ? " on" : ""}">${active ? "Active" : "Inactive"}</span></div>
        ${meters}
        <div class="x09-prod-actions">
          ${here ? "" : `<a class="btn-ghost" href="${esc(prod.url)}">Open ${esc(prod.name)} →</a>`}
          ${active ? `<button class="btn-ghost" data-portal>Change plan</button>` : `<button class="btn-primary" data-plans="${prod.key}">${openPlans === prod.key ? "Hide plans" : "See plans"}</button>`}
        </div>
        ${!active && openPlans === prod.key ? planCards(prod, s.plan) : ""}
      </div>`;
    }).join("");

    acct.querySelector(".x09-body").innerHTML = `
      <div class="pf-head">
        <div class="pf-avatar" id="x09Avatar" title="Change profile photo" role="button" tabindex="0"></div>
        <input type="file" id="x09AvatarFile" accept="image/png,image/jpeg,image/webp,image/*" hidden />
        <div class="pf-id">
          <h2>${esc(u.name || "Your X09 account")}</h2>
          <div class="pf-email">${esc(u.email)}</div>
          <span class="x09-id">X09 ID · since ${esc(since)}</span>
        </div>
      </div>
      <section class="pf-sec">
        <div class="pf-label mono">// Profile · shown on every X09 site</div>
        <form id="x09ProfileForm" class="pf-stack" style="margin-top:0">
          <div class="x09-grid2">
            <label>Display name<input name="name" maxlength="60" value="${esc(u.name || "")}" placeholder="What should X09 call you?" autocomplete="name" /></label>
            <label>Company<input name="company" maxlength="80" value="${esc(u.company || "")}" placeholder="Optional" autocomplete="organization" /></label>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button class="btn-primary sm" type="submit">Save profile</button>
            ${u.avatar ? '<button class="link-btn" type="button" id="x09RemovePhoto">Remove photo</button>' : ""}
          </div>
        </form>
      </section>
      <section class="pf-sec">
        <div class="pf-label mono">// Your X09 plans</div>
        <div class="x09-prods">${prods}</div>
        ${u.guide?.limit ? `<p class="pf-sub" style="margin-top:12px">Ask X09 on the Hub: ${fmt(u.guide.used)} / ${fmt(u.guide.limit)} questions this month · included with any plan</p>` : ""}
        ${u.hasBilling ? '<button class="link-btn pf-link" data-portal>Manage billing &amp; invoices →</button>' : ""}
        <p class="fine" style="text-align:left">Secure checkout by Stripe · one bill profile for every X09 product · cancel anytime</p>
      </section>
      <section class="pf-sec">
        <div class="pf-label mono">// Security</div>
        <details class="pf-details">
          <summary>Change password</summary>
          <form class="pf-stack" id="x09PwForm">
            <input type="password" name="current" placeholder="Current password" autocomplete="current-password" />
            <input type="password" name="next" placeholder="New password (8+ characters)" autocomplete="new-password" />
            <p class="form-error" role="alert"></p>
            <button class="btn-primary sm" type="submit">Update password</button>
          </form>
        </details>
      </section>
      <section class="pf-sec pf-actions">
        <button class="btn-ghost" id="x09Logout">Sign out of X09</button>
        <details class="pf-details danger">
          <summary>Delete account</summary>
          <form class="pf-stack" id="x09DelForm">
            <p class="pf-sub">This permanently deletes your X09 account and your data on every X09 site (chats, documents, profile), and cancels any active X09 plans.</p>
            <input type="password" name="password" placeholder="Enter your password to confirm" autocomplete="current-password" />
            <p class="form-error" role="alert"></p>
            <button class="btn-danger" type="submit">Delete my X09 account</button>
          </form>
        </details>
      </section>`;

    const $ = (s) => acct.querySelector(s);
    X.paintAvatar($("#x09Avatar"), u);
    const pick = () => $("#x09AvatarFile").click();
    $("#x09Avatar").addEventListener("click", pick);
    $("#x09Avatar").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
    $("#x09AvatarFile").addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const avatar = await squareImage(f, 256);
        setUser((await api("/api/profile", { method: "POST", body: { avatar } })).user);
        toast("Profile photo updated on every X09 site.");
      } catch (ex) { toast(ex.message || "Couldn't use that image."); }
    });
    $("#x09RemovePhoto")?.addEventListener("click", async () => {
      try { setUser((await api("/api/profile", { method: "POST", body: { avatar: null } })).user); } catch (ex) { toast(ex.message); }
    });
    $("#x09ProfileForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        setUser((await api("/api/profile", { method: "POST", body: { name: e.target.name.value, company: e.target.company.value } })).user);
        toast("Profile saved.");
      } catch (ex) { toast(ex.message); }
    });
    acct.querySelectorAll("[data-plans]").forEach((b) => b.addEventListener("click", () => {
      openPlans = openPlans === b.dataset.plans ? null : b.dataset.plans; renderAccount();
    }));
    acct.querySelectorAll("[data-checkout]").forEach((b) => b.addEventListener("click", async () => {
      const [product, plan] = b.dataset.checkout.split(":");
      b.disabled = true; b.textContent = "Opening…";
      try { location.href = (await api("/api/billing/checkout", { method: "POST", body: { product, plan } })).url; }
      catch (ex) { toast(ex.message); b.disabled = false; b.textContent = "Choose"; }
    }));
    acct.querySelectorAll("[data-portal]").forEach((b) => b.addEventListener("click", X.openBilling));
    $("#x09PwForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target, err = f.querySelector(".form-error"); err.textContent = "";
      try { await api("/api/auth/password", { method: "POST", body: { current: f.current.value, next: f.next.value } }); f.reset(); toast("Password updated. Other devices were signed out."); }
      catch (ex) { err.textContent = ex.message; }
    });
    $("#x09Logout").addEventListener("click", X.logout);
    $("#x09DelForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target, err = f.querySelector(".form-error"); err.textContent = "";
      try { await api("/api/auth/delete", { method: "POST", body: { password: f.password.value } }); close(acct); setUser(null); toast("Your X09 account was deleted."); }
      catch (ex) { err.textContent = ex.message; }
    });
  }

  X.openBilling = async () => {
    try { location.href = (await api("/api/billing/portal", { method: "POST" })).url; }
    catch (ex) { toast(ex.message); }
  };
  X.logout = async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch {}
    if (acct) close(acct);
    setUser(null); toast("Signed out of X09.");
  };

  // Crop to a centered square and shrink, so photos stay small in the database
  function squareImage(file, size) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) return reject(new Error("Choose an image file."));
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(img.width, img.height), c = document.createElement("canvas");
        c.width = c.height = size;
        c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url);
        let d = c.toDataURL("image/webp", 0.85);
        if (!d.startsWith("data:image/webp")) d = c.toDataURL("image/jpeg", 0.85);
        resolve(d);
      };
      img.onerror = () => reject(new Error("Couldn't read that image."));
      img.src = url;
    });
  }

  // ---------- App switcher ----------
  const switchers = [];
  X.mountSwitcher = (el) => {
    el.classList.add("x09-switch");
    el.innerHTML = `<button class="x09-switch-btn" aria-label="X09 apps" aria-haspopup="true" aria-expanded="false" data-magnet>
      <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><circle cx="6" cy="6" r="2"/><circle cx="12" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="12" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>
    </button><div class="x09-switch-menu" role="menu" hidden></div>`;
    const btn = el.firstElementChild, menu = el.lastElementChild;
    btn.addEventListener("click", (e) => { e.stopPropagation(); const show = menu.hidden; menu.hidden = !show; btn.setAttribute("aria-expanded", String(show)); });
    document.addEventListener("click", (e) => { if (!el.contains(e.target)) { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); } });
    switchers.push(menu); renderSwitcher();
  };
  function renderSwitcher() {
    const u = X.user;
    for (const menu of switchers) {
      menu.innerHTML = `<div class="x09-switch-head">X09 · one account, every app</div>` + SITES.map((s) => {
        const p = u?.products?.[s.key];
        const chip = s.key === X.site ? '<span class="x09-chip on">Here</span>' : p?.plan ? `<span class="x09-chip on">${esc(p.planName)}</span>` : "";
        return `<a class="x09-switch-item${s.key === X.site ? " here" : ""}" href="${s.url}" role="menuitem"><span class="x09-switch-orb">${s.orb}</span><div><b>${s.name}</b><span>${s.note}</span></div>${chip}</a>`;
      }).join("") + (u ? `<button class="am-item am-strong" data-x09-account style="margin-top:6px">Your X09 account & plans</button>` : `<button class="am-item am-strong" data-x09-signin style="margin-top:6px">Sign in to X09</button>`);
      menu.querySelector("[data-x09-account]")?.addEventListener("click", () => { menu.hidden = true; X.openAccount(); });
      menu.querySelector("[data-x09-signin]")?.addEventListener("click", () => { menu.hidden = true; X.openAuth("login"); });
    }
  }

  X.mountLogo = (el, size = 28) => {
    el.classList.add("x09-logo");
    if (window.X09Space) window.X09Space.logo(el, size);
    else el.innerHTML = `<img src="/x09/logo.svg" width="${size}" height="${size}" alt="" />`;
  };

  X.init = ({ site, onUser } = {}) => {
    X.site = site;
    if (onUser) listeners.push(onUser);
    document.querySelectorAll("[data-x09-logo]").forEach((el) => X.mountLogo(el, Number(el.dataset.x09Logo) || 28));
    document.querySelectorAll("[data-x09-switcher]").forEach((el) => X.mountSwitcher(el));
  };
})();
