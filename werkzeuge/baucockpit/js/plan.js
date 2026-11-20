/* Baucockpit – Grundriss-Editor (Wände, Öffnungen, Räume, Möblierung) */
(function () {
  const { G } = Geo;
  const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const FURN = {
    bett: { name: 'Doppelbett', w: 1.8, d: 2.05, h: 0.5 },
    bett1: { name: 'Einzelbett', w: 1.0, d: 2.05, h: 0.5 },
    sofa: { name: 'Sofa', w: 2.4, d: 0.95, h: 0.8 },
    tisch: { name: 'Esstisch', w: 1.9, d: 0.95, h: 0.75 },
    kueche: { name: 'Küchenzeile', w: 3.6, d: 0.65, h: 0.9 },
    insel: { name: 'Kochinsel', w: 2.2, d: 1.0, h: 0.9 },
    schrank: { name: 'Schrank', w: 2.0, d: 0.6, h: 2.2 },
    wc: { name: 'WC', w: 0.4, d: 0.65, h: 0.42 },
    lavabo: { name: 'Lavabo', w: 0.65, d: 0.48, h: 0.85 },
    dusche: { name: 'Dusche', w: 0.9, d: 1.2, h: 0.05 },
    wanne: { name: 'Badewanne', w: 1.7, d: 0.75, h: 0.55 },
    treppe: { name: 'Treppe', w: 1.1, d: 4.2, h: 3.0 },
    auto: { name: 'Auto (Garage)', w: 1.9, d: 4.7, h: 1.5 },
    wm: { name: 'Waschm./Tumbler', w: 0.65, d: 0.65, h: 1.8 },
    couchtisch: { name: 'Salontisch', w: 1.1, d: 0.6, h: 0.4 },
    sessel: { name: 'Sessel', w: 0.85, d: 0.85, h: 0.8 },
    sideboard: { name: 'Sideboard', w: 1.8, d: 0.45, h: 0.8 },
    schreibtisch: { name: 'Schreibtisch', w: 1.4, d: 0.7, h: 0.75 },
    garderobe: { name: 'Garderobe', w: 1.6, d: 0.45, h: 2.1 },
    regal: { name: 'Regal', w: 1.6, d: 0.5, h: 2.0 },
    lift: { name: 'Lift', w: 1.6, d: 1.6, h: 2.4 }
  };

  const DEFAULT_PROGRAM = [
    ['Entrée / Garderobe', 8, 'EG', 'VF'], ['Wohnen / Essen', 38, 'EG', 'HNF'], ['Küche', 12, 'EG', 'HNF'], ['Dusche / WC', 4.5, 'EG', 'HNF'],
    ['Reduit', 4, 'EG', 'NNF'], ['Elternzimmer', 15, '1. OG', 'HNF'], ['Zimmer 1', 12, '1. OG', 'HNF'], ['Zimmer 2', 12, '1. OG', 'HNF'],
    ['Bad', 8, '1. OG', 'HNF'], ['Ankleide', 5, '1. OG', 'NNF'], ['Technik / Waschen', 8, 'EG', 'FF'], ['Garage (2 PP)', 36, 'EG', 'NNF']
  ].map(([name, area, level, use]) => ({ id: uid('r'), name, area, level, use }));

  function emptyPlan() { return { levels: [{ id: 'L0', name: 'EG', z: 0, h: 3.0, outline: null }], walls: [], openings: [], rooms: [], furniture: [] }; }

  /** Grundriss aus Variante ableiten: Aussenwände + Geschosse */
  function planFromVariant(project, v) {
    const allPoly = G.union(v.parts.map(p => p.poly)); const fp = allPoly.sort((a, b) => G.absArea(b) - G.absArea(a))[0] || v.parts[0].poly;
    const c = G.centroid(fp); const rot = v.angle || 0;
    const base0 = Math.min(...v.parts.map(p => p.base));
    const r6 = x => Math.round(x * 1e4) / 1e4;
    const toLocal = poly => G.ensureCCW(poly.map(p => G.rotate([p[0] - c[0], p[1] - c[1]], -rot)).map(q => [r6(q[0]), r6(q[1])]));
    const lvMap = [];
    const addL = (z, poly, extra) => { z = Math.round(z * 100) / 100; let L = lvMap.find(l => Math.abs(l.z - z) < 0.05); if (!L) { L = { z, polys: [], h: v.fh }; lvMap.push(L); } L.polys.push(poly); Object.assign(L, extra || {}); if (extra && extra.roof) (L.roofPolys = L.roofPolys || []).push(poly); return L; };
    for (const p of v.parts) {
      for (let f = 0; f < p.nf; f++) addL(p.base - base0 + f * v.fh, toLocal(p.poly), p.attika ? { attika: true } : null);
      if (p.roof) addL(p.base - base0 + p.nf * v.fh, toLocal(p.poly), { roof: { ...p.roof }, h: (p.roof.kn || 1) + roofRiseLocal(p) });
    }
    lvMap.sort((a, b) => a.z - b.z);
    const plan = { levels: [], walls: [], openings: [], rooms: [], furniture: [] };
    const addWalls = (id, outline, t) => { for (const o of outline) { const axis = G.offset(o, -t / 2)[0] || o; for (let k = 0; k < axis.length; k++) plan.walls.push({ id: uid('w'), level: id, a: axis[k], b: axis[(k + 1) % axis.length], t, ext: true }); } };
    if (v.ug) {
      const eg = lvMap[0]; const outline = G.union(eg.polys).map(G.ensureCCW);
      plan.levels.push({ id: 'LU', name: 'UG', z: -Engine.UG_H, h: Engine.UG_H, outline, ug: true }); addWalls('LU', outline, 0.30);
    }
    let og = 0;
    lvMap.forEach((L, i) => {
      const isFull = Math.abs(L.z / v.fh - Math.round(L.z / v.fh)) < 0.05;
      let name = i === 0 ? 'EG' : isFull ? `${Math.round(L.z / v.fh)}. OG` : `Ebene +${L.z.toFixed(2)}`;
      if (L.attika) name = 'Attika'; if (L.roof) name = 'DG';
      let nn = name, k = 2; while (plan.levels.some(x => x.name === nn)) nn = `${name} ${k++}`; name = nn;
      const outline = G.union(L.polys).map(G.ensureCCW);
      const id = 'L' + i;
      const lv = { id, name, z: L.z, h: L.h, outline };
      if (L.roof) { lv.roof = L.roof; lv.roofRects = (L.roofPolys || L.polys).flatMap(pl => G.rectDecompose(pl)); }
      plan.levels.push(lv); addWalls(id, outline, 0.35);
    });
    project.placement = { E: c[0], N: c[1], rot, base: base0 };
    project.plan = plan;
    project.planFromVariant = v.id;
    return plan;
  }
  function roofRiseLocal(p) { return Engine.roofRise(p); }
  /** Dachhöhe über DG-Boden an lokalem Punkt (Steildach) */
  function roofHeightAt(level, pt) {
    if (!level.roof || !level.roofRects) return level.h;
    const tan = Math.tan((level.roof.pitch || 30) * Math.PI / 180); const kn = level.roof.kn || 1; let best = -Infinity;
    for (const r of level.roofRects) {
      const [x0, y0, x1, y1] = r; if (pt[0] < x0 - 0.4 || pt[0] > x1 + 0.4 || pt[1] < y0 - 0.4 || pt[1] > y1 + 0.4) continue;
      const alongX = (x1 - x0) >= (y1 - y0); // First parallel zur langen Seite
      const span = alongX ? (y1 - y0) : (x1 - x0); const d = alongX ? pt[1] - y0 : pt[0] - x0;
      const h = level.roof.type === 'pult' ? kn + Math.max(0, Math.min(span, d)) * tan : kn + (span / 2 - Math.abs(Math.max(0, Math.min(span, d)) - span / 2)) * tan;
      best = Math.max(best, h);
    }
    return best === -Infinity ? (level.roof.kn || 1) : best;
  }

  /* ================= Editor ================= */
  class PlanEditor {
    constructor(canvas, app) {
      this.cv = canvas; this.ctx = canvas.getContext('2d'); this.app = app;
      this.scale = 40; this.off = [0, 0]; this.tool = 'select'; this.levelId = null; this.sel = null; this.draft = null;
      this.snap = 0.05; this.furnType = 'bett'; this.mouse = [0, 0]; this.hover = null; this.dragging = null;
      this.ac = new AbortController(); this._bind(); this.resize();
      this.ro = new ResizeObserver(() => { this.resize(); this.draw(); }); this.ro.observe(canvas.parentElement);
    }
    destroy() { this.ac.abort(); this.ro.disconnect(); }
    get project() { return this.app.project; }
    get plan() { return this.project.plan; }
    get level() { return this.plan.levels.find(l => l.id === this.levelId) || this.plan.levels[0]; }
    resize() {
      const r = this.cv.parentElement.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
      this.cv.width = Math.max(100, r.width * dpr); this.cv.height = Math.max(100, r.height * dpr);
      this.cv.style.width = r.width + 'px'; this.cv.style.height = r.height + 'px'; this.dpr = dpr;
    }
    fit() {
      const pts = [];
      for (const w of this.plan.walls) pts.push(w.a, w.b);
      for (const r of this.plan.rooms) pts.push(...r.poly);
      for (const l of this.plan.levels) for (const o of l.outline || []) pts.push(...o);
      if (!pts.length) { this.scale = 40; this.off = [this.cv.width / 2, this.cv.height / 2]; return this.draw(); }
      const bb = G.bbox(pts); const w = bb[2] - bb[0] + 4, h = bb[3] - bb[1] + 4;
      this.scale = Math.min(this.cv.width / w, this.cv.height / h);
      this.off = [this.cv.width / 2 - (bb[0] + bb[2]) / 2 * this.scale, this.cv.height / 2 + (bb[1] + bb[3]) / 2 * this.scale];
      this.draw();
    }
    w2s(p) { return [this.off[0] + p[0] * this.scale, this.off[1] - p[1] * this.scale]; }
    s2w(x, y) { return [(x - this.off[0]) / this.scale, (this.off[1] - y) / this.scale]; }
    snapPt(p, from, ortho) {
      // Endpunkt-Fang
      const tolW = 12 * this.dpr / this.scale; let best = null;
      for (const w of this.plan.walls.filter(w => w.level === this.level.id)) for (const q of [w.a, w.b]) { const d = G.dist(p, q); if (d < tolW && (!best || d < best.d)) best = { d, q }; }
      for (const o of this.level.outline || []) for (const q of o) { const d = G.dist(p, q); if (d < tolW && (!best || d < best.d)) best = { d, q }; }
      if (best) { this.snapInfo = 'Endpunkt'; return best.q.slice(); }
      this.snapInfo = '';
      let q = p.slice();
      if (from && ortho) {
        const dx = q[0] - from[0], dy = q[1] - from[1]; const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4); const L = Math.hypot(dx, dy);
        q = [from[0] + Math.cos(ang) * L, from[1] + Math.sin(ang) * L]; this.snapInfo = 'Ortho';
      }
      const s = this.snap; return [Math.round(q[0] / s) * s, Math.round(q[1] / s) * s];
    }
    _bind() {
      const cv = this.cv;
      cv.addEventListener('wheel', e => {
        e.preventDefault(); const r = cv.getBoundingClientRect(); const x = (e.clientX - r.left) * this.dpr, y = (e.clientY - r.top) * this.dpr;
        const wp = this.s2w(x, y); const f = Math.exp(-e.deltaY * 0.0015); this.scale = Math.max(4, Math.min(400, this.scale * f));
        this.off = [x - wp[0] * this.scale, y + wp[1] * this.scale]; this.draw();
      }, { passive: false });
      cv.addEventListener('contextmenu', e => e.preventDefault());
      cv.addEventListener('mousedown', e => this._down(e));
      const sig = { signal: this.ac.signal };
      window.addEventListener('mousemove', e => this._move(e), sig);
      window.addEventListener('mouseup', e => this._up(e), sig);
      cv.addEventListener('dblclick', e => { if (this.tool === 'room' && this.draft && this.draft.pts.length >= 3) this._finishRoom(); });
      window.addEventListener('keydown', e => {
        if (!this.cv.isConnected || this.cv.offsetParent === null) return;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
        if (e.key === 'Escape') { if (this.tool === 'room' && this.draft && this.draft.pts.length >= 3) this._finishRoom(); this.draft = null; this.draw(); }
        if (e.key === 'Enter' && this.tool === 'room' && this.draft) this._finishRoom();
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) { this.deleteSel(); e.preventDefault(); }
        if (e.key === 'r' && this.sel && this.sel.kind === 'furn') { this.sel.obj.rot = ((this.sel.obj.rot || 0) + 90) % 360; this.changed(); }
        const keys = { v: 'select', w: 'wall', i: 'iwall', m: 'room', t: 'door', f: 'window', p: 'furn' };
        if (!e.ctrlKey && keys[e.key]) this.app.setPlanTool(keys[e.key]);
      }, sig);
    }
    _ev(e) { const r = this.cv.getBoundingClientRect(); return [(e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr]; }
    _down(e) {
      const [sx, sy] = this._ev(e); const wp = this.s2w(sx, sy);
      if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) { this.dragging = { pan: true, sx, sy, off: this.off.slice() }; return; }
      const lv = this.level.id;
      if (this.tool === 'select') {
        const hit = this.pick(wp);
        this.sel = hit; this.app.onPlanSelect(hit);
        if (hit) this.dragging = { obj: hit, start: wp, snapshot: JSON.parse(JSON.stringify(hit.obj)) };
        this.draw(); return;
      }
      if (this.tool === 'wall' || this.tool === 'iwall') {
        const p = this.snapPt(wp, this.draft && this.draft.last, e.shiftKey);
        if (!this.draft) this.draft = { last: p };
        else {
          if (G.dist(this.draft.last, p) > 0.05) this.plan.walls.push({ id: uid('w'), level: lv, a: this.draft.last, b: p, t: this.tool === 'wall' ? 0.35 : 0.12, ext: this.tool === 'wall' });
          this.draft.last = p; this.changed(true);
        }
        this.draw(); return;
      }
      if (this.tool === 'room') {
        const p = this.snapPt(wp, this.draft && this.draft.pts[this.draft.pts.length - 1], e.shiftKey);
        if (!this.draft) this.draft = { pts: [p] };
        else if (G.dist(p, this.draft.pts[0]) < 0.2 && this.draft.pts.length >= 3) this._finishRoom();
        else this.draft.pts.push(p);
        this.draw(); return;
      }
      if (this.tool === 'roomrect') { const p = this.snapPt(wp); this.draft = { rect: [p, p] }; this.dragging = { rect: true }; return; }
      if (this.tool === 'door' || this.tool === 'window') {
        const w = this.nearestWall(wp, 0.6); if (!w) return this.app.toast('Auf eine Wand klicken');
        const c = G.closestOnSeg(wp, w.a, w.b); const L = G.dist(w.a, w.b);
        const isDoor = this.tool === 'door';
        const width = isDoor ? (w.ext ? 1.0 : 0.9) : 1.4;
        const pos = Math.max(width / 2 / L, Math.min(1 - width / 2 / L, c.t));
        const o = { id: uid('o'), wall: w.id, pos, w: width, h: isDoor ? 2.1 : 1.5, sill: isDoor ? 0 : 0.9, type: isDoor ? 'door' : 'window', flip: false, hinge: false };
        this.plan.openings.push(o); this.sel = { kind: 'opening', obj: o }; this.app.onPlanSelect(this.sel); this.changed(); return;
      }
      if (this.tool === 'furn') {
        const p = this.snapPt(wp); const f = { id: uid('f'), level: lv, type: this.furnType, x: p[0], y: p[1], rot: 0 };
        this.plan.furniture.push(f); this.sel = { kind: 'furn', obj: f }; this.app.onPlanSelect(this.sel); this.changed(); return;
      }
    }
    _move(e) {
      if (!this.cv.isConnected) return;
      const [sx, sy] = this._ev(e); const wp = this.s2w(sx, sy); this.mouse = wp;
      const d = this.dragging;
      if (d && d.pan) { this.off = [d.off[0] + sx - d.sx, d.off[1] + sy - d.sy]; return this.draw(); }
      if (d && d.rect) { this.draft.rect[1] = this.snapPt(wp); return this.draw(); }
      if (d && d.obj) {
        const dx = wp[0] - d.start[0], dy = wp[1] - d.start[1]; const s = this.snap; const sdx = Math.round(dx / s) * s, sdy = Math.round(dy / s) * s;
        const o = d.obj.obj, sn = d.snapshot;
        if (d.obj.kind === 'furn') { o.x = sn.x + sdx; o.y = sn.y + sdy; }
        else if (d.obj.kind === 'room') o.poly = sn.poly.map(p => [p[0] + sdx, p[1] + sdy]);
        else if (d.obj.kind === 'wall') {
          if (d.obj.end === 'a') o.a = this.snapPt(wp, o.b, e.shiftKey); else if (d.obj.end === 'b') o.b = this.snapPt(wp, o.a, e.shiftKey);
          else { o.a = [sn.a[0] + sdx, sn.a[1] + sdy]; o.b = [sn.b[0] + sdx, sn.b[1] + sdy]; }
        } else if (d.obj.kind === 'opening') {
          const w = this.plan.walls.find(w => w.id === o.wall); if (w) { const c = G.closestOnSeg(wp, w.a, w.b); const L = G.dist(w.a, w.b); o.pos = Math.max(o.w / 2 / L, Math.min(1 - o.w / 2 / L, c.t)); }
        }
        d.moved = true; return this.draw();
      }
      this.draw();
    }
    _up(e) {
      const d = this.dragging; this.dragging = null;
      if (d && d.rect && this.draft) {
        const [a, b] = this.draft.rect; this.draft = null;
        if (Math.abs(a[0] - b[0]) > 0.3 && Math.abs(a[1] - b[1]) > 0.3) {
          const poly = G.ensureCCW([[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]);
          const r = { id: uid('rm'), level: this.level.id, name: this.app.nextRoomName ? this.app.nextRoomName() : 'Raum', poly, use: 'HNF' };
          this.plan.rooms.push(r); this.sel = { kind: 'room', obj: r }; this.app.onPlanSelect(this.sel); this.changed();
        }
        this.draw();
      }
      if (d && d.obj && d.moved) { this.changed(); this.app.onPlanSelect(this.sel); }
    }
    _finishRoom() {
      const pts = this.draft.pts; this.draft = null;
      const r = { id: uid('rm'), level: this.level.id, name: this.app.nextRoomName ? this.app.nextRoomName() : 'Raum', poly: G.ensureCCW(pts), use: 'HNF' };
      this.plan.rooms.push(r); this.sel = { kind: 'room', obj: r }; this.app.onPlanSelect(this.sel); this.changed();
    }
    nearestWall(p, tol) {
      let best = null;
      for (const w of this.plan.walls.filter(w => w.level === this.level.id)) { const d = G.segDist(p, w.a, w.b); if (d < Math.max(tol, w.t / 2 + 0.05) && (!best || d < best.d)) best = { d, w }; }
      return best && best.w;
    }
    pick(p) {
      const lv = this.level.id; const tol = 8 * this.dpr / this.scale;
      for (const o of this.plan.openings) {
        const w = this.plan.walls.find(w => w.id === o.wall); if (!w || w.level !== lv) continue;
        const c = [w.a[0] + (w.b[0] - w.a[0]) * o.pos, w.a[1] + (w.b[1] - w.a[1]) * o.pos];
        if (G.dist(p, c) < Math.max(o.w / 2, tol)) return { kind: 'opening', obj: o };
      }
      for (const f of this.plan.furniture.filter(f => f.level === lv).slice().reverse()) if (G.pointInPoly(p, furnPoly(f))) return { kind: 'furn', obj: f };
      for (const w of this.plan.walls.filter(w => w.level === lv)) {
        if (G.dist(p, w.a) < tol) return { kind: 'wall', obj: w, end: 'a' };
        if (G.dist(p, w.b) < tol) return { kind: 'wall', obj: w, end: 'b' };
        if (G.segDist(p, w.a, w.b) < w.t / 2 + tol * 0.5) return { kind: 'wall', obj: w };
      }
      for (const r of this.plan.rooms.filter(r => r.level === lv).slice().reverse()) if (G.pointInPoly(p, r.poly)) return { kind: 'room', obj: r };
      return null;
    }
    deleteSel() {
      const s = this.sel; if (!s) return; const P = this.plan;
      if (s.kind === 'wall') { P.walls = P.walls.filter(w => w !== s.obj); P.openings = P.openings.filter(o => o.wall !== s.obj.id); }
      if (s.kind === 'room') P.rooms = P.rooms.filter(r => r !== s.obj);
      if (s.kind === 'furn') P.furniture = P.furniture.filter(f => f !== s.obj);
      if (s.kind === 'opening') P.openings = P.openings.filter(o => o !== s.obj);
      this.sel = null; this.app.onPlanSelect(null); this.changed();
    }
    changed(quiet) { this.app.markDirty('plan'); this.draw(); if (!quiet) this.app.refreshPlanSide && this.app.refreshPlanSide(); }

    /* ---------- Zeichnen ---------- */
    draw() { if (this._raf) return; this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); }); }
    _draw() {
      const ctx = this.ctx, cv = this.cv; if (!this.plan) return;
      const css = getComputedStyle(document.documentElement);
      const col = n => css.getPropertyValue(n).trim();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = col('--plan-bg'); ctx.fillRect(0, 0, cv.width, cv.height);
      // Raster
      const step = this.scale > 60 ? 0.5 : this.scale > 15 ? 1 : 5;
      const tl = this.s2w(0, 0), br = this.s2w(cv.width, cv.height);
      ctx.lineWidth = 1;
      for (let x = Math.floor(tl[0] / step) * step; x < br[0]; x += step) { const s = this.w2s([x, 0])[0]; ctx.strokeStyle = Math.abs(x % 5) < 1e-6 ? col('--plan-grid2') : col('--plan-grid'); ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(s, cv.height); ctx.stroke(); }
      for (let y = Math.floor(br[1] / step) * step; y < tl[1]; y += step) { const s = this.w2s([0, y])[1]; ctx.strokeStyle = Math.abs(y % 5) < 1e-6 ? col('--plan-grid2') : col('--plan-grid'); ctx.beginPath(); ctx.moveTo(0, s); ctx.lineTo(cv.width, s); ctx.stroke(); }
      const lv = this.level; const P = this.plan;
      const path = poly => { ctx.beginPath(); poly.forEach((p, i) => { const s = this.w2s(p); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); }); ctx.closePath(); };
      // darunterliegendes Geschoss (Ghost)
      const below = P.levels.filter(l => l.z < lv.z).sort((a, b) => b.z - a.z)[0];
      if (below) { ctx.strokeStyle = col('--plan-ghost'); ctx.lineWidth = 1 * this.dpr; ctx.setLineDash([4 * this.dpr, 4 * this.dpr]); for (const w of P.walls.filter(w => w.level === below.id)) { const a = this.w2s(w.a), b = this.w2s(w.b); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); } ctx.setLineDash([]); }
      // Umriss Geschoss (aus Variante)
      for (const o of lv.outline || []) { path(o); ctx.strokeStyle = col('--accent'); ctx.lineWidth = 1 * this.dpr; ctx.setLineDash([8 * this.dpr, 4 * this.dpr]); ctx.stroke(); ctx.setLineDash([]); }
      // Räume
      ctx.font = `${12 * this.dpr}px system-ui, Segoe UI, sans-serif`; ctx.textAlign = 'center';
      for (const r of P.rooms.filter(r => r.level === lv.id)) {
        path(r.poly); ctx.fillStyle = this.sel && this.sel.obj === r ? col('--room-sel') : roomColor(r.use, col); ctx.fill();
        const c = this.w2s(G.centroid(r.poly)); ctx.fillStyle = col('--ink');
        ctx.font = `600 ${12 * this.dpr}px system-ui, Segoe UI, sans-serif`; ctx.fillText(r.name, c[0], c[1] - 3 * this.dpr);
        ctx.font = `${11 * this.dpr}px system-ui, Segoe UI, sans-serif`; ctx.fillStyle = col('--muted'); ctx.fillText(Engine.fmtN(G.absArea(r.poly), 1) + ' m²', c[0], c[1] + 12 * this.dpr);
      }
      // Wände
      for (const w of P.walls.filter(w => w.level === lv.id)) {
        const poly = wallPoly(w); path(poly);
        ctx.fillStyle = this.sel && this.sel.obj === w ? col('--accent') : (w.ext ? col('--wall') : col('--wall2')); ctx.fill();
      }
      // Öffnungen
      for (const o of P.openings) {
        const w = P.walls.find(w => w.id === o.wall); if (!w || w.level !== lv.id) continue;
        this._drawOpening(o, w, col);
      }
      // Möbel
      for (const f of P.furniture.filter(f => f.level === lv.id)) {
        const poly = furnPoly(f); path(poly); ctx.fillStyle = col('--furn-fill'); ctx.fill();
        ctx.strokeStyle = this.sel && this.sel.obj === f ? col('--accent') : col('--furn'); ctx.lineWidth = 1.2 * this.dpr; ctx.stroke();
        this._furnSymbol(f, col);
      }
      // Auswahl-Masse Wand
      if (this.sel && this.sel.kind === 'wall') this._dim(this.sel.obj.a, this.sel.obj.b, col, 0.6);
      // Entwurf
      if (this.draft) {
        ctx.strokeStyle = col('--accent'); ctx.lineWidth = 2 * this.dpr;
        if (this.draft.last) { const p = this.snapPt(this.mouse, this.draft.last, window.event && window.event.shiftKey); const a = this.w2s(this.draft.last), b = this.w2s(p); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); this._dim(this.draft.last, p, col, 0.5); }
        if (this.draft.pts) { const pts = [...this.draft.pts, this.snapPt(this.mouse)]; ctx.beginPath(); pts.forEach((p, i) => { const s = this.w2s(p); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); }); ctx.stroke(); }
        if (this.draft.rect) { const [a, b] = this.draft.rect; path([[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]); ctx.stroke(); ctx.fillStyle = col('--ink'); const c = this.w2s([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); ctx.fillText(`${Engine.fmtN(Math.abs(b[0] - a[0]), 2)} × ${Engine.fmtN(Math.abs(b[1] - a[1]), 2)} = ${Engine.fmtN(Math.abs((b[0] - a[0]) * (b[1] - a[1])), 1)} m²`, c[0], c[1]); }
      }
      // Nordpfeil
      const rot = (this.project.placement && this.project.placement.rot) || 0;
      const nx = cv.width - 40 * this.dpr, ny = 46 * this.dpr, ang = -rot; // Nord in lokalen Koordinaten
      ctx.save(); ctx.translate(nx, ny); ctx.rotate(ang); ctx.fillStyle = col('--ink');
      ctx.beginPath(); ctx.moveTo(0, -22 * this.dpr); ctx.lineTo(8 * this.dpr, 10 * this.dpr); ctx.lineTo(0, 4 * this.dpr); ctx.lineTo(-8 * this.dpr, 10 * this.dpr); ctx.closePath(); ctx.fill();
      ctx.font = `700 ${11 * this.dpr}px system-ui`; ctx.fillText('N', 0, -26 * this.dpr); ctx.restore();
      // Statuszeile
      const info = document.getElementById('plan-status');
      if (info) info.textContent = `x ${Engine.fmtN(this.mouse[0], 2)}  y ${Engine.fmtN(this.mouse[1], 2)}  ·  Raster ${this.snap} m${this.snapInfo ? '  ·  Fang: ' + this.snapInfo : ''}`;
    }
    _dim(a, b, col, off) {
      const ctx = this.ctx; const L = G.dist(a, b); if (L < 0.01) return;
      const n = [-(b[1] - a[1]) / L * off, (b[0] - a[0]) / L * off];
      const A = this.w2s([a[0] + n[0], a[1] + n[1]]), B = this.w2s([b[0] + n[0], b[1] + n[1]]);
      ctx.strokeStyle = col('--dim'); ctx.lineWidth = 1 * this.dpr; ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
      ctx.fillStyle = col('--dim'); ctx.font = `600 ${11 * this.dpr}px system-ui`; ctx.textAlign = 'center';
      ctx.fillText(Engine.fmtN(L, 2), (A[0] + B[0]) / 2, (A[1] + B[1]) / 2 - 4 * this.dpr);
    }
    _drawOpening(o, w, col) {
      const ctx = this.ctx; const L = G.dist(w.a, w.b); const u = [(w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L]; const n = [-u[1], u[0]];
      const c = [w.a[0] + u[0] * L * o.pos, w.a[1] + u[1] * L * o.pos]; const hw = o.w / 2, ht = w.t / 2 + 0.01;
      const P = (s, t) => this.w2s([c[0] + u[0] * s + n[0] * t, c[1] + u[1] * s + n[1] * t]);
      const q = [P(-hw, -ht), P(hw, -ht), P(hw, ht), P(-hw, ht)];
      ctx.beginPath(); q.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--plan-bg'); ctx.fill();
      const sel = this.sel && this.sel.obj === o; ctx.strokeStyle = sel ? col('--accent') : col('--ink'); ctx.lineWidth = 1.2 * this.dpr;
      if (o.kind === 'garage') { ctx.beginPath(); const a = P(-hw, 0), b = P(hw, 0); ctx.setLineDash([6 * this.dpr, 4 * this.dpr]); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]); return; }
      if (o.type === 'window') {
        ctx.beginPath(); const a = P(-hw, 0), b = P(hw, 0); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        const a2 = P(-hw, -ht * 0.5), b2 = P(hw, -ht * 0.5); ctx.moveTo(a2[0], a2[1]); ctx.lineTo(b2[0], b2[1]); ctx.stroke();
        ctx.beginPath(); [[-hw, -ht], [-hw, ht]].forEach(() => {}); const e1 = P(-hw, -ht), e2 = P(-hw, ht), e3 = P(hw, -ht), e4 = P(hw, ht);
        ctx.moveTo(e1[0], e1[1]); ctx.lineTo(e2[0], e2[1]); ctx.moveTo(e3[0], e3[1]); ctx.lineTo(e4[0], e4[1]); ctx.stroke();
      } else {
        const side = o.flip ? -1 : 1, hs = o.hinge ? 1 : -1;
        const hinge = P(hs * hw, side * ht), tip = P(hs * hw, side * (ht + o.w));
        ctx.beginPath(); ctx.moveTo(hinge[0], hinge[1]); ctx.lineTo(tip[0], tip[1]); ctx.stroke();
        // Bogen
        ctx.beginPath(); const steps = 16; for (let i = 0; i <= steps; i++) { const a = (i / steps) * Math.PI / 2; const s = hs * hw - hs * Math.sin(a) * o.w, t = side * (ht + Math.cos(a) * o.w); const p = P(s, t); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }
        ctx.setLineDash([3 * this.dpr, 3 * this.dpr]); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    _furnSymbol(f, col) {
      const ctx = this.ctx; const d = FURN[f.type]; if (!d) return;
      const c = this.w2s([f.x, f.y]); ctx.save(); ctx.translate(c[0], c[1]); ctx.rotate(-(f.rot || 0) * Math.PI / 180);
      const s = this.scale; ctx.strokeStyle = col('--furn'); ctx.lineWidth = 1 * this.dpr;
      const W = d.w * s, D = d.d * s;
      ctx.beginPath();
      if (f.type === 'bett' || f.type === 'bett1') { ctx.rect(-W / 2 + 4, -D / 2 + 4, W - 8, D * 0.18); }
      else if (f.type === 'treppe') { const n = 14; for (let i = 1; i < n; i++) { const y = -D / 2 + i * D / n; ctx.moveTo(-W / 2, y); ctx.lineTo(W / 2, y); } ctx.moveTo(0, D / 2); ctx.lineTo(0, -D / 2 + 6); ctx.lineTo(-5, -D / 2 + 14); ctx.moveTo(0, -D / 2 + 6); ctx.lineTo(5, -D / 2 + 14); }
      else if (f.type === 'wc') { ctx.ellipse(0, D * 0.1, W * 0.4, D * 0.3, 0, 0, Math.PI * 2); }
      else if (f.type === 'lavabo' || f.type === 'wanne') { ctx.ellipse(0, 0, W * 0.38, D * 0.35, 0, 0, Math.PI * 2); }
      else if (f.type === 'dusche') { ctx.moveTo(-W / 2, -D / 2); ctx.lineTo(W / 2, D / 2); ctx.moveTo(W / 2, -D / 2); ctx.lineTo(-W / 2, D / 2); }
      else if (f.type === 'tisch') { for (const x of [-W * 0.3, 0, W * 0.3]) for (const y of [-D / 2 - 8, D / 2 + 8]) ctx.rect(x - 8, y - 6, 16, 12); }
      else if (f.type === 'auto') { ctx.rect(-W / 2 + 6, -D / 2 + D * 0.25, W - 12, D * 0.35); }
      ctx.stroke();
      if (s > 25) { ctx.fillStyle = col('--muted'); ctx.font = `${10 * this.dpr}px system-ui`; ctx.textAlign = 'center'; ctx.fillText(d.name, 0, D / 2 - 4); }
      ctx.restore();
    }
  }

  function roomColor(use, col) { return { HNF: col('--room-hnf'), NNF: col('--room-nnf'), VF: col('--room-vf'), FF: col('--room-ff') }[use] || col('--room-hnf'); }
  function wallPoly(w) {
    const L = G.dist(w.a, w.b) || 1e-6; const n = [-(w.b[1] - w.a[1]) / L * w.t / 2, (w.b[0] - w.a[0]) / L * w.t / 2];
    const e = [(w.b[0] - w.a[0]) / L * w.t / 2, (w.b[1] - w.a[1]) / L * w.t / 2]; // Verlängerung für saubere Ecken
    return [[w.a[0] - e[0] + n[0], w.a[1] - e[1] + n[1]], [w.b[0] + e[0] + n[0], w.b[1] + e[1] + n[1]], [w.b[0] + e[0] - n[0], w.b[1] + e[1] - n[1]], [w.a[0] - e[0] - n[0], w.a[1] - e[1] - n[1]]];
  }
  function furnPoly(f) { const d = FURN[f.type] || { w: 1, d: 1 }; const a = (f.rot || 0) * Math.PI / 180; return [[-d.w / 2, -d.d / 2], [d.w / 2, -d.d / 2], [d.w / 2, d.d / 2], [-d.w / 2, d.d / 2]].map(p => { const r = G.rotate(p, a); return [r[0] + f.x, r[1] + f.y]; }); }

  /** lokale Plan-Koordinate → LV95 */
  function toWorld(project, p) { const pl = project.placement || { E: 0, N: 0, rot: 0 }; const r = G.rotate(p, pl.rot); return [r[0] + pl.E, r[1] + pl.N]; }

  /** Flächen je Geschoss (SIA 416, vereinfacht) */
  function areas(project) {
    const P = project.plan; const out = [];
    for (const l of P.levels) {
      const gf = (l.outline || []).reduce((s, o) => s + G.absArea(o), 0);
      const rooms = P.rooms.filter(r => r.level === l.id).map(r => ({ name: r.name, use: r.use, area: G.absArea(r.poly) }));
      const sum = u => rooms.filter(r => r.use === u).reduce((s, r) => s + r.area, 0);
      out.push({ level: l, gf, rooms, hnf: sum('HNF'), nnf: sum('NNF'), vf: sum('VF'), ff: sum('FF'), ngf: rooms.reduce((s, r) => s + r.area, 0) });
    }
    return out;
  }

  window.Plan = { roofHeightAt, PlanEditor, FURN, DEFAULT_PROGRAM, emptyPlan, planFromVariant, wallPoly, furnPoly, toWorld, areas, uid };
})();
