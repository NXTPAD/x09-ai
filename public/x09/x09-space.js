/* ============================================================
   X09 Space — the shared physics background for every X09 site.
   Identical in X09 Hub, X09 AI and X09 Docs (public/x09/x09-space.js).

   • Starfield with depth, parallax (pointer / device tilt) and shooting stars
   • Rigid bodies — asteroids, moons and ringed planets — with mass, spin,
     elastic collisions, weak mutual gravity and impact sparks
   • Grab any body and fling it (mouse or touch)
   • Press & hold empty space → gravity well pulls everything in; release → shockwave
   • Elements marked [data-x09-solid] are solid: bodies bounce off them
   • Page scroll and device tilt push bodies around (inertia)
   • Respects prefers-reduced-motion (static scene)

   Usage:  X09Space.start({ density: 1, opacity: 1 })
   ============================================================ */
(() => {
  "use strict";
  const TAU = Math.PI * 2;
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // Monochrome palette (white, silver, grey) used for rim light, sparks and tinted stars
  const HUES = ["255,255,255", "200,200,200", "140,140,140"];
  const pick = () => HUES[Math.floor(Math.random() * HUES.length)];
  const INTERACTIVE = "a,button,input,textarea,select,label,summary,[contenteditable],[role=dialog],[role=menu],.no-space,pre,code";

  function sprite(size, draw) {
    const c = document.createElement("canvas");
    c.width = c.height = Math.ceil(size);
    draw(c.getContext("2d"), size);
    return c;
  }

  // ---------- Body sprites (pre-rendered once per body) ----------
  function makeRock(r, dpr) {
    const n = 9 + Math.floor(Math.random() * 4);
    const pts = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * TAU + rand(-0.18, 0.18);
      const d = r * rand(0.74, 1.04);
      return [Math.cos(a) * d, Math.sin(a) * d];
    });
    const craters = Array.from({ length: 2 + Math.floor(Math.random() * 3) }, () => [rand(-0.45, 0.45) * r, rand(-0.45, 0.45) * r, rand(0.1, 0.22) * r]);
    const S = (r * 2 + 6) * dpr;
    return sprite(S, (g) => {
      g.translate(S / 2, S / 2); g.scale(dpr, dpr);
      g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
      const grd = g.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.1);
      grd.addColorStop(0, "#8d8d8d"); grd.addColorStop(0.45, "#3b3b3b"); grd.addColorStop(1, "#0b0b0b");
      g.fillStyle = grd; g.fill();
      g.strokeStyle = "rgba(255,255,255,.28)"; g.lineWidth = 1; g.stroke();
      g.save(); g.clip();
      for (const [x, y, cr] of craters) {
        g.beginPath(); g.arc(x, y, cr, 0, TAU); g.fillStyle = "rgba(0,0,0,.35)"; g.fill();
        g.beginPath(); g.arc(x - cr * 0.25, y - cr * 0.25, cr * 0.8, 0, TAU); g.strokeStyle = "rgba(255,255,255,.12)"; g.stroke();
      }
      g.restore();
    });
  }
  function makeMoonTexture(r, dpr) {
    const craters = Array.from({ length: 4 + Math.floor(Math.random() * 4) }, () => {
      const a = rand(0, TAU), d = Math.sqrt(Math.random()) * r * 0.75;
      return [Math.cos(a) * d, Math.sin(a) * d, rand(0.08, 0.2) * r];
    });
    const S = (r * 2 + 4) * dpr;
    return sprite(S, (g) => {
      g.translate(S / 2, S / 2); g.scale(dpr, dpr);
      g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fillStyle = "#d9d9d9"; g.fill();
      for (const [x, y, cr] of craters) { g.beginPath(); g.arc(x, y, cr, 0, TAU); g.fillStyle = "rgba(0,0,0,.16)"; g.fill(); }
    });
  }
  function makeShade(r, dpr) { // fixed light from the top-left, drawn un-rotated on top of the texture
    const S = (r * 2 + 4) * dpr;
    return sprite(S, (g) => {
      g.translate(S / 2, S / 2); g.scale(dpr, dpr);
      const grd = g.createRadialGradient(-r * 0.4, -r * 0.45, r * 0.05, 0, 0, r * 1.05);
      grd.addColorStop(0, "rgba(255,255,255,.55)"); grd.addColorStop(0.4, "rgba(255,255,255,0)");
      grd.addColorStop(0.75, "rgba(0,0,0,.55)"); grd.addColorStop(1, "rgba(0,0,0,.92)");
      g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fillStyle = grd; g.fill();
    });
  }

  class Space {
    constructor(opts = {}) {
      this.o = Object.assign({ density: 1, opacity: 1, bodies: true, solids: "[data-x09-solid]" }, opts);
      this.reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      this.canvas = document.createElement("canvas");
      this.canvas.id = "x09-space";
      this.canvas.setAttribute("aria-hidden", "true");
      document.body.prepend(this.canvas);
      this.ctx = this.canvas.getContext("2d");
      this.stars = []; this.shooters = []; this.bodies = []; this.sparks = []; this.waves = []; this.solids = [];
      this.px = 0; this.py = 0; this.tx = 0; this.ty = 0;
      this.ptr = { x: -1e4, y: -1e4, vx: 0, vy: 0, t: 0, down: false, well: 0, wellAt: 0, grab: null, hist: [] };
      this.tilt = { x: 0, y: 0 };
      this.lastScroll = scrollY;
      this.last = performance.now();
      this.resize();
      this.bind();
      this.readSolids();
      this.frame = this.frame.bind(this);
      requestAnimationFrame(this.frame);
    }

    // ---------- setup ----------
    resize() {
      this.dpr = Math.min(devicePixelRatio || 1, 2);
      this.W = innerWidth; this.H = innerHeight;
      this.canvas.width = this.W * this.dpr; this.canvas.height = this.H * this.dpr;
      const n = Math.min(380, Math.round((this.W * this.H) / 2800));
      this.stars = Array.from({ length: n }, () => this.makeStar());
      if (this.o.bodies && !this.bodies.length) this.spawnBodies();
      for (const b of this.bodies) { b.x = clamp(b.x, b.r, this.W - b.r); b.y = clamp(b.y, b.r, this.H - b.r); }
    }
    makeStar() {
      const z = Math.random(), a = rand(0, TAU), s = 5 + z * 18;
      return { hue: Math.random() < 0.14 ? pick() : "255,255,255", x: rand(0, this.W), y: rand(0, this.H), z, r: 0.3 + z * 1.25, vx: Math.cos(a) * s, vy: Math.sin(a) * s, wob: rand(0, TAU), ws: rand(0.2, 0.7), tw: rand(0, TAU) };
    }
    spawnBodies() {
      const area = this.W * this.H;
      const count = Math.round(clamp(area / 110000, 5, 14) * this.o.density);
      for (let i = 0; i < count; i++) this.addBody();
    }
    addBody(x, y, kind) {
      const small = this.W < 700;
      const roll = Math.random();
      kind = kind || (roll < 0.55 ? "rock" : roll < 0.85 ? "moon" : "ringed");
      const r = kind === "rock" ? rand(5, small ? 14 : 20) : kind === "moon" ? rand(8, small ? 16 : 24) : rand(10, small ? 16 : 22);
      const b = {
        kind, r, m: r * r,
        x: x ?? rand(r, this.W - r), y: y ?? rand(r, this.H - r),
        vx: rand(-22, 22), vy: rand(-22, 22), a: rand(0, TAU), va: rand(-0.6, 0.6),
        cruise: rand(8, 20), tilt: rand(-0.5, 0.5), glow: 0, hue: pick(),
      };
      if (kind === "rock") b.img = makeRock(r, this.dpr);
      else { b.img = makeMoonTexture(r, this.dpr); b.shade = makeShade(r, this.dpr); }
      // don't start inside another body
      for (let k = 0; k < 20 && this.bodies.some((o) => Math.hypot(o.x - b.x, o.y - b.y) < o.r + b.r + 4); k++) {
        b.x = rand(r, this.W - r); b.y = rand(r, this.H - r);
      }
      this.bodies.push(b);
      return b;
    }
    readSolids() {
      this.solids = [...document.querySelectorAll(this.o.solids)]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < this.H)
        .map((r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom, rad: 14 }));
    }

    // ---------- input ----------
    bodyAt(x, y) {
      for (let i = this.bodies.length - 1; i >= 0; i--) {
        const b = this.bodies[i];
        if (Math.hypot(b.x - x, b.y - y) < b.r + 10) return b;
      }
      return null;
    }
    freeTarget(t) {
      if (!t || t === document.documentElement || t === document.body) return true;
      if (t.closest && t.closest(INTERACTIVE)) return false;
      return true;
    }
    bgTarget(t) { return t === document.documentElement || t === document.body || (t && t.hasAttribute && t.hasAttribute("data-x09-bg")); }
    bind() {
      addEventListener("resize", () => { this.resize(); this.readSolids(); });
      addEventListener("scroll", () => this.readSolids(), { passive: true });
      setInterval(() => this.readSolids(), 700);
      document.addEventListener("visibilitychange", () => (this.last = performance.now()));

      const move = (e) => {
        const p = this.ptr, t = performance.now();
        const dt = Math.max(1, t - p.t) / 1000;
        if (p.t) { p.vx = (e.clientX - p.x) / dt; p.vy = (e.clientY - p.y) / dt; }
        p.x = e.clientX; p.y = e.clientY; p.t = t;
        p.hist.push([p.x, p.y, t]); if (p.hist.length > 6) p.hist.shift();
        this.tx = e.clientX / this.W - 0.5; this.ty = e.clientY / this.H - 0.5;
        if (p.down && !p.grab && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 12) p.wellArmed = false;
      };
      addEventListener("pointermove", move, { passive: true });
      addEventListener("pointerdown", (e) => {
        if (e.button > 0 || this.reduce) return;
        const p = this.ptr;
        move(e); p.hist = [[e.clientX, e.clientY, performance.now()]];
        p.sx = e.clientX; p.sy = e.clientY;
        if (!this.freeTarget(e.target)) return;
        const b = this.bodyAt(e.clientX, e.clientY);
        if (b) { p.grab = b; b.glow = 1; p.down = true; document.documentElement.classList.add("x09-grabbing"); e.preventDefault(); return; }
        if (this.bgTarget(e.target)) { p.down = true; p.wellArmed = true; p.wellAt = performance.now(); }
      });
      const up = () => {
        const p = this.ptr;
        if (p.grab) {
          const h = p.hist, a = h[0], z = h[h.length - 1];
          const dt = Math.max(16, z[2] - a[2]) / 1000;
          p.grab.vx = clamp((z[0] - a[0]) / dt, -1600, 1600);
          p.grab.vy = clamp((z[1] - a[1]) / dt, -1600, 1600);
          p.grab.va += clamp(p.grab.vx / 200, -6, 6);
          p.grab = null;
          document.documentElement.classList.remove("x09-grabbing");
        } else if (p.well > 0.35) {
          this.shockwave(p.x, p.y, p.well);
        }
        p.down = false; p.wellArmed = false; p.well = 0;
      };
      addEventListener("pointerup", up);
      addEventListener("pointercancel", up);
      // Touch: stop the page scrolling while dragging a body
      addEventListener("touchstart", (e) => {
        const t = e.touches[0];
        if (t && !this.reduce && this.freeTarget(e.target) && this.bodyAt(t.clientX, t.clientY)) e.preventDefault();
      }, { passive: false });
      addEventListener("deviceorientation", (e) => {
        if (e.gamma == null) return;
        this.tilt.x = clamp(e.gamma / 45, -1, 1);
        this.tilt.y = clamp((e.beta - 45) / 45, -1, 1);
        this.tx = this.tilt.x * 0.5; this.ty = this.tilt.y * 0.5;
      });
      // Double-click / double-tap empty space → a new moon drops in
      addEventListener("dblclick", (e) => {
        if (this.reduce || !this.bgTarget(e.target) || this.bodies.length > 40) return;
        const b = this.addBody(e.clientX, e.clientY, Math.random() < 0.5 ? "moon" : "ringed");
        b.vx = rand(-60, 60); b.vy = rand(-60, 60);
        this.burst(e.clientX, e.clientY, 14);
      });
    }
    shockwave(x, y, power) {
      this.waves.push({ x, y, r: 0, life: 1 });
      for (const b of this.bodies) {
        const dx = b.x - x, dy = b.y - y, d = Math.hypot(dx, dy) || 1;
        const f = (900 * power * 90) / (d + 90);
        b.vx += (dx / d) * f * (400 / (b.m + 400)) * 1.4; b.vy += (dy / d) * f * (400 / (b.m + 400)) * 1.4;
        b.va += rand(-2, 2) * power;
      }
      this.burst(x, y, 24);
    }
    burst(x, y, n = 10, speed = 160, hue) {
      for (let i = 0; i < n; i++) {
        const a = rand(0, TAU), s = rand(0.3, 1) * speed;
        this.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.5, 1), hue: hue || pick() });
      }
    }

    // ---------- simulation ----------
    step(dt) {
      const p = this.ptr, B = this.bodies, W = this.W, H = this.H;
      // scroll inertia: bodies lag behind the page
      const ds = scrollY - this.lastScroll; this.lastScroll = scrollY;
      const scrollKick = clamp(-ds * 6, -500, 500);

      // gravity well (press & hold on empty space)
      if (p.down && p.wellArmed && !p.grab && performance.now() - p.wellAt > 220) p.well = Math.min(1.6, p.well + dt * 0.9);

      for (const b of B) {
        if (b === p.grab) {
          // spring the grabbed body to the pointer
          const k = 60, c = 12;
          b.vx += ((p.x - b.x) * k - b.vx * c) * dt; b.vy += ((p.y - b.y) * k - b.vy * c) * dt;
          continue;
        }
        // weak mutual gravity (softened)
        for (const o of B) {
          if (o === b) continue;
          const dx = o.x - b.x, dy = o.y - b.y, d2 = dx * dx + dy * dy + 900;
          const f = (0.9 * o.m) / d2;
          const d = Math.sqrt(d2);
          b.vx += (dx / d) * f * dt; b.vy += (dy / d) * f * dt;
        }
        // gravity well with a swirl
        if (p.well > 0) {
          const dx = p.x - b.x, dy = p.y - b.y, d = Math.hypot(dx, dy) + 30;
          const f = (p.well * 520000) / (d * d) + p.well * 40;
          b.vx += ((dx / d) * f + (-dy / d) * f * 0.45) * dt;
          b.vy += ((dy / d) * f + (dx / d) * f * 0.45) * dt;
        }
        // the moving pointer pushes bodies it touches
        if (!p.down && p.t && performance.now() - p.t < 120) {
          const dx = b.x - p.x, dy = b.y - p.y, d = Math.hypot(dx, dy), R = b.r + 26;
          if (d < R && d > 0.01) {
            const push = (R - d) * 30;
            b.vx += (dx / d) * push * dt + p.vx * 0.04 * dt * 10;
            b.vy += (dy / d) * push * dt + p.vy * 0.04 * dt * 10;
          }
        }
        // device tilt + scroll inertia
        b.vx += this.tilt.x * 40 * dt;
        b.vy += this.tilt.y * 40 * dt + scrollKick * dt * (300 / (b.m + 300));
        // keep a gentle cruising speed: slow down fast bodies, nudge still ones
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > b.cruise * 1.2) { const k = Math.max(0, 1 - dt * 0.9); b.vx *= k; b.vy *= k; }
        else if (sp < b.cruise * 0.6) { const a = b.a * 0.3 + b.tilt; b.vx += Math.cos(a) * 6 * dt; b.vy += Math.sin(a) * 6 * dt; }
        b.va *= Math.max(0, 1 - dt * 0.35);
        b.va = clamp(b.va, -8, 8);
      }

      for (const b of B) {
        b.x += b.vx * dt; b.y += b.vy * dt; b.a += b.va * dt;
        b.glow = Math.max(0, b.glow - dt * 1.5);
        // walls
        const e = 0.82;
        if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx) * e; b.va += b.vy * 0.004; }
        if (b.x > W - b.r) { b.x = W - b.r; b.vx = -Math.abs(b.vx) * e; b.va -= b.vy * 0.004; }
        if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * e; b.va -= b.vx * 0.004; }
        if (b.y > H - b.r) { b.y = H - b.r; b.vy = -Math.abs(b.vy) * e; b.va += b.vx * 0.004; }
        // solid page elements (rounded boxes)
        for (const s of this.solids) {
          const cx = clamp(b.x, s.l, s.r), cy = clamp(b.y, s.t, s.b);
          let dx = b.x - cx, dy = b.y - cy, d = Math.hypot(dx, dy);
          if (d >= b.r) continue;
          if (d === 0) { // center inside the box: push out the shortest way
            const pens = [[b.x - s.l, -1, 0], [s.r - b.x, 1, 0], [b.y - s.t, 0, -1], [s.b - b.y, 0, 1]].sort((a, c) => a[0] - c[0])[0];
            dx = pens[1]; dy = pens[2]; d = 1; b.x += dx * (pens[0] + b.r); b.y += dy * (pens[0] + b.r);
          } else { b.x += (dx / d) * (b.r - d); b.y += (dy / d) * (b.r - d); }
          const nx = dx / d, ny = dy / d, vn = b.vx * nx + b.vy * ny;
          if (vn < 0) {
            b.vx -= 1.8 * vn * nx; b.vy -= 1.8 * vn * ny; b.va += (b.vx * ny - b.vy * nx) * 0.01;
            if (-vn > 180) this.burst(b.x - nx * b.r, b.y - ny * b.r, 5, -vn * 0.4);
          }
        }
      }

      // body–body collisions (impulse with restitution + spin transfer)
      for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
        const a = B[i], b = B[j];
        const dx = b.x - a.x, dy = b.y - a.y, R = a.r + b.r, d2 = dx * dx + dy * dy;
        if (d2 >= R * R || d2 === 0) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        const ima = a === p.grab ? 0.0002 : 1 / a.m, imb = b === p.grab ? 0.0002 : 1 / b.m;
        const pen = (R - d) / (ima + imb);
        a.x -= nx * pen * ima; a.y -= ny * pen * ima; b.x += nx * pen * imb; b.y += ny * pen * imb;
        const rvx = b.vx - a.vx, rvy = b.vy - a.vy, vn = rvx * nx + rvy * ny;
        if (vn > 0) continue;
        const jn = (-(1 + 0.86) * vn) / (ima + imb);
        a.vx -= jn * nx * ima; a.vy -= jn * ny * ima; b.vx += jn * nx * imb; b.vy += jn * ny * imb;
        const vt = -rvx * ny + rvy * nx; // tangential slip → spin
        a.va += vt * 0.02 * (b.m / (a.m + b.m)); b.va -= vt * 0.02 * (a.m / (a.m + b.m));
        if (-vn > 90) { this.burst(a.x + nx * a.r, a.y + ny * a.r, Math.min(12, Math.round(-vn / 40)), -vn * 0.5, a.hue); a.glow = b.glow = Math.min(1, -vn / 400); }
      }

      for (const s of this.sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.vx *= 1 - dt * 2; s.vy *= 1 - dt * 2; s.life -= dt * 1.6; }
      this.sparks = this.sparks.filter((s) => s.life > 0);
      for (const w of this.waves) { w.r += dt * 900; w.life -= dt * 1.4; }
      this.waves = this.waves.filter((w) => w.life > 0);
    }

    // ---------- drawing ----------
    draw(dt) {
      const g = this.ctx, W = this.W, H = this.H, R = this.reduce, op = this.o.opacity;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      this.px += (this.tx - this.px) * 0.05; this.py += (this.ty - this.py) * 0.05;

      // stars
      for (const s of this.stars) {
        g.fillStyle = `rgb(${s.hue})`;
        if (!R) {
          s.wob += s.ws * dt;
          const turn = Math.sin(s.wob) * 0.25 * dt, c = Math.cos(turn), n = Math.sin(turn);
          const vx = s.vx * c - s.vy * n; s.vy = s.vx * n + s.vy * c; s.vx = vx;
          s.x += s.vx * dt; s.y += s.vy * dt;
          if (s.x < -20) s.x = W + 20; else if (s.x > W + 20) s.x = -20;
          if (s.y < -20) s.y = H + 20; else if (s.y > H + 20) s.y = -20;
          s.tw += dt * (1 + s.z * 2);
          // stars bend toward an active gravity well
          if (this.ptr.well > 0) {
            const dx = this.ptr.x - s.x, dy = this.ptr.y - s.y, d = Math.hypot(dx, dy) + 40;
            const f = (this.ptr.well * 9000 * (0.3 + s.z)) / d;
            s.x += (dx / d) * f * dt; s.y += (dy / d) * f * dt;
          }
        }
        const ox = this.px * (8 + s.z * 36), oy = this.py * (8 + s.z * 36);
        g.globalAlpha = (0.22 + s.z * 0.6) * (R ? 1 : 0.65 + 0.35 * Math.sin(s.tw));
        g.beginPath(); g.arc(s.x + ox, s.y + oy, s.r, 0, TAU); g.fill();
        if (s.z > 0.86) { g.globalAlpha *= 0.14; g.beginPath(); g.arc(s.x + ox, s.y + oy, s.r * 4, 0, TAU); g.fill(); }
      }

      // shooting stars
      if (!R) {
        if (Math.random() < dt * 0.22 && this.shooters.length < 2) {
          const left = Math.random() < 0.5, sp = rand(700, 1150), ang = (left ? 0.35 : Math.PI - 0.35) + rand(-0.15, 0.15);
          this.shooters.push({ x: left ? rand(0, W * 0.5) : rand(W * 0.5, W), y: rand(0, H * 0.4), vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1 });
        }
        this.shooters = this.shooters.filter((s) => s.life > 0 && s.x > -200 && s.x < W + 200 && s.y < H + 200);
        for (const s of this.shooters) {
          s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt * 0.9;
          const tail = 0.12, gr = g.createLinearGradient(s.x, s.y, s.x - s.vx * tail, s.y - s.vy * tail);
          gr.addColorStop(0, `rgba(255,255,255,${Math.max(s.life, 0)})`); gr.addColorStop(0.3, `rgba(200,200,200,${Math.max(s.life, 0) * 0.6})`); gr.addColorStop(1, "rgba(255,255,255,0)");
          g.globalAlpha = 1; g.strokeStyle = gr; g.lineWidth = 1.5; g.lineCap = "round";
          g.beginPath(); g.moveTo(s.x, s.y); g.lineTo(s.x - s.vx * tail, s.y - s.vy * tail); g.stroke();
        }
      }

      // gravity well
      const p = this.ptr;
      if (p.well > 0) {
        const rr = 26 + p.well * 34;
        const gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr * 2.2);
        gr.addColorStop(0, `rgba(0,0,0,${0.9 * Math.min(1, p.well)})`); gr.addColorStop(0.35, `rgba(255,255,255,${0.28 * p.well})`); gr.addColorStop(0.7, `rgba(200,200,200,${0.08 * p.well})`); gr.addColorStop(1, "rgba(200,200,200,0)");
        g.globalAlpha = 1; g.fillStyle = gr; g.beginPath(); g.arc(p.x, p.y, rr * 2.2, 0, TAU); g.fill();
        g.strokeStyle = `rgba(255,255,255,${0.5 * Math.min(1, p.well)})`; g.lineWidth = 1;
        g.setLineDash([3, 6]); g.lineDashOffset = -performance.now() / 30;
        g.beginPath(); g.arc(p.x, p.y, rr, 0, TAU); g.stroke(); g.setLineDash([]);
      }
      for (const w of this.waves) {
        g.globalAlpha = Math.max(0, w.life) * 0.7; g.strokeStyle = "rgb(255,255,255)"; g.lineWidth = 2;
        g.beginPath(); g.arc(w.x, w.y, w.r, 0, TAU); g.stroke();
      }

      // bodies
      for (const b of this.bodies) {
        g.globalAlpha = op * (0.55 + 0.45 * Math.min(1, b.r / 18));
        if (b.glow > 0) {
          const gr = g.createRadialGradient(b.x, b.y, b.r * 0.8, b.x, b.y, b.r * 2.4);
          gr.addColorStop(0, `rgba(${b.hue},${0.35 * b.glow})`); gr.addColorStop(1, `rgba(${b.hue},0)`);
          g.fillStyle = gr; g.beginPath(); g.arc(b.x, b.y, b.r * 2.4, 0, TAU); g.fill();
        }
        const S = b.img.width / this.dpr;
        if (b.kind === "ringed") this.drawRing(g, b, false);
        g.save(); g.translate(b.x, b.y); g.rotate(b.a); g.drawImage(b.img, -S / 2, -S / 2, S, S); g.restore();
        if (b.shade) g.drawImage(b.shade, b.x - S / 2, b.y - S / 2, S, S);
        // aurora rim light from the lower right
        g.globalCompositeOperation = "lighter";
        const rim = g.createRadialGradient(b.x + b.r * 0.55, b.y + b.r * 0.5, 0, b.x + b.r * 0.4, b.y + b.r * 0.35, b.r * 1.15);
        rim.addColorStop(0, `rgba(${b.hue},.55)`); rim.addColorStop(1, `rgba(${b.hue},0)`);
        g.fillStyle = rim; g.beginPath(); g.arc(b.x, b.y, b.r, 0, TAU); g.fill();
        g.globalCompositeOperation = "source-over";
        if (b.kind === "ringed") this.drawRing(g, b, true);
      }

      for (const s of this.sparks) { g.fillStyle = `rgb(${s.hue})`; g.globalAlpha = Math.max(0, s.life) * op; g.fillRect(s.x - 1, s.y - 1, 2.2, 2.2); }
      g.globalAlpha = 1;
    }
    drawRing(g, b, front) {
      g.save(); g.translate(b.x, b.y); g.rotate(b.tilt + Math.sin(b.a * 0.3) * 0.25);
      g.beginPath();
      g.ellipse(0, 0, b.r * 1.9, b.r * 0.5, 0, front ? 0 : Math.PI, front ? Math.PI : TAU);
      g.strokeStyle = front ? `rgba(${b.hue},.9)` : `rgba(${b.hue},.35)`; g.lineWidth = Math.max(1.2, b.r * 0.12); g.stroke();
      g.restore();
    }

    frame(now) {
      const dt = Math.min((now - this.last) / 1000, 1 / 30); this.last = now;
      if (!document.hidden) {
        if (!this.reduce) { const h = dt / 2; this.step(h); this.step(h); }
        this.draw(dt);
      }
      requestAnimationFrame(this.frame);
    }
  }

  // ---------- Little DOM physics: magnetic buttons + spring tilt cards ----------
  function springs() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !matchMedia("(pointer: fine)").matches) return;
    const items = new Map();
    const get = (el) => items.get(el) || (items.set(el, { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 }), items.get(el));
    addEventListener("pointermove", (e) => {
      for (const el of document.querySelectorAll("[data-magnet],[data-tilt]")) {
        const r = el.getBoundingClientRect(), s = get(el);
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const inside = e.clientX > r.left - 30 && e.clientX < r.right + 30 && e.clientY > r.top - 30 && e.clientY < r.bottom + 30;
        if (el.hasAttribute("data-magnet")) { s.tx = inside ? (e.clientX - cx) * 0.22 : 0; s.ty = inside ? (e.clientY - cy) * 0.3 : 0; }
        else { s.tx = inside ? ((e.clientX - cx) / r.width) * 7 : 0; s.ty = inside ? ((e.clientY - cy) / r.height) * -7 : 0; }
      }
    }, { passive: true });
    let last = performance.now();
    (function tick(now) {
      const dt = Math.min(0.033, (now - last) / 1000); last = now;
      for (const [el, s] of items) {
        s.vx += ((s.tx - s.x) * 180 - s.vx * 14) * dt; s.vy += ((s.ty - s.y) * 180 - s.vy * 14) * dt;
        s.x += s.vx * dt; s.y += s.vy * dt;
        if (!el.isConnected) { items.delete(el); continue; }
        if (Math.abs(s.x) < 0.01 && Math.abs(s.y) < 0.01 && !s.tx && !s.ty) { el.style.transform = ""; continue; }
        el.style.transform = el.hasAttribute("data-magnet")
          ? `translate(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px)`
          : `perspective(900px) rotateY(${s.x.toFixed(2)}deg) rotateX(${s.y.toFixed(2)}deg)`;
      }
      requestAnimationFrame(tick);
    })(last);
  }

  // ---------- Dock magnification (like the macOS dock): items near the pointer grow on springs ----------
  function dock() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !matchMedia("(pointer: fine)").matches) return;
    const docks = () => [...document.querySelectorAll("[data-dock]")];
    const state = new Map();
    let py = -1e4, px = -1e4;
    addEventListener("pointermove", (e) => { px = e.clientX; py = e.clientY; }, { passive: true });
    let last = performance.now();
    (function tick(now) {
      const dt = Math.min(0.033, (now - last) / 1000); last = now;
      for (const d of docks()) {
        const r = d.getBoundingClientRect();
        const over = px > r.left - 20 && px < r.right + 60 && py > r.top && py < r.bottom;
        for (const el of d.querySelectorAll(":scope > a, :scope > button")) {
          const s = state.get(el) || { v: 1, vel: 0 }; state.set(el, s);
          const er = el.getBoundingClientRect(), cy = er.top + er.height / 2;
          const dist = Math.abs(py - cy), target = over ? 1 + 0.42 * Math.max(0, 1 - dist / 120) : 1;
          s.vel += ((target - s.v) * 260 - s.vel * 20) * dt; s.v += s.vel * dt;
          el.style.transform = Math.abs(s.v - 1) < 0.002 ? "" : `scale(${s.v.toFixed(3)})`;
        }
      }
      requestAnimationFrame(tick);
    })(last);
  }

  // ---------- Animated logo: the moon orbits and dips behind the planet; rings react to the pointer ----------
  function logo(el, size = 28) {
    const NS = "http://www.w3.org/2000/svg";
    const id = "x" + Math.random().toString(36).slice(2, 7);
    el.innerHTML = `<svg viewBox="0 0 64 64" width="${size}" height="${size}" fill="none" aria-hidden="true">
      <defs><radialGradient id="${id}p" cx="34%" cy="30%" r="78%"><stop offset="0" stop-color="#fff"/><stop offset=".38" stop-color="#e2e2e2"/><stop offset=".72" stop-color="#6b6b6b"/><stop offset="1" stop-color="#161616"/></radialGradient></defs>
      <g class="rb"></g><circle class="mb" r="2.7" fill="#fff"/><circle cx="32" cy="32" r="14.5" fill="url(#${id}p)"/><g class="rf"></g><circle class="mf" r="2.7" fill="#fff"/></svg>`;
    const svg = el.firstElementChild, rb = svg.querySelector(".rb"), rf = svg.querySelector(".rf");
    const mb = svg.querySelector(".mb"), mf = svg.querySelector(".mf");
    const rx = 29, ry = 8.6;
    const arc = (deg, front) => {
      // half-ellipse path in the ring's own frame, rotated by deg
      const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const P = (t) => { const x = rx * Math.cos(t), y = ry * Math.sin(t); return `${(32 + x * c - y * s).toFixed(2)} ${(32 + x * s + y * c).toFixed(2)}`; };
      const pts = []; for (let i = 0; i <= 24; i++) pts.push(P((front ? 0 : Math.PI) + (i / 24) * Math.PI));
      return "M" + pts.join(" L");
    };
    let spin = 0, vspin = 0, t = Math.random() * 6;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.addEventListener("pointerenter", () => (vspin += 140));
    el.addEventListener("click", () => (vspin += 260));
    let last = performance.now();
    (function tick(now) {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (!reduce) { vspin += (-spin * 30 - vspin * 5) * dt; spin += vspin * dt; t += dt * 0.9; }
      const A = -30 + spin * 0.12, Bd = 30 - spin * 0.12;
      rb.innerHTML = `<path d="${arc(A, false)}" stroke="#fff" stroke-opacity=".55" stroke-width="2.2" stroke-linecap="round"/><path d="${arc(Bd, false)}" stroke="#fff" stroke-opacity=".55" stroke-width="2.2" stroke-linecap="round"/>`;
      rf.innerHTML = [A, Bd].map((d) => `<path d="${arc(d, true)}" stroke="#000" stroke-width="6"/><path d="${arc(d, true)}" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`).join("");
      // moon on its own tilted orbit
      const a = (-58 * Math.PI) / 180, x = 25 * Math.cos(t), y = 7 * Math.sin(t);
      const mx = 32 + x * Math.cos(a) - y * Math.sin(a), my = 32 + x * Math.sin(a) + y * Math.cos(a);
      const front = Math.sin(t) > 0;
      (front ? mf : mb).setAttribute("cx", mx.toFixed(2)); (front ? mf : mb).setAttribute("cy", my.toFixed(2));
      (front ? mf : mb).style.opacity = 1; (front ? mb : mf).style.opacity = 0;
      if (el.isConnected) requestAnimationFrame(tick);
    })(last);
  }

  window.X09Space = {
    start(opts) { const s = new Space(opts); springs(); dock(); window.X09Space.instance = s; return s; },
    logo,
  };
})();
