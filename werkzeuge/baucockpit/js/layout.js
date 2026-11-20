/* Baucockpit – Grundrissvorschlag (Zonierung, Räume, Wände, Türen, Fenster, Treppe) und Möblierung */
(function () {
  const { G, terrainAt } = Geo;
  const uid = Plan.uid;
  const E = 1e-3;

  /* ---------- Raumklassen ---------- */
  function cls(name) {
    const s = (name || '').toLowerCase();
    if (/garage|einstell/.test(s)) return 'garage';
    if (/loggia|balkon/.test(s)) return 'loggia';
    if (/entr|eingang|garderobe|korridor|flur|vorplatz|diele/.test(s)) return 'entry';
    if (/wohn/.test(s) && /küche|kueche/.test(s)) return 'living';
    if (/halle|werkstatt|produktion/.test(s)) return 'hall';
    if (/treppenhaus/.test(s)) return 'entry';
    if (/küche|kueche|kochen/.test(s)) return 'kitchen';
    if (/wohn|ess|living/.test(s)) return 'living';
    if (/bad|dusche|wc|sanit/.test(s)) return 'wet';
    if (/reduit|technik|wasch|keller|abstell|disponibel|hobby|lager|ankleide|schutzraum|heiz/.test(s)) return 'service';
    if (/zimmer|schlaf|eltern|kind|gast|studio|büro|buero|arbeit/.test(s)) return 'bed';
    return 'bed';
  }
  const LIVING = c => c === 'living' || c === 'kitchen';
  const USE = { loggia: 'NNF', hall: 'HNF', living: 'HNF', kitchen: 'HNF', bed: 'HNF', wet: 'HNF', service: 'NNF', garage: 'NNF', entry: 'VF', corr: 'VF' };

  /* ---------- Rechteck-Hilfen [x0,y0,x1,y1] ---------- */
  const rArea = r => (r[2] - r[0]) * (r[3] - r[1]);
  const rPoly = r => [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
  const rNorm = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  const overlap1 = (a0, a1, b0, b1) => [Math.max(a0, b0), Math.min(a1, b1)];
  /** gemeinsame Kante zweier Rechtecke → Segment oder null */
  function sharedEdge(a, b) {
    for (const [x, ok] of [[a[2], Math.abs(a[2] - b[0]) < 0.02], [a[0], Math.abs(a[0] - b[2]) < 0.02]]) if (ok) { const [s0, s1] = overlap1(a[1], a[3], b[1], b[3]); if (s1 - s0 > 0.3) return [[x, s0], [x, s1]]; }
    for (const [y, ok] of [[a[3], Math.abs(a[3] - b[1]) < 0.02], [a[1], Math.abs(a[1] - b[3]) < 0.02]]) if (ok) { const [s0, s1] = overlap1(a[0], a[2], b[0], b[2]); if (s1 - s0 > 0.3) return [[s0, y], [s1, y]]; }
    return null;
  }

  /* ---------- Rahmen: F-Koordinaten (x = Längsachse) ---------- */
  function frame(swap) {
    return {
      to: p => swap ? [p[1], -p[0]] : [p[0], p[1]],
      from: q => swap ? [-q[1], q[0]] : [q[0], q[1]],
      rTo(r) { const a = this.to([r[0], r[1]]), b = this.to([r[2], r[3]]); return rNorm(a, b); },
      rFrom(r) { const a = this.from([r[0], r[1]]), b = this.from([r[2], r[3]]); return rNorm(a, b); }
    };
  }

  /* ---------- Programm auf Geschosse verteilen ---------- */
  function distribute(project, levels, opts) {
    const byName = Object.fromEntries(levels.map(l => [l.name, l]));
    const ug = levels.find(l => l.z < -0.01), eg = levels.find(l => Math.abs(l.z) < 0.01) || levels[0];
    const upper = levels.filter(l => l.z > 0.01);
    const out = Object.fromEntries(levels.map(l => [l.id, []]));
    const cap = Object.fromEntries(levels.map(l => [l.id, (l.outline || []).reduce((s, o) => s + G.absArea(o), 0) * 0.78]));
    const load = id => out[id].reduce((s, r) => s + r.area, 0);
    for (const r of project.program) {
      const c = cls(r.name); const room = { name: r.name, area: Number(r.area) || 8, cls: c, use: r.use || USE[c] };
      if (c === 'entry') continue; // Erschliessungszone wird separat erzeugt
      if (c === 'garage') { if (opts.parking !== 'garage_int') continue; const tgt = ug && opts.garageUG ? ug : eg; out[tgt.id].push(room); continue; }
      if (ug && c === 'service' && /keller|technik|wasch|disponibel|hobby|lager|heiz|schutz/i.test(r.name)) { out[ug.id].push(room); continue; }
      const lv = byName[r.level];
      if (lv && !(lv.roof && LIVING(c)) && (load(lv.id) + room.area) / cap[lv.id] <= 1.1) { out[lv.id].push(room); continue; }
      if (lv && LIVING(c)) { out[lv.id].push(room); continue; }
      if (LIVING(c) || (c === 'wet' && /wc|dusche/i.test(r.name) && !/bad/i.test(r.name))) { out[eg.id].push(room); continue; }
      if (!upper.length) { out[eg.id].push(room); continue; }
      let tgt = upper.slice().sort((a, b) => (load(a.id) / cap[a.id]) - (load(b.id) / cap[b.id]))[0];
      if ((load(tgt.id) + room.area) / cap[tgt.id] > 1.05 && (load(eg.id) + room.area) / cap[eg.id] < (load(tgt.id) + room.area) / cap[tgt.id]) tgt = eg;
      out[tgt.id].push(room);
    }
    // leere Geschosse sinnvoll belegen
    for (const l of levels) if (!out[l.id].length) {
      if (l.z < -0.01) out[l.id].push({ name: 'Keller', area: 15, cls: 'service', use: 'NNF' }, { name: 'Technik', area: 8, cls: 'service', use: 'FF' }, { name: 'Disponibel', area: 18, cls: 'service', use: 'NNF' });
      else if (l.attika || l.roof || l.name === 'Attika') out[l.id].push({ name: 'Studio / Büro', area: 20, cls: 'bed', use: 'HNF' }, { name: 'Dusche / WC', area: 4.5, cls: 'wet', use: 'HNF' });
      else out[l.id].push({ name: 'Zimmer', area: 13, cls: 'bed', use: 'HNF' }, { name: 'Zimmer', area: 13, cls: 'bed', use: 'HNF' }, { name: 'Dusche / WC', area: 5, cls: 'wet', use: 'HNF' });
    }
    // Doppelte Namen eindeutig machen
    const seen = {}; for (const id in out) for (const r of out[id]) { seen[r.name] = (seen[r.name] || 0) + 1; if (seen[r.name] > 1) r.name = `${r.name} ${seen[r.name]}`; }
    return out;
  }

  /* ---------- Zone füllen (F-Koordinaten) ---------- */
  function fillZone(zr, rooms, ctx) {
    const { fy, bandSide } = ctx; // fy: Vorderseite (-1 = y0, +1 = y1); bandSide: 'x0'|'x1'|null
    const out = [];
    if (!rooms.length) { out.push({ name: ctx.isUG ? 'Disponibel' : 'Abstellraum', cls: 'service', use: 'NNF', r: zr.slice() }); return out; }
    let z = zr.slice();
    // Garage als volle Spalte am äusseren Ende
    const gar = rooms.filter(r => r.cls === 'garage'); rooms = rooms.filter(r => r.cls !== 'garage');
    for (const g of gar) {
      const zd = z[3] - z[1]; const w = Math.min(z[2] - z[0], Math.max(3.4, Math.min(6.4, g.area / zd)));
      let r; if (bandSide === 'x1' || (!bandSide && ctx.garageEnd === 'x0')) { r = [z[0], z[1], z[0] + w, z[3]]; z[0] += w; } else { r = [z[2] - w, z[1], z[2], z[3]]; z[2] -= w; }
      out.push({ ...g, r });
      if (z[2] - z[0] < 1.5) return out;
    }
    if (!rooms.length) { if (z[2] - z[0] > 1.5) out.push({ name: 'Reduit', cls: 'service', use: 'NNF', r: z }); return out; }
    const zd = z[3] - z[1];
    if ((z[2] - z[0]) < zd * 0.85) return out.concat(stackZone(z, rooms, ctx));
    const front = rooms.filter(r => LIVING(r.cls) && r.cls !== 'kitchen' || r.cls === 'bed');
    let back = rooms.filter(r => !front.includes(r));
    // Küche bei offenem Wohnen hinten an der Erschliessung
    const nonLiving = rooms.filter(r => !LIVING(r.cls));
    const needCorr = nonLiving.length >= 2 || (nonLiving.length >= 1 && rooms.some(r => LIVING(r.cls)) === false && rooms.length >= 2);
    const twoRows = zd >= 7.2 && front.length && back.length;
    const corrW = needCorr ? 1.2 : 0;
    const yF = fy < 0 ? z[1] : z[3]; const dir = fy < 0 ? 1 : -1; // von vorne nach innen
    const band = (d0, d1) => { const a = yF + dir * d0, b = yF + dir * d1; return [Math.min(a, b), Math.max(a, b)]; };
    const rowsOf = [];
    if (twoRows) {
      const Af = front.reduce((s, r) => s + r.area, 0), Ab = back.reduce((s, r) => s + r.area, 0);
      const avail = zd - corrW; let fd = Math.max(3.4, Math.min(avail - 2.2, avail * Af / (Af + Ab)));
      rowsOf.push({ rooms: front, y: band(0, fd) });
      if (corrW) { const cy = band(fd, fd + corrW); out.push({ name: 'Korridor', cls: 'corr', use: 'VF', r: [z[0], cy[0], z[2], cy[1]] }); }
      rowsOf.push({ rooms: back, y: band(fd + corrW, zd) });
    } else {
      const all = [...front, ...back];
      if (corrW && all.length > 1 && zd > 4.4) { const cy = band(zd - corrW, zd); out.push({ name: 'Korridor', cls: 'corr', use: 'VF', r: [z[0], cy[0], z[2], cy[1]] }); rowsOf.push({ rooms: all, y: band(0, zd - corrW) }); }
      else rowsOf.push({ rooms: all, y: band(0, zd) });
    }
    const CAP = { wet: 1.6, service: 1.6, kitchen: 1.5, garage: 1.3, bed: 1.7, living: 99 };
    for (const row of rowsOf) {
      const list = row.rooms.slice();
      const rank = r => ({ kitchen: 0, wet: 1, service: 2, bed: 3, living: 4 }[r.cls] ?? 3);
      list.sort((a, b) => rank(a) - rank(b));
      const W = z[2] - z[0]; const depth = row.y[1] - row.y[0]; const sum = list.reduce((s, r) => s + r.area, 0);
      let k = W / sum; const widths = list.map(r => r.area * k);
      // Kappung überdimensionierter Nebenräume
      for (let it = 0; it < 3; it++) {
        let free = 0; const flex = [];
        list.forEach((r, i) => { const max = (CAP[r.cls] || 1.6) * r.area / depth; if (widths[i] > max + 1e-6) { free += widths[i] - max; widths[i] = max; } else if ((CAP[r.cls] || 1.6) * r.area / depth > widths[i] + 1e-6) flex.push(i); });
        if (free < 1e-3) break;
        const fs = flex.reduce((s, i) => s + list[i].area, 0);
        if (fs > 0) flex.forEach(i => widths[i] += free * list[i].area / fs);
        else { widths.push(free); list.push(ctx.isUG ? { name: 'Disponibel', cls: 'service', use: 'NNF', area: free * depth } : free * depth >= 9 ? { name: ctx.upper ? 'Zimmer' : 'Büro / Gast', cls: 'bed', use: 'HNF', area: free * depth } : { name: 'Reduit', cls: 'service', use: 'NNF', area: free * depth }); break; }
      }
      let x = bandSide === 'x1' ? z[2] : z[0]; const sgn = bandSide === 'x1' ? -1 : 1;
      list.forEach((r, i) => {
        const w = i === list.length - 1 ? Math.abs((bandSide === 'x1' ? z[0] : z[2]) - x) : widths[i];
        const xa = x, xb = x + sgn * w; out.push({ ...r, r: [Math.min(xa, xb), row.y[0], Math.max(xa, xb), row.y[1]] }); x = xb;
      });
    }
    return out.filter(o => o.r);
  }

  /** Räume quer über die ganze Zonenbreite stapeln (jeder Raum grenzt an die Erschliessung) */
  function stackZone(z, rooms, ctx) {
    const CAP = { wet: 1.6, service: 1.6, kitchen: 1.5, garage: 1.3, bed: 1.7, living: 99 };
    const rank = r => ({ living: 0, bed: 1, kitchen: 2, wet: 3, service: 4 }[r.cls] ?? 2);
    const list = rooms.slice().sort((a, b) => rank(a) - rank(b));
    const zw = z[2] - z[0], zd = z[3] - z[1]; const sum = list.reduce((s, r) => s + r.area, 0);
    const hs = list.map(r => zd * r.area / sum);
    let free = 0; const flex = [];
    list.forEach((r, i) => { const max = (CAP[r.cls] || 1.6) * r.area / zw; if (hs[i] > max) { free += hs[i] - max; hs[i] = max; } else flex.push(i); });
    if (free > 1e-3) { const fs = flex.filter(i => CAP[list[i].cls] > 1.6).reduce((s, i) => s + list[i].area, 0); if (fs > 0) flex.filter(i => CAP[list[i].cls] > 1.6).forEach(i => hs[i] += free * list[i].area / fs); else { hs.push(free); list.push(free * zw >= 9 ? { name: ctx.isUG ? 'Disponibel' : 'Zimmer', cls: ctx.isUG ? 'service' : 'bed', use: ctx.isUG ? 'NNF' : 'HNF' } : { name: 'Reduit', cls: 'service', use: 'NNF' }); } }
    // von vorne (fy) nach hinten
    let y = ctx.fy < 0 ? z[1] : z[3]; const sg = ctx.fy < 0 ? 1 : -1; const out = [];
    list.forEach((r, i) => { const h = i === list.length - 1 ? Math.abs((ctx.fy < 0 ? z[3] : z[1]) - y) : hs[i]; const ya = y, yb = y + sg * h; out.push({ ...r, r: [z[0], Math.min(ya, yb), z[2], Math.max(ya, yb)] }); y = yb; });
    return out;
  }


  /* ======== Grundrisstypologien nach Schweizer Praxis ========
     Streifenprinzip (Tiefe v ab Gartenseite): Wohnstreifen | Korridor | Nebenraumstreifen (strassenseitig)
     Längsrichtung u ab «Wohnende» (Südwest bzw. strassenabgewandt). */
  const CAPW = { wet: 1.6, service: 1.7, kitchen: 1.5, bed: 1.6, living: 99, garage: 1.3 };
  function layoutRect(R, o) {
    const W = R[2] - R[0], D = R[3] - R[1];
    const conv = (u0, u1, v0, v1) => { const xa = o.livingAtX0 ? R[0] + u0 : R[2] - u1, xb = o.livingAtX0 ? R[0] + u1 : R[2] - u0; const ya = o.fy < 0 ? R[1] + v0 : R[3] - v1, yb = o.fy < 0 ? R[1] + v1 : R[3] - v0; return [Math.min(xa, xb), Math.min(ya, yb), Math.max(xa, xb), Math.max(ya, yb)]; };
    let corridor = o.corridor; const db = Math.min(o.db, D - 3.0);
    if (D < db + o.cw + 3.0) corridor = 'none';
    const cw = corridor === 'none' ? 0 : o.cw; const df = D - db - cw;
    const out = [];
    const fill = (list, u0, u1, v0, v1, filler) => {
      // Breiten ∝ Fläche/Tiefe mit Obergrenzen; Rest → Füllraum oder letzter Raum
      const span = u1 - u0; if (list.length && span < 1.5) return list; if (span < 0.6) return []; const dep = v1 - v0; if (!list.length) { if (filler) out.push({ ...filler, r: conv(u0, u1, v0, v1) }); return; }
      list = list.slice(); const minW = r => Math.max(r.cls === 'bed' ? 2.7 : 1.5, r.area / dep * 0.75); const spill = [];
      while (list.length > 1 && list.reduce((a, r) => a + minW(r), 0) > span && list.some(r => r.cls === 'service')) { // Nebenräume in den Zimmerstreifen verschieben
        const i = list.map((r, k) => [r, k]).filter(([r]) => r.cls === 'service').sort((a, b) => a[0].area - b[0].area)[0][1]; spill.push(list.splice(i, 1)[0]);
      }
      while (list.length > 1 && list.reduce((a, r) => a + minW(r), 0) > span) { // kleinste Nebenräume zusammenlegen
        const cand = list.map((r, i) => [r, i]).filter(([r]) => r.cls !== 'bed' && r.cls !== 'garage').sort((a, b) => a[0].area - b[0].area);
        if (cand.length < 2) break; const [a, ia] = cand[0], [b, ib] = cand[1];
        const m = { ...b, name: `${b.name.replace(/ \d+$/, '')} / ${a.name.replace(/ \d+$/, '')}`, area: a.area + b.area, cls: a.cls === 'wet' || b.cls === 'wet' ? 'wet' : b.cls };
        list = list.filter((_, i) => i !== ia && i !== ib); list.splice(Math.min(ia, ib), 0, m);
      }
      let ws = list.map(r => Math.max(r.cls === 'bed' ? 2.7 : 1.3, r.area / dep));
      const tot = ws.reduce((a, b) => a + b, 0);
      if (tot > span) ws = ws.map(w => w * span / tot);
      else { let free = span - tot; const flex = list.map((r, i) => i).filter(i => (CAPW[list[i].cls] || 1.6) > 1.6 || list[i].cls === 'bed');
        const caps = list.map((r, i) => (CAPW[r.cls] || 1.6) * r.area / dep - ws[i]);
        for (const i of flex) { const add = Math.min(free * list[i].area / flex.reduce((a, k) => a + list[k].area, 0), Math.max(0, caps[i])); ws[i] += add; }
        free = span - ws.reduce((a, b) => a + b, 0);
        if (free > 1.5 && filler) { list = list.concat([{ ...filler }]); ws.push(free); } else ws[ws.length - 1] += free; }
      let u = u0; list.forEach((r, i) => { const w = i === list.length - 1 ? u1 - u : ws[i]; out.push({ ...r, r: conv(u, u + w, v0, v1) }); u += w; });
      return spill;
    };
    const ub0 = o.ub0 != null ? Math.max(0, Math.min(W, o.ub0)) : 0, ub1 = o.ub1 != null ? Math.max(ub0, Math.min(W, o.ub1)) : 0;
    // Nebenraumstreifen
    const vBefore = corridor === 'far' ? [df, D] : [D - db, D];
    const over = [];
    over.push(...(fill(o.before || [], 0, ub0, vBefore[0], vBefore[1], o.fillerBack) || []));
    if (o.block && ub1 > ub0) out.push({ ...o.block, r: conv(ub0, ub1, D - db, D) });
    over.push(...(fill(o.after || [], ub1, W, D - db, D, o.fillerBack) || []));
    // Korridor
    if (corridor === 'far') out.push({ name: o.corrName || 'Korridor', cls: 'corr', use: 'VF', r: conv(ub0, W, df, df + cw) });
    if (corridor === 'full') out.push({ name: o.corrName || 'Korridor', cls: 'corr', use: 'VF', r: conv(0, W, df, df + cw) });
    // Wohn-/Zimmerstreifen
    const liv = o.living || []; let fr = o.front || [];
    if (o.spillTo && over.length) o.spillTo.push(...over); else fr = fr.concat(over); // nicht platzierbare Nebenräume: anderes Geschoss bzw. Zimmerstreifen
    let uL = 0;
    if (liv.length) { const la = liv.reduce((a, r) => a + r.area, 0); uL = fr.length ? Math.max(3.5, Math.min(W - 2.8 * fr.length, Math.max(o.livingMinU || 0, la / df * 1.1))) : W; out.push({ ...liv[0], r: conv(0, uL, 0, df) }); }
    fill(fr, uL, W, 0, df, o.fillerFront);
    return out;
  }
  /** Wohnungsmix MFH: Raumprogramm einer Wohnung nach Fläche */
  function unitProgram(A, tag) {
    const P = (name, area, c) => ({ name: `${tag} · ${name}`, area, cls: c, use: c === 'corr' || c === 'entry' ? 'VF' : 'HNF' });
    if (A >= 105) return { size: '4.5', living: [P('Wohnen / Essen / Küche', 40, 'living')], front: [P('Zimmer', 14, 'bed'), P('Zimmer', 12, 'bed'), P('Zimmer', 12, 'bed')], back: [P('Bad', 6.5, 'wet'), P('Dusche / WC', 4, 'wet'), P('Reduit', 3, 'service')] };
    if (A >= 78) return { size: '3.5', living: [P('Wohnen / Essen / Küche', 36, 'living')], front: [P('Zimmer', 14, 'bed'), P('Zimmer', 12, 'bed')], back: [P('Bad', 6.5, 'wet'), P('Reduit', 3, 'service')] };
    return { size: '2.5', living: [P('Wohnen / Essen / Küche', 32, 'living')], front: [P('Zimmer', 14, 'bed')], back: [P('Bad', 5.5, 'wet'), P('Reduit', 2.5, 'service')] };
  }


  function templateLevel(c) {
    const { l, R, eg, use, fy, livingAtX0, blkF, DB, CW } = c;
    const W = R[2] - R[0];
    const x2u = x => livingAtX0 ? x - R[0] : R[2] - x;
    let ub0 = Math.min(x2u(blkF[0]), x2u(blkF[1])), ub1 = Math.max(x2u(blkF[0]), x2u(blkF[1]));
    const conv = (rr, u0, u1) => { const xa = livingAtX0 ? rr[0] + u0 : rr[2] - u1, xb = livingAtX0 ? rr[0] + u1 : rr[2] - u0; return [Math.min(xa, xb), rr[1], Math.max(xa, xb), rr[3]]; };
    const out = [];
    const isEG = l === eg, isUG = !!l.ug;
    if (use === 'mfh') {
      // Zweispänner: Treppenhaus mit Lift in der Mitte, Wohnungen links/rechts
      const Rc = conv(R, ub0, ub1); const coreD = isUG ? (R[3] - R[1]) : Math.min(R[3] - R[1], 6.4);
      const core = fy < 0 ? [Rc[0], Rc[3] - coreD, Rc[2], Rc[3]] : [Rc[0], Rc[1], Rc[2], Rc[1] + coreD];
      out.push({ name: isUG ? 'Treppenhaus / Vorplatz' : 'Treppenhaus', cls: 'entry', use: 'VF', r: core, band: true });
      if (!isUG && (R[3] - R[1]) - coreD >= 2.0) { // Loggien vor dem Kern, je Wohnung hälftig
        const lr = fy < 0 ? [Rc[0], Rc[1], Rc[2], Rc[3] - coreD] : [Rc[0], Rc[1] + coreD, Rc[2], Rc[3]]; const xm = (lr[0] + lr[2]) / 2;
        const tagL = `Whg ${c.floorNo}.${livingAtX0 ? 1 : 2}`, tagR = `Whg ${c.floorNo}.${livingAtX0 ? 2 : 1}`;
        out.push({ name: `${tagL} · Loggia`, cls: 'loggia', use: 'NNF', r: [lr[0], lr[1], xm, lr[3]] }, { name: `${tagR} · Loggia`, cls: 'loggia', use: 'NNF', r: [xm, lr[1], lr[2], lr[3]] });
      }
      const sides = [[0, ub0, true], [ub1, W, false]];
      sides.forEach(([u0, u1, outerLow], k) => {
        if (u1 - u0 < 3.0) return; const Ru = conv(R, u0, u1); const tag = isUG ? '' : `Whg ${c.floorNo}.${k + 1}`;
        if (isUG) { out.push(...layoutRect(Ru, { fy, livingAtX0: livingAtX0 ? outerLow : !outerLow, ub0: (u1 - u0) - 2.0, ub1: (u1 - u0), block: { name: 'Vorplatz', cls: 'corr', use: 'VF' }, before: [{ name: 'Keller', area: 10, cls: 'service', use: 'NNF' }, { name: 'Keller', area: 10, cls: 'service', use: 'NNF' }], front: [{ name: k ? 'Velo / Kinderwagen' : 'Technik / Waschen', area: 18, cls: 'service', use: 'NNF' }], corridor: 'full', corrName: 'Kellergang', db: DB, cw: CW, fillerBack: { name: 'Keller', cls: 'service', use: 'NNF' }, fillerFront: { name: 'Keller', cls: 'service', use: 'NNF' } })); return; }
        const A = (u1 - u0) * (R[3] - R[1]) * 0.86; const up = unitProgram(A, tag);
        out.push(...layoutRect(Ru, { fy, livingAtX0: livingAtX0 ? outerLow : !outerLow, ub0: (u1 - u0) - 2.2, ub1: (u1 - u0), block: { name: `${tag} · Entrée`, cls: 'entry', use: 'VF' }, before: up.back, front: up.front, living: up.living, corridor: 'full', corrName: `${tag} · Korridor`, db: DB, cw: CW, fillerBack: { name: `${tag} · Reduit`, cls: 'service', use: 'NNF' }, fillerFront: { name: `${tag} · Zimmer`, cls: 'bed', use: 'HNF' } }));
      });
      return out;
    }
    if (use === 'gewerbe') {
      // Kopfbau (Erschliessung, Büro, Nebenräume) + Halle
      const kU0 = Math.max(0, ub0 - 1.2), Rk = conv(R, kU0, W), Rh = conv(R, 0, kU0);
      if (kU0 > 3) out.push({ name: isEG ? 'Halle / Werkstatt' : isUG ? 'Lager' : 'Büro / Lager (offen)', cls: isEG ? 'hall' : 'service', use: isEG ? 'HNF' : 'NNF', r: Rh });
      const kw = W - kU0;
      out.push(...layoutRect(Rk, { fy, livingAtX0, ub0: ub0 - kU0, ub1: ub1 - kU0, block: { name: isEG ? 'Eingang / Treppe' : 'Treppe', cls: 'entry', use: 'VF', band: true }, before: [], after: [{ name: isEG ? 'WC / Garderobe' : 'WC', area: 8, cls: 'wet', use: 'HNF' }], front: isEG ? [{ name: 'Büro / Empfang', area: 18, cls: 'bed', use: 'HNF' }] : [{ name: 'Büro', area: 20, cls: 'bed', use: 'HNF' }, { name: 'Sitzungszimmer', area: 16, cls: 'bed', use: 'HNF' }], corridor: 'full', db: DB, cw: CW, fillerBack: { name: 'Technik', cls: 'service', use: 'FF' }, fillerFront: { name: 'Büro', cls: 'bed', use: 'HNF' } }));
      return out;
    }
    // EFH
    let rooms = c.rooms.slice(); let Rw = R.slice();
    const gar = rooms.filter(r => r.cls === 'garage'); rooms = rooms.filter(r => r.cls !== 'garage');
    if (gar.length) { // Garage als Kopf am strassenseitigen Ende, volle Tiefe
      const gw = Math.max(3.4, Math.min(6.6, gar[0].area / (R[3] - R[1]))); const far = W;
      if (far - gw > ub1 - 0.2) { out.push({ ...gar[0], r: conv(R, far - gw, far) }); Rw = conv(R, 0, far - gw); }
      else rooms.push(...gar);
    }
    const kitchen = rooms.filter(r => r.cls === 'kitchen'); const living = rooms.filter(r => r.cls === 'living');
    const back = rooms.filter(r => r.cls === 'wet' || r.cls === 'service' || r.cls === 'garage');
    const front = rooms.filter(r => r.cls === 'bed');
    back.sort((a, b) => (b.cls === 'wet') - (a.cls === 'wet') || (/wc|dusche/i.test(b.name) - /wc|dusche/i.test(a.name)));
    const hasLiving = living.length + kitchen.length > 0;
    let before = [], after = back.slice();
    if (kitchen.length && ub0 < 2.6) { living.push(...kitchen.map(k => ({ ...k, cls: 'living' }))); kitchen.length = 0; }
    if (kitchen.length) before = kitchen; else if (after.length && ub0 >= 1.4) { // Bad/Ankleide am Wohnende
      const i = after.findIndex(r => /bad|ankleide/i.test(r.name)); before = [after.splice(i >= 0 ? i : 0, 1)[0]];
    }
    const nFar = after.length + front.length;
    const corridor = hasLiving ? (nFar >= 2 ? 'far' : 'none') : (front.length || after.length ? 'full' : 'none');
    const blockName = isEG ? c.entryName : isUG ? 'Vorplatz' : l.roof ? 'Treppe' : 'Treppe / Galerie';
    let liv = living.length ? [{ ...living[0], name: living.some(r => /küche/i.test(r.name)) && !/küche/i.test(living[0].name) ? `${living[0].name} / Küche` : living[0].name, area: living.reduce((a, r) => a + r.area, 0) }] : [];
    if (!liv.length && kitchen.length) { liv = [{ name: 'Essen', area: 15, cls: 'living', use: 'HNF' }]; }
    out.push(...layoutRect(Rw, { spillTo: hasLiving && c.spill ? c.spill : null, livingMinU: ub1, fy, livingAtX0, ub0, ub1, block: { name: blockName, cls: 'entry', use: 'VF', band: true }, before, after, living: liv, front, corridor, db: DB, cw: CW,
      fillerBack: isUG ? { name: 'Keller', cls: 'service', use: 'NNF' } : { name: 'Reduit', cls: 'service', use: 'NNF' },
      fillerFront: isUG ? { name: 'Disponibel', cls: 'service', use: 'NNF' } : { name: isEG ? 'Büro / Gast' : 'Zimmer', cls: 'bed', use: 'HNF' } }));
    return out;
  }
  /* ---------- Hauptfunktion ---------- */
  function generate(project, opts = {}) {
    const v = project.variants.find(x => x.id === project.activeVariant); if (!v) throw new Error('Keine aktive Variante');
    opts = Object.assign({ parking: (project.site && project.site.parking) || 'none', furnish: 'basis' }, opts);
    Plan.planFromVariant(project, v);
    const P = project.plan; const pl = project.placement;
    const levels = P.levels.slice().sort((a, b) => a.z - b.z);
    const eg = levels.find(l => Math.abs(l.z) < 0.01) || levels[0];
    const wallT = l => l.ug ? 0.30 : 0.35;
    const innerOf = l => (l.outline || []).map(o => G.offset(o, -wallT(l))[0]).filter(Boolean);
    // Hauptrechteck EG → Rahmen
    const egRects = innerOf(eg).flatMap(p => G.rectDecompose(p));
    const main0 = egRects[0];
    const swap = (main0[3] - main0[1]) > (main0[2] - main0[0]) * 1.05; const F = frame(swap);
    const rotV = (vec) => G.rotate(vec, pl.rot || 0);
    const locVec = q => F.from(q); // Richtungsvektoren identisch transformiert
    // Vorderseite: talseitig, sonst Süden
    const slope = Geo.slopeOf(project.terrain, project.parcel.polygon);
    const pref = slope.pct > 5 ? [Math.cos(slope.dir), Math.sin(slope.dir)] : [0, -1];
    const dotW = q => { const w = rotV(locVec(q)); return w[0] * pref[0] + w[1] * pref[1]; };
    // Erschliessung
    const pc = project.parcel.polygon; const ai = Engine.accessEdge(project); const am = [(pc[ai][0] + pc[(ai + 1) % pc.length][0]) / 2, (pc[ai][1] + pc[(ai + 1) % pc.length][1]) / 2];
    const aLoc = G.rotate([am[0] - pl.E, am[1] - pl.N], -(pl.rot || 0)); const aF = F.to(aLoc);
    const accY = Math.abs(aF[1]) >= Math.abs(aF[0]) * 0.6;
    // Wohnseite: am Hang talseitig, sonst strassenabgewandt, sonst Süden
    let fy = dotW([0, -1]) >= dotW([0, 1]) ? -1 : 1;
    if (slope.pct <= 8 && accY) fy = aF[1] > 0 ? -1 : 1;
    const access = accY ? (Math.sign(aF[1]) === fy ? 'front' : 'back') : (aF[0] < 0 ? 'left' : 'right');
    const M = F.rTo(main0); const W = M[2] - M[0], D = M[3] - M[1];
    // Typologie
    const use = (project.typology && project.typology.use) || 'efh';
    const SW = [-0.6, -0.8]; const dW = q => { const w = rotV(locVec(q)); return w[0] * SW[0] + w[1] * SW[1]; };
    const livingAtX0 = access === 'right' ? true : access === 'left' ? false : dW([-1, 0]) >= dW([1, 0]);
    const tplOK = D >= 7.0 && W >= 8.0;
    const DB = Math.max(2.7, Math.min(3.6, D * 0.32)), CW = 1.25;
    const egProg = null;
    const kitA = (project.program.find(r => cls(r.name) === 'kitchen') || { area: 12 }).area;
    let tU0, tU1; // Erschliessungsblock (u ab Wohnende)
    if (use === 'mfh') { tU0 = W / 2 - 2.1; tU1 = W / 2 + 2.1; }
    else if (use === 'gewerbe') { tU0 = W - 6.8; tU1 = W - 1.6; }
    else { const wk = Math.max(3.0, Math.min(4.8, kitA / (DB + CW))); const garP = opts.parking === 'garage_int' ? (project.program.find(r => cls(r.name) === 'garage') || { area: 36 }).area : 0; const gw = garP ? Math.max(3.4, Math.min(6.6, garP / D)) : 0;
      tU0 = Math.max(0, Math.min(wk, W - gw - 5.5)); tU1 = tU0 + 5.0; }
    const u2x = u => livingAtX0 ? M[0] + u : M[2] - u;
    const blkF = [Math.min(u2x(tU0), u2x(tU1)), Math.max(u2x(tU0), u2x(tU1))];
    // Erschliessungszone (Band) mit Treppe
    const bandW = 2.6; const livingRight = !livingAtX0;
    let bx0;
    if (W < 9.5) bx0 = livingRight ? M[0] : M[2] - bandW;
    else { const aW = 0.58 * (W - bandW); bx0 = livingRight ? M[2] - aW - bandW : M[0] + aW; }
    const bx1 = bx0 + bandW; const stairX = livingRight ? [bx0, bx0 + 1.2] : [bx1 - 1.2, bx1]; const SL = 4.4;
    const backY = fy < 0 ? M[3] : M[1]; const bdir = fy < 0 ? -1 : 1; // von hinten nach vorne
    const stairAt = k => rNorm([stairX[0], backY + bdir * k], [stairX[1], backY + bdir * (k + SL)]);
    // Template: Treppe einläufig längs der Rückwand im Erschliessungsblock
    const tStair = (k = 0) => rNorm([blkF[0] + 0.3, backY + bdir * k], [blkF[0] + 0.3 + SL, backY + bdir * (k + 1.2)]);
    const stairs = {}; const levelInner = Object.fromEntries(levels.map(l => [l.id, innerOf(l)]));
    const inLevel = (rF, l) => { const p = rPoly(F.rFrom(rF)); return levelInner[l.id].some(q => G.inside(p, q, 0.02)); };
    for (let i = 0; i < levels.length - 1; i++) {
      const lo = levels[i], up = levels[i + 1]; let found = null;
      if (tplOK) { const mf = use === 'mfh'; const r = mf ? rNorm([blkF[0] + 0.3, backY], [blkF[0] + 1.5, backY + bdir * SL]) : tStair(0); if (inLevel(r, lo) && inLevel(r, up)) { stairs[lo.id] = { r, up: up.id, alongX: !mf }; continue; } }
      for (let k = 0; k <= D - SL + E; k += 0.25) { const r = stairAt(k); if (inLevel(r, lo) && inLevel(r, up)) { found = r; break; } }
      if (!found) { // freie Suche: Treppe innerhalb beider Geschosse, sonst an der Nahtstelle (Split-Level)
        const loR = levelInner[lo.id].flatMap(p => G.rectDecompose(p)).map(r => F.rTo(r));
        const upP = levelInner[up.id].map(p => p.map(q => F.to(q)));
        let best = null; const bc = [(bx0 + bx1) / 2, (M[1] + M[3]) / 2];
        for (const R0 of loR) for (const [sw, sh] of [[1.2, SL], [SL, 1.2]]) for (let x = R0[0]; x <= R0[2] - sw + E; x += 0.3) for (let y = R0[1]; y <= R0[3] - sh + E; y += 0.3) {
          const r = [x, y, x + sw, y + sh]; const both = inLevel(r, up); const touch = !both && upP.some(q => G.clip([rPoly([x - 0.6, y - 0.6, x + sw + 0.6, y + sh + 0.6])], [q], ClipperLib.ClipType.ctIntersection).length);
          if (!both && !touch) continue; const sc = (both ? 0 : 100) + Math.hypot(x + sw / 2 - bc[0], y + sh / 2 - bc[1]);
          if (!best || sc < best.sc) best = { r, sc, alongX: sw > sh };
        }
        if (best) found = best.r, stairs[lo.id] = { r: found, up: up.id, alongX: best.alongX };
      } else stairs[lo.id] = { r: found, up: up.id };
    }
    // Geschosse belegen
    const site = project.site || {};
    const ug = levels.find(l => l.z < -0.01);
    const egFrontExposed = ug ? (() => { const p = F.from([(M[0] + M[2]) / 2, fy < 0 ? M[1] - 0.4 : M[3] + 0.4]); const w = Plan.toWorld(project, p); return terrainAt(project.terrain, w[0], w[1]) < pl.base + ug.z + 1.2; })() : false;
    const dist = distribute(project, levels, { parking: opts.parking, garageUG: ug && egFrontExposed && (access === 'front') });
    P.rooms = []; P.walls = P.walls.filter(w => w.ext); P.openings = []; P.furniture = []; P.levels.forEach(l => { l.holes = []; });
    const entryName = (project.program.find(r => cls(r.name) === 'entry') || { name: 'Entrée / Garderobe' }).name;
    for (const l of levels) {
      const rects = levelInner[l.id].flatMap(p => G.rectDecompose(p)).map(r => F.rTo(r)).filter(r => rArea(r) > 1);
      if (!rects.length) continue;
      const bcx = (bx0 + bx1) / 2;
      let R = rects.find(r => r[0] <= bx0 + 0.05 && r[2] >= bx1 - 0.05);
      const stairHere = stairs[l.id] || Object.values(stairs).find(s => s.up === l.id);
      const items = [];
      let zones = [];
      const Rt = tplOK ? rects.find(r => r[0] <= blkF[0] + 0.05 && r[2] >= blkF[1] - 0.05) : null;
      if (Rt) {
        const spill = []; const nextL = levels.filter(x => x.z > l.z + 0.01 && !x.roof)[0] || levels.filter(x => x.z > l.z + 0.01)[0] || levels.find(x => x.ug);
        items.push(...templateLevel({ floorNo: levels.filter(x => x.z >= -0.01).indexOf(l), l, R: Rt, eg, rooms: (dist[l.id] || []).slice(), use, fy, livingAtX0, blkF, DB, CW, entryName, access, garageEnd: !livingAtX0 ? 'x0' : 'x1', spill: nextL && nextL.z > l.z ? spill : null }));
        if (spill.length && nextL) dist[nextL.id] = (dist[nextL.id] || []).concat(spill);
        for (const o of rects) if (o !== Rt) items.push(l.ug ? { name: 'Disponibel', cls: 'service', use: 'NNF', r: o } : l === eg && use === 'efh' ? { name: 'Essen / Wintergarten', cls: 'living', use: 'HNF', r: o } : { name: use === 'gewerbe' ? 'Lager' : rArea(o) > 24 ? 'Zimmer / Studio' : 'Zimmer', cls: use === 'gewerbe' ? 'service' : 'bed', use: 'HNF', r: o });
      } else if (R) {
        items.push({ name: l === eg ? entryName : l.ug ? 'Vorplatz' : 'Korridor', cls: 'entry', use: 'VF', r: [bx0, R[1], bx1, R[3]], band: true });
        if (bx0 - R[0] > 1.6) zones.push({ r: [R[0], R[1], bx0, R[3]], side: 'x1' }); // links der Erschliessung → Band bei x1
        if (R[2] - bx1 > 1.6) zones.push({ r: [bx1, R[1], R[2], R[3]], side: 'x0' });
        for (const o of rects) if (o !== R) zones.push({ r: o, side: null });
      } else { zones = rects.map(r => ({ r, side: null })); }
      // Räume zuteilen
      if (!Rt) {
      const list = (dist[l.id] || []).slice().sort((a, b) => (b.cls === 'garage') - (a.cls === 'garage') || (LIVING(b.cls) - LIVING(a.cls)) || b.area - a.area);
      zones.forEach(zn => { zn.cap = rArea(zn.r); zn.rooms = []; zn.load = 0; });
      zones.sort((a, b) => b.cap - a.cap);
      const livingZone = zones.length > 1 && zones.some(z => !z.side) ? zones.slice().sort((a, b) => b.cap - a.cap)[0] : (livingRight ? zones.find(z => z.side === 'x0') : zones.find(z => z.side === 'x1'));
      const mainZones = zones.filter(z => z.side); let extraZones = R ? zones.filter(z => !z.side) : [];
      const need = (dist[l.id] || []).reduce((s, r) => s + r.area, 0); const mainCap = mainZones.reduce((s, z) => s + z.cap, 0);
      if (mainZones.length && need <= mainCap * 0.9) zones = mainZones; else extraZones = [];
      for (const rm of list) {
        let tgt;
        if (LIVING(rm.cls) && (livingZone || zones[0])) tgt = livingZone || zones[0];
        else if (rm.cls === 'garage') tgt = zones.find(z => z !== livingZone && z.side) || zones[zones.length - 1];
        else tgt = zones.filter(z => !(z === livingZone && list.some(x => LIVING(x.cls)) && zones.length > 1 && zones.some(o => o !== livingZone && o.cap - o.load > rm.area * 0.6))).sort((a, b) => (a.load / a.cap) - (b.load / b.cap))[0] || zones[0];
        tgt.rooms.push(rm); tgt.load += rm.area; if (rm.cls === 'garage' && tgt.cap - tgt.load < 8) tgt.load = tgt.cap * 1.5;
      }
      for (const zn of zones) items.push(...fillZone(zn.r, zn.rooms, { fy, bandSide: zn.side, isUG: !!l.ug, upper: l.z > 0.01, garageEnd: access === 'left' ? 'x0' : 'x1' }));
      for (const zn of extraZones) items.push(l.ug ? { name: 'Disponibel', cls: 'service', use: 'NNF', r: zn.r } : l === eg ? { name: 'Essen / Wohnen', cls: 'living', use: 'HNF', r: zn.r } : { name: rArea(zn.r) > 24 ? 'Zimmer / Studio' : 'Zimmer', cls: 'bed', use: 'HNF', r: zn.r });
      }
      // → lokale Räume
      const rooms = items.map(it => ({ id: uid('rm'), level: l.id, name: it.name, use: it.use, cls: it.cls, rl: F.rFrom(it.r), band: !!it.band }));
      // Innenwände & Nachbarschaften
      const inner = levelInner[l.id];
      const onBoundary = (a, b) => { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; return inner.some(q => q.some((p, k) => G.segDist(m, p, q[(k + 1) % q.length]) < 0.03)); };
      const adj = [];
      for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
        const seg = sharedEdge(rooms[i].rl, rooms[j].rl); if (!seg) continue;
        const open = LIVING(rooms[i].cls) && LIVING(rooms[j].cls);
        const w = open ? null : { id: uid('w'), level: l.id, a: seg[0], b: seg[1], t: 0.12, ext: false };
        if (w) P.walls.push(w);
        adj.push({ i, j, seg, wall: w, open });
      }
      // Türen: Erreichbarkeit ab Erschliessung
      const hub = k => rooms[k].band || rooms[k].cls === 'corr';
      const acc = new Set(rooms.map((r, k) => hub(k) ? k : -1).filter(k => k >= 0));
      const door = (a, k) => {
        if (!a.wall) return;
        const L = G.dist(a.wall.a, a.wall.b); const r = rooms[k]; const w = /wc|reduit|dusche/i.test(r.name) ? 0.8 : r.cls === 'garage' ? 0.9 : LIVING(r.cls) ? 1.0 : 0.9;
        if (L < w + 0.25) return false;
        const pos = L > 2.6 ? (0.2 + w / 2) / L : 0.5;
        const ux = (a.wall.b[0] - a.wall.a[0]) / L, uy = (a.wall.b[1] - a.wall.a[1]) / L; const n = [-uy, ux];
        const c = [a.wall.a[0] + ux * L * pos, a.wall.a[1] + uy * L * pos]; const rc = G.centroid(rPoly(r.rl));
        const flip = ((rc[0] - c[0]) * n[0] + (rc[1] - c[1]) * n[1]) < 0;
        P.openings.push({ id: uid('o'), wall: a.wall.id, pos, w, h: 2.1, sill: 0, type: 'door', flip, hinge: false }); return true;
      };
      let changed = true, guard = 0;
      while (changed && guard++ < 12) {
        changed = false;
        for (let k = 0; k < rooms.length; k++) {
          if (acc.has(k)) continue;
          const other = a => a.i === k ? a.j : a.i;
          const isLog = rooms[k].cls === 'loggia'; const tagOf = n => n.split(' · ')[0];
          const cand = adj.filter(a => (a.i === k && acc.has(a.j)) || (a.j === k && acc.has(a.i))).filter(a => !isLog || (!hub(other(a)) && tagOf(rooms[other(a)].name) === tagOf(rooms[k].name)));
          if (!cand.length) continue;
          cand.sort((a, b) => (hub(other(b)) - hub(other(a))) || ((rooms[other(b)].band ? 1 : 0) - (rooms[other(a)].band ? 1 : 0)) || (b.open - a.open) || (LIVING(rooms[other(b)].cls) - LIVING(rooms[other(a)].cls)));
          const c = cand[0]; if (c.open || door(c, k) !== false) { acc.add(k); changed = true; }
        }
      }
      // Räume an Innenwänden um halbe Wandstärke einrücken (korrekte Nettofläche)
      for (const r of rooms) {
        const q = r.rl.slice(); const sides = [[0, [[q[0], q[1]], [q[0], q[3]]]], [2, [[q[2], q[1]], [q[2], q[3]]]], [1, [[q[0], q[1]], [q[2], q[1]]]], [3, [[q[0], q[3]], [q[2], q[3]]]]];
        for (const [k, [a, b]] of sides) if (!onBoundary(a, b) && !rooms.some(o => o !== r && LIVING(o.cls) && LIVING(r.cls) && sharedEdge(o.rl, r.rl) && Math.abs(sharedEdge(o.rl, r.rl)[0][k % 2 === 0 ? 0 : 1] - q[k]) < 0.02)) q[k] += (k < 2 ? 0.06 : -0.06);
        r.extSides = sides.filter(([k, [a, b]]) => onBoundary(a, b)).map(([k]) => k);
        P.rooms.push({ id: r.id, level: l.id, name: r.name, use: r.use, poly: G.ensureCCW(rPoly(q)), cls: r.cls, auto: true, extSides: r.extSides, rect: q, band: r.band });
      }
      // Treppe
      const st = stairs[l.id];
      if (st) {
        const rl = F.rFrom(st.r); const c = [(rl[0] + rl[2]) / 2, (rl[1] + rl[3]) / 2]; const up = locVec(st.alongX ? [1, 0] : [0, -bdir]);
        const rot = Math.round(Math.atan2(-up[0], up[1]) * 180 / Math.PI);
        const lvUp = P.levels.find(x => x.id === st.up);
        P.furniture.push({ id: uid('f'), level: l.id, type: 'treppe', x: c[0], y: c[1], rot, stair: true, h: lvUp.z - l.z });
        lvUp.holes = [rPoly(rl)];
      }
      if (use === 'mfh' && Rt) { const lx = blkF[0] + 2.1; const ly0 = backY + bdir * 0.2; const lr = rNorm([lx, ly0], [lx + 1.6, ly0 + bdir * 1.6]); const ll = F.rFrom(lr); P.furniture.push({ id: uid('f'), level: l.id, type: 'lift', x: (ll[0] + ll[2]) / 2, y: (ll[1] + ll[3]) / 2, rot: 0, fixed: true }); }
      // Fassadenöffnungen
      facadeOpenings(project, l, P.rooms.filter(r => r.level === l.id), { F, fy, access, eg: l === eg, stairRect: stairHere ? F.rFrom(stairHere.r) : null });
    }
    if (opts.furnish && opts.furnish !== 'keine') furnish(project, opts.furnish);
    project.layoutOpts = opts;
    return P;
  }

  /* ---------- Fenster und Aussentüren ---------- */
  function facadeOpenings(project, l, rooms, ctx) {
    const P = project.plan; const pl = project.placement;
    const extW = P.walls.filter(w => w.level === l.id && w.ext);
    const used = {}; // wallId → [[s0,s1]]
    const sideSeg = (q, k) => k === 0 ? [[q[0], q[1]], [q[0], q[3]]] : k === 2 ? [[q[2], q[1]], [q[2], q[3]]] : k === 1 ? [[q[0], q[1]], [q[2], q[1]]] : [[q[0], q[3]], [q[2], q[3]]];
    const findWall = (a, b) => { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; return extW.find(w => G.segDist(m, w.a, w.b) < w.t / 2 + 0.08 && Math.abs(((b[0] - a[0]) * (w.b[1] - w.a[1]) - (b[1] - a[1]) * (w.b[0] - w.a[0]))) < 0.05 * G.dist(a, b) * G.dist(w.a, w.b)); };
    const exposedUG = (pt) => { if (!l.ug) return true; const w = Plan.toWorld(project, pt); return terrainAt(project.terrain, w[0], w[1]) < pl.base + l.z + 1.3; };
    const place = (a, b, frac, width, h, sill, type, kind) => {
      const wall = findWall(a, b); if (!wall) return false;
      const len = G.dist(a, b); width = Math.min(width, len - 0.5); if (width < 0.5) return false;
      const c = [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac];
      const L = G.dist(wall.a, wall.b); const t = G.closestOnSeg(c, wall.a, wall.b).t * L;
      let s0 = Math.max(t - width / 2, 0.3), s1 = Math.min(t + width / 2, L - 0.3); if (s1 - s0 < 0.5) return false;
      if ((used[wall.id] || []).some(([u0, u1]) => s0 < u1 + 0.25 && s1 > u0 - 0.25)) return false;
      // Steildach: Fensterhöhe begrenzen
      if (l.roof) { const top = Plan.roofHeightAt(l, c) - 0.25; if (sill + h > top) h = top - sill; if (h < 0.6) return false; }
      (used[wall.id] = used[wall.id] || []).push([s0, s1]);
      P.openings.push({ id: uid('o'), wall: wall.id, pos: ((s0 + s1) / 2) / L, w: s1 - s0, h, sill, type, kind: kind || null, flip: true, hinge: false });
      return true;
    };
    const frontK = (() => { const s = ctx.F.from([0, ctx.fy]); return Math.abs(s[0]) > Math.abs(s[1]) ? (s[0] < 0 ? 0 : 2) : (s[1] < 0 ? 1 : 3); })();
    const backK = { 0: 2, 2: 0, 1: 3, 3: 1 }[frontK];
    const accessK = ctx.access === 'front' ? frontK : ctx.access === 'back' ? backK : (() => { const s = ctx.F.from([ctx.access === 'left' ? -1 : 1, 0]); return Math.abs(s[0]) > Math.abs(s[1]) ? (s[0] < 0 ? 0 : 2) : (s[1] < 0 ? 1 : 3); })();
    for (const r of rooms) {
      const q = r.rect; const ext = r.extSides || []; if (!ext.length) continue;
      const order = ext.slice().sort((a, b) => (a === frontK ? -1 : 0) - (b === frontK ? -1 : 0));
      const seg = k => sideSeg(q, k);
      if (r.cls === 'hall') {
        const k = ext.includes(accessK) ? accessK : order[0]; const [a, b] = seg(k); place(a, b, 0.5, Math.min(4.5, G.dist(a, b) - 1), 4.0, 0, 'door', 'garage');
        for (const k2 of ext) { const [a2, b2] = seg(k2); const L2 = G.dist(a2, b2); const n2 = Math.max(1, Math.floor(L2 / 5)); for (let i = 0; i < n2; i++) place(a2, b2, (i + 0.5) / n2, Math.min(3.5, L2 / n2 - 0.8), 1.2, 2.6, 'window'); }
        continue;
      }
      if (r.cls === 'entry' && !r.band) continue;
      if (r.cls === 'entry' && ctx.eg && !l.ug) {
        const k = ext.includes(accessK) ? accessK : ext.includes(backK) ? backK : ext[0]; const [a, b] = seg(k);
        const wall = findWall(a, b); if (wall) { place(a, b, 0.5, 1.1, 2.2, 0, 'door', 'entry'); }
        const k2 = ext.find(x => x !== k); if (k2 != null) place(...seg(k2), 0.5, 1.0, 1.4, 0.9, 'window');
        continue;
      }
      if (r.cls === 'entry' || r.cls === 'corr') { const k = ext.includes(backK) ? backK : ext[0]; if (exposedUG(seg(k)[0])) place(...seg(k), 0.5, 1.0, 1.3, 0.9, 'window'); continue; }
      if (r.cls === 'garage') {
        const k = ext.includes(accessK) ? accessK : order[0]; const [a, b] = seg(k);
        if (exposedUG([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) { const len = G.dist(a, b); place(a, b, 0.5, len >= 5.6 ? 5.0 : 2.5, 2.2, 0, 'door', 'garage'); }
        continue;
      }
      for (const k of order) {
        const [a, b] = seg(k); const len = G.dist(a, b); const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const exp = exposedUG(m);
        if (l.ug && !exp) { if (r.cls !== 'service' || k === order[0]) place(a, b, 0.5, 0.9, 0.6, 1.9, 'window'); continue; }
        if (r.cls === 'loggia') { if (k === order[0]) place(a, b, 0.5, len - 0.4, 2.3, 0, 'window', 'loggia'); continue; }
        if (r.cls === 'living') {
          if (k === frontK || k === order[0]) { place(a, b, 0.5, Math.max(2.0, Math.min(4.2, len * 0.5)), 2.3, 0, 'window'); if (len > 7.5) { place(a, b, 0.12, 1.2, 2.3, 0, 'window'); place(a, b, 0.88, 1.2, 2.3, 0, 'window'); } }
          else place(a, b, 0.5, Math.min(1.8, len * 0.4), 1.6, 0.6, 'window');
        } else if (r.cls === 'kitchen') { place(a, b, 0.5, Math.min(1.6, len * 0.5), 1.1, 1.05, 'window'); }
        else if (r.cls === 'bed') {
          if (k === order[0]) place(a, b, 0.5, Math.max(1.2, Math.min(2.2, len * 0.45)), l.attika ? 2.3 : 1.8, l.attika ? 0 : 0.5, 'window');
          else if (len > 3) place(a, b, 0.5, 1.0, 1.4, 0.9, 'window');
        } else if (r.cls === 'wet') { if (k === order[0]) place(a, b, 0.5, 0.8, 0.9, 1.4, 'window'); }
        else if (r.cls === 'service') { if (k === order[0] && !/reduit|ankleide/i.test(r.name)) place(a, b, 0.5, 0.8, 0.8, 1.4, 'window'); }
      }
    }
  }

  /* ================= Möblierung ================= */
  const TEMPLATES = {
    living: { basis: [['sofa', 'wall'], ['tisch', 'free']], komplett: [['sofa', 'wall'], ['couchtisch', 'front:sofa'], ['sessel', 'free'], ['tisch', 'free'], ['sideboard', 'wall']] },
    livingKitchen: { basis: [['kueche', 'wall-long'], ['tisch', 'free'], ['sofa', 'wall']], komplett: [['kueche', 'wall-long'], ['tisch', 'free'], ['sofa', 'wall'], ['couchtisch', 'front:sofa'], ['sideboard', 'wall']] },
    kitchen: { basis: [['kueche', 'wall-long']], komplett: [['kueche', 'wall-long'], ['insel', 'free']] },
    bedD: { basis: [['bett', 'wall'], ['schrank', 'wall']], komplett: [['bett', 'wall'], ['schrank', 'wall'], ['schreibtisch', 'window']] },
    bedS: { basis: [['bett1', 'wall'], ['schrank', 'wall']], komplett: [['bett1', 'wall'], ['schrank', 'wall'], ['schreibtisch', 'window']] },
    studio: { basis: [['schreibtisch', 'window'], ['schrank', 'wall']], komplett: [['schreibtisch', 'window'], ['sofa', 'wall'], ['schrank', 'wall']] },
    bath: { basis: [['wanne', 'wall'], ['wc', 'wall'], ['lavabo', 'wall'], ['dusche', 'corner']], komplett: [['wanne', 'wall'], ['dusche', 'corner'], ['wc', 'wall'], ['lavabo', 'wall'], ['lavabo', 'wall']] },
    shower: { basis: [['dusche', 'corner'], ['wc', 'wall'], ['lavabo', 'wall']], komplett: [['dusche', 'corner'], ['wc', 'wall'], ['lavabo', 'wall']] },
    wc: { basis: [['wc', 'wall'], ['lavabo', 'wall']], komplett: [['wc', 'wall'], ['lavabo', 'wall']] },
    wash: { basis: [['wm', 'wall'], ['wm', 'wall']], komplett: [['wm', 'wall'], ['wm', 'wall'], ['schrank', 'wall']] },
    store: { basis: [['regal', 'wall']], komplett: [['regal', 'wall'], ['regal', 'wall']] },
    dress: { basis: [['schrank', 'wall'], ['schrank', 'wall']], komplett: [['schrank', 'wall'], ['schrank', 'wall'], ['schrank', 'wall']] },
    entry: { basis: [['garderobe', 'wall']], komplett: [['garderobe', 'wall'], ['sideboard', 'wall']] },
    garage: { basis: [['auto', 'garage']], komplett: [['auto', 'garage'], ['regal', 'wall']] }
  };
  function templateFor(r) {
    const n = r.name.toLowerCase(); const c = r.cls || cls(r.name); const A = G.absArea(r.poly);
    if (c === 'living' && /küche|kueche/.test(n)) return 'livingKitchen';
    if (c === 'living') return 'living'; if (c === 'kitchen') return 'kitchen'; if (c === 'garage') return 'garage';
    if (c === 'entry') return r.level && /entr|garderobe|eingang/.test(n) ? 'entry' : null;
    if (c === 'wet') return /bad/.test(n) && A >= 6 ? 'bath' : /dusche/.test(n) || A >= 3.5 ? 'shower' : 'wc';
    if (c === 'service') return /wasch|technik/.test(n) ? 'wash' : /ankleide/.test(n) ? 'dress' : 'store';
    if (c === 'bed') return /studio|büro|buero|arbeit/.test(n) ? 'studio' : /eltern|schlaf|master|suite/.test(n) || A >= 14 ? 'bedD' : 'bedS';
    return null;
  }
  function furnish(project, mode = 'basis') {
    const P = project.plan;
    P.furniture = P.furniture.filter(f => f.stair || f.fixed || !f.auto);
    if (mode === 'keine') return;
    for (const r of P.rooms) {
      const key = templateFor(r); if (!key) continue; const tpl = TEMPLATES[key][mode] || TEMPLATES[key].basis;
      const q = r.rect || G.bbox(r.poly); if ((q[2] - q[0]) < 1.2 || (q[3] - q[1]) < 1.2) continue;
      const obs = obstaclesFor(project, r, q);
      const placed = [];
      for (const [type, how] of tpl) {
        if (type === 'insel' && Math.min(q[2] - q[0], q[3] - q[1]) < 3.6) continue;
        if (type === 'wanne' && G.absArea(r.poly) < 6) continue;
        if (type === 'auto') { autos(P, r, q, obs); continue; }
        const f = placeItem(type, how, q, obs, placed, r);
        if (f) { f.level = r.level; f.id = uid('f'); f.auto = true; P.furniture.push(f); placed.push(f); obs.push({ bb: G.bbox(Plan.furnPoly(f)), hard: true }); }
      }
    }
  }
  function obstaclesFor(project, room, q) {
    const P = project.plan; const out = [];
    for (const o of P.openings) {
      const w = P.walls.find(x => x.id === o.wall); if (!w || w.level !== room.level) continue;
      const L = G.dist(w.a, w.b); const u = [(w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L]; const c = [w.a[0] + u[0] * L * o.pos, w.a[1] + u[1] * L * o.pos];
      if (c[0] < q[0] - 0.4 || c[0] > q[2] + 0.4 || c[1] < q[1] - 0.4 || c[1] > q[3] + 0.4) continue;
      const hw = o.w / 2; const depth = o.type === 'door' ? o.w + 0.15 : 0.0;
      const n = [-u[1], u[0]];
      const pts = [[-hw, -depth], [hw, -depth], [hw, depth], [-hw, depth]].map(([s, t]) => [c[0] + u[0] * s + n[0] * t, c[1] + u[1] * s + n[1] * t]);
      if (o.type === 'door') out.push({ bb: G.bbox(pts), hard: true });
      else out.push({ bb: G.bbox([[c[0] - u[0] * hw - n[0] * 0.5, c[1] - u[1] * hw - n[1] * 0.5], [c[0] + u[0] * hw + n[0] * 0.5, c[1] + u[1] * hw + n[1] * 0.5]]), window: true, sill: o.sill });
    }
    for (const f of P.furniture.filter(f => f.level === room.level && f.stair)) { const bb = G.bbox(Plan.furnPoly(f)); out.push({ bb: [bb[0] - 0.6, bb[1] - 0.6, bb[2] + 0.6, bb[3] + 0.6], hard: true }); }
    return out;
  }
  const bbHit = (a, b) => a[0] < b[2] - E && a[2] > b[0] + E && a[1] < b[3] - E && a[3] > b[1] + E;
  function fits(f, q, obs) {
    const bb = G.bbox(Plan.furnPoly(f)); const d = Plan.FURN[f.type];
    if (bb[0] < q[0] - E || bb[1] < q[1] - E || bb[2] > q[2] + E || bb[3] > q[3] + E) return false;
    for (const o of obs) { if (!bbHit(bb, o.bb)) continue; if (o.hard) return false; if (o.window && d.h > Math.max(0.3, o.sill - 0.05)) return false; }
    return true;
  }
  /** Gegenstand an Wand (Rückseite = lokale +y des Möbels) */
  function atSide(type, q, side, t, inset = 0) {
    const d = Plan.FURN[type];
    const n = [[-1, 0], [0, -1], [1, 0], [0, 1]][side]; // 0:x0 1:y0 2:x1 3:y1
    const rot = Math.round(Math.atan2(-n[0], n[1]) * 180 / Math.PI);
    const off = d.d / 2 + 0.02 + inset;
    if (side === 0) return { type, x: q[0] + off, y: t, rot };
    if (side === 2) return { type, x: q[2] - off, y: t, rot };
    if (side === 1) return { type, x: t, y: q[1] + off, rot };
    return { type, x: t, y: q[3] - off, rot };
  }
  function placeItem(type, how, q, obs, placed, room) {
    const d = Plan.FURN[type]; if (!d) return null;
    const sideLen = s => s % 2 === 0 ? q[3] - q[1] : q[2] - q[0];
    const ext = room.extSides || []; const sideKeyFromRect = k => ({ 0: 0, 1: 1, 2: 2, 3: 3 }[k]); // rect-Seiten-Index = gleiche Codierung
    let sides = [0, 1, 2, 3];
    if (how === 'wall-long') sides.sort((a, b) => sideLen(b) - sideLen(a));
    else if (how === 'window') sides = sides.filter(s => ext.includes(sideKeyFromRect(s))).concat(sides);
    else sides.sort((a, b) => (ext.includes(a) - ext.includes(b)) || (sideLen(b) - sideLen(a)));
    if (how === 'front:sofa') {
      const s = placed.find(p => p.type === 'sofa'); if (!s) return null;
      const a = s.rot * Math.PI / 180; const dir = [Math.sin(a), -Math.cos(a)]; const dist = Plan.FURN.sofa.d / 2 + 0.45 + d.d / 2;
      const f = { type, x: s.x + dir[0] * dist, y: s.y + dir[1] * dist, rot: s.rot }; return fits(f, q, obs) ? f : null;
    }
    if (how === 'free') {
      const cx = (q[0] + q[2]) / 2, cy = (q[1] + q[3]) / 2; const cands = [];
      for (let x = q[0] + 0.3; x <= q[2] - 0.3; x += 0.2) for (let y = q[1] + 0.3; y <= q[3] - 0.3; y += 0.2) cands.push([x, y]);
      cands.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
      const clear = type === 'tisch' ? 0.75 : type === 'insel' ? 0.9 : 0.4;
      for (const rot of [0, 90]) for (const [x, y] of cands) {
        const f = { type, x, y, rot }; const bb = G.bbox(Plan.furnPoly(f)); const big = [bb[0] - clear, bb[1] - clear, bb[2] + clear, bb[3] + clear];
        if (big[0] < q[0] - E || big[1] < q[1] - E || big[2] > q[2] + E || big[3] > q[3] + E) continue;
        if (obs.some(o => o.hard && bbHit(big, o.bb))) continue; if (!fits(f, q, obs)) continue; return f;
      }
      return null;
    }
    if (how === 'corner') {
      for (const s of [3, 1, 0, 2]) for (const end of [0, 1]) {
        const lo = s % 2 === 0 ? q[1] : q[0], hi = s % 2 === 0 ? q[3] : q[2]; const t = end ? hi - d.w / 2 - 0.02 : lo + d.w / 2 + 0.02;
        const f = atSide(type, q, s, t); if (fits(f, q, obs)) return f;
      }
      return null;
    }
    for (const s of sides) {
      const lo = s % 2 === 0 ? q[1] : q[0], hi = s % 2 === 0 ? q[3] : q[2]; if (hi - lo < d.w + 0.04) continue;
      const mid = (lo + hi) / 2; const ts = [];
      for (let k = 0; k <= (hi - lo); k += 0.1) { ts.push(mid + k / 2, mid - k / 2); }
      const pref = type === 'bett' || type === 'bett1' || type === 'sofa' || type === 'kueche' ? ts : ts.slice().sort((a, b) => Math.min(Math.abs(b - lo), Math.abs(hi - b)) - Math.min(Math.abs(a - lo), Math.abs(hi - a))).reverse();
      for (const t of pref) { if (t - d.w / 2 < lo - E || t + d.w / 2 > hi + E) continue; const f = atSide(type, q, s, t); if (fits(f, q, obs)) return f; }
    }
    return null;
  }
  function autos(P, r, q, obs) {
    const w = q[2] - q[0], h = q[3] - q[1]; const alongX = w >= h; const span = alongX ? w : h; const n = Math.max(1, Math.min(3, Math.floor((span + 0.3) / 2.8)));
    for (let i = 0; i < n; i++) {
      const t = (alongX ? q[0] : q[1]) + span * (i + 0.5) / n;
      const f = alongX ? { type: 'auto', x: t, y: (q[1] + q[3]) / 2, rot: 0 } : { type: 'auto', x: (q[0] + q[2]) / 2, y: t, rot: 90 };
      const bb = G.bbox(Plan.furnPoly(f)); if (bb[0] < q[0] - E || bb[2] > q[2] + E || bb[1] < q[1] - E || bb[3] > q[3] + E) continue;
      P.furniture.push({ ...f, id: uid('f'), level: r.level, auto: true });
    }
  }

  window.Layout = { generate, furnish, cls, TEMPLATES };
})();
