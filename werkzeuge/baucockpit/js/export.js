/* Baucockpit – Baueingabe-Paket (PDF), DXF, Übergabe-ZIP */
(function () {
  const { G, terrainAt, GeoAdmin } = Geo;
  const fN = Engine.fmtN;

  const PLAN_TYPES = { SI: 'Situation', GR: 'Grundriss', SN: 'Schnitt', NW: 'Nachweis', KO: 'Kosten' };
  function planNo(project, type, idx) { const p = (project.meta.projNr || '000.00').replace(/-$/, ''); return `${p}-33-${type}${String(idx).padStart(2, '0')}`; }

  /* ---------- Hilfen ---------- */
  function loadImage(url) { return new Promise((res) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => res(null); i.src = url; setTimeout(() => res(null), 12000); }); }
  async function imageToDataURL(url) { const img = await loadImage(url); if (!img) return null; try { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL('image/png'); } catch (e) { return null; } }

  /** Plankopf unten rechts */
  function titleBlock(doc, project, s, { title, scale, no, pageW, pageH }) {
    const w = 180, h = 46, x = pageW - w - 10, y = pageH - h - 10;
    doc.setDrawColor(30); doc.setLineWidth(0.35); doc.rect(x, y, w, h);
    doc.line(x, y + 12, x + w, y + 12); doc.line(x + 110, y + 12, x + 110, y + h); doc.line(x, y + 28, x + w, y + 28);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(project.name || 'Projekt', x + 3, y + 8);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text(`Bauherrschaft: ${project.meta.client || '–'}`, x + 3, y + 17);
    doc.text(`Parzelle ${project.parcel.number || '–'}, ${project.parcel.gemeinde || ''}  ·  EGRID ${project.parcel.egrid || '–'}`, x + 3, y + 22);
    doc.text(`Adresse: ${project.meta.address || '–'}`, x + 3, y + 26.5);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(title, x + 3, y + 35);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text(`${s.office || ''}`, x + 3, y + 40.5); doc.text(`${s.officeAddr || ''}${s.author ? '  ·  ' + s.author : ''}`, x + 3, y + 44.5);
    doc.text('Massstab', x + 113, y + 17); doc.setFont('helvetica', 'bold'); doc.text(scale, x + 135, y + 17);
    doc.setFont('helvetica', 'normal'); doc.text('Datum', x + 113, y + 22); doc.text(new Date().toLocaleDateString('de-CH'), x + 135, y + 22);
    doc.text('Phase', x + 113, y + 26.5); doc.text('SIA 33 Bewilligung', x + 135, y + 26.5);
    doc.text('Plan-Nr.', x + 113, y + 34); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(no, x + 113, y + 41);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(120); doc.text('Erstellt mit Baucockpit – Vorabklärung, ersetzt keine Prüfung durch die Baubehörde', x, y + h + 4); doc.setTextColor(0);
  }
  function northArrow(doc, x, y, rotRad) {
    const pts = [[0, -9], [4, 5], [0, 2], [-4, 5]].map(p => { const c = Math.cos(rotRad), s = Math.sin(rotRad); return [x + p[0] * c - p[1] * s, y + p[0] * s + p[1] * c]; });
    doc.setFillColor(20); doc.triangle(pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[2][0], pts[2][1], 'F'); doc.triangle(pts[0][0], pts[0][1], pts[2][0], pts[2][1], pts[3][0], pts[3][1], 'F');
    doc.setFontSize(9); doc.text('N', x - 1.5 + Math.sin(rotRad) * 13, y - Math.cos(rotRad) * 13);
  }
  function scaleBar(doc, x, y, mmPerM, meters) {
    doc.setLineWidth(0.3); const segs = 5; const L = meters * mmPerM;
    for (let i = 0; i < segs; i++) { if (i % 2 === 0) { doc.setFillColor(20); doc.rect(x + i * L / segs, y, L / segs, 1.6, 'F'); } else doc.rect(x + i * L / segs, y, L / segs, 1.6); }
    doc.setFontSize(7); doc.text('0', x - 0.8, y + 5); doc.text(`${meters} m`, x + L - 3, y + 5);
  }
  function poly(doc, pts, style) { if (pts.length < 2) return; const d = pts.slice(1).map((p, i) => [p[0] - pts[i][0], p[1] - pts[i][1]]); doc.lines(d, pts[0][0], pts[0][1], [1, 1], style || 'S', true); }
  function dimLine(doc, a, b, text) {
    doc.setLineWidth(0.15); doc.setDrawColor(40); doc.line(a[0], a[1], b[0], b[1]);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    for (const p of [a, b]) doc.line(p[0] - (ux + uy) * 0.9, p[1] - (uy - ux) * 0.9, p[0] + (ux + uy) * 0.9, p[1] + (uy - ux) * 0.9);
    let ang = Math.atan2(-(b[1] - a[1]), b[0] - a[0]) * 180 / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
    doc.setFontSize(7); doc.text(text, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 0.8, { angle: ang, align: 'center' });
  }

  /* ---------- PDF Baueingabe-Paket ---------- */
  async function buildPdf(project, settings, costs) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    // Standardschrift (WinAnsi): Hochzahlen und Sonderzeichen ersetzen
    const clean = t => Array.isArray(t) ? t.map(clean) : String(t).replace(/²/g, '2').replace(/³/g, '3').replace(/≈/g, 'ca.').replace(/→/g, '->');
    const _text = doc.text.bind(doc); doc.text = (t, ...a) => _text(clean(t), ...a);
    const v = project.variants.find(x => x.id === project.activeVariant);
    if (!v) throw new Error('Keine aktive Variante gewählt');
    const m = v.metrics; const parcel = project.parcel.polygon;
    let idx = { SI: 0, GR: 0, SN: 0, NW: 0, KO: 0 };
    const pages = [];

    /* 1 Deckblatt + Planverzeichnis (A4) */
    doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.text('Baueingabe-Paket', 20, 30);
    doc.setFontSize(14); doc.setFont('helvetica', 'normal'); doc.text(project.name || 'Projekt', 20, 40);
    doc.setFontSize(10);
    const info = [
      ['Bauherrschaft', project.meta.client || '–'], ['Adresse', project.meta.address || '–'],
      ['Parzelle / Gemeinde', `${project.parcel.number || '–'} / ${project.parcel.gemeinde || '–'} (${project.parcel.canton || 'SG'})`],
      ['EGRID', project.parcel.egrid || '–'], ['Zone', `${project.rules.zoneName} (${project.rules.system === 'BauG' ? 'altes BauG' : 'PBG'})`], ['Grundlage Zonenwerte', (project.rules.source || '').slice(0, 70)],
      ['Parzellenfläche', `${fN(m.parcelArea, 1)} m²`], ['Variante', `${v.name}`],
      ['Projektverfasser', `${settings.office || '–'}${settings.author ? ', ' + settings.author : ''}`], ['Datum', new Date().toLocaleDateString('de-CH')]
    ];
    let y = 55; for (const [k, val] of info) { doc.setTextColor(110); doc.text(k, 20, y); doc.setTextColor(0); doc.text(String(val), 70, y); y += 7; }
    y += 6; doc.setFont('helvetica', 'bold'); doc.text('Planverzeichnis', 20, y); y += 4; doc.setFont('helvetica', 'normal');
    const tocY = y; // wird am Ende gefüllt
    doc.setFontSize(8); doc.setTextColor(120);
    doc.text('Hinweis: Die Unterlagen sind eine automatisch erzeugte Vorabklärung auf Basis amtlicher Geodaten (geo.admin.ch) und', 20, 270);
    doc.text('erfassten Zonenwerten. Massgebend sind Baureglement, Zonenplan und ÖREB-Kataster der Gemeinde.', 20, 274); doc.setTextColor(0);

    /* 2 Situationsplan 1:500 (A3 quer) */
    doc.addPage('a3', 'landscape'); const PW = 420, PH = 297;
    idx.SI++; const siNo = planNo(project, 'SI', idx.SI); pages.push([siNo, 'Situation 1:500', doc.getNumberOfPages()]);
    const c = G.centroid(parcel); const mm = 2; // 1:500
    const ox = 150, oy = 140; const S = p => [ox + (p[0] - c[0]) * mm, oy - (p[1] - c[1]) * mm];
    // Hintergrund: Amtliche Vermessung
    const wM = 260, hM = 220; const bbox = [c[0] - wM / 2 / mm, c[1] - hM / 2 / mm, c[0] + wM / 2 / mm, c[1] + hM / 2 / mm];
    const bg = await imageToDataURL(GeoAdmin.wmsUrl('ch.kantone.cadastralwebmap-farbe', bbox, 1300, 1100));
    if (bg) { doc.addImage(bg, 'PNG', ox - wM / 2, oy - hM / 2, wM, hM, undefined, 'FAST'); doc.setDrawColor(200); doc.rect(ox - wM / 2, oy - hM / 2, wM, hM); }
    // Nachbargebäude, Planungsinhalte
    const inFrame = q => Math.abs(q[0] - (ox)) < wM / 2 && Math.abs(q[1] - oy) < hM / 2;
    if (!bg && project.context) { doc.setDrawColor(120); doc.setFillColor(225); doc.setLineWidth(0.15); for (const b of project.context.buildings || []) { const pts = b.poly.map(S); if (pts.every(inFrame)) poly(doc, pts, 'FD'); } }
    const pln = project.planning;
    if (pln) {
      doc.setLineWidth(0.35); doc.setDrawColor(179, 38, 30); doc.setLineDashPattern([3, 0.8, 0.6, 0.8], 0);
      for (const l of pln.lines || []) { const pts = l.coords.map(S).filter(inFrame); if (pts.length > 1) poly(doc, pts, 'S'); }
      doc.setDrawColor(122, 63, 176); doc.setLineDashPattern([1, 1], 0);
      for (const o of (pln.overlays || []).filter(o => o.snp || /gewässer/i.test(o.label || ''))) for (const rg of o.rings || []) { const pts = rg.map(S); if (pts.filter(inFrame).length > 2) poly(doc, pts.map(q => [Math.max(ox - wM / 2, Math.min(ox + wM / 2, q[0])), Math.max(oy - hM / 2, Math.min(oy + hM / 2, q[1]))]), 'S'); }
      doc.setLineDashPattern([], 0); doc.setDrawColor(0);
    }
    doc.setDrawColor(200, 40, 30); doc.setLineWidth(0.6); poly(doc, parcel.map(S), 'S');
    if (project.buildable) { doc.setDrawColor(40, 100, 150); doc.setLineWidth(0.25); doc.setLineDashPattern([1.5, 1], 0); poly(doc, project.buildable.map(S), 'S'); doc.setLineDashPattern([], 0); }
    doc.setDrawColor(0); doc.setLineWidth(0.5);
    for (const e of (project.site && project.site.extras) || []) { doc.setFillColor(e.type === 'zufahrt' || e.type === 'pp2' ? 225 : 195); doc.setDrawColor(90); doc.setLineWidth(0.2); poly(doc, e.poly.map(S), 'FD'); if (e.type !== 'zufahrt') { const c0 = S(G.centroid(e.poly)); doc.setFontSize(6.5); doc.text(e.name, c0[0], c0[1] + 1, { align: 'center' }); } }
    doc.setDrawColor(0); doc.setLineWidth(0.5);
    for (const p of v.parts) { doc.setFillColor(p.attika ? 120 : 150); poly(doc, p.poly.map(S), 'FD'); }
    // Grenzabstände
    const fp = G.union(v.parts.map(p => p.poly))[0];
    for (const e of m.edges) if (e.p && e.len > 2) dimLine(doc, S(e.q), S(e.p), `${fN(e.d, 2)}`);
    // Niveaupunkt + Koten
    const cc = S(G.centroid(fp)); doc.setFillColor(255); doc.circle(cc[0], cc[1], 1.5, 'FD'); doc.setFontSize(7);
    doc.text(`NP ${fN(m.niveau, 2)}`, cc[0] + 2.5, cc[1] - 1); doc.text(`OK EG ±0.00 = ${fN(v.parts[0].base, 2)} m ü.M.`, cc[0] + 2.5, cc[1] + 2.5);
    // Legende & Koordinaten
    let ly = 40; const lx = 300; doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.text('Legende', lx, ly); doc.setFont('helvetica', 'normal'); ly += 6; doc.setFontSize(8);
    const leg = [[[200, 40, 30], 'Parzellengrenze'], [[40, 100, 150], project.rules.system === 'BauG' ? `Baufeld (GA ${fN(project.rules.gaKlein, 1)} / ${fN(project.rules.gaGross, 1)} m)` : `Baufeld (Grenzabstand ${fN(project.rules.ga, 1)} m)`], [[150, 150, 150], 'Projektiertes Gebäude']];
    if (project.planning && project.planning.lines.length) leg.push([[179, 38, 30], 'Baulinie / Abstandslinie']);
    if (project.planning && project.planning.overlays.some(o => o.snp)) leg.push([[122, 63, 176], 'Sondernutzungsplan']);
    for (const [col, t] of leg) { doc.setDrawColor(...col); doc.setFillColor(...col); doc.rect(lx, ly - 2.5, 6, 3, col[0] === 150 ? 'F' : 'S'); doc.text(t, lx + 9, ly); ly += 5.5; }
    ly += 4; doc.setFont('helvetica', 'bold'); doc.text('Gebäudeecken LV95', lx, ly); doc.setFont('helvetica', 'normal'); ly += 5;
    fp.forEach((p, i) => { if (ly < 220) { doc.text(`P${i + 1}`, lx, ly); doc.text(`E ${fN(p[0], 2)}`, lx + 8, ly); doc.text(`N ${fN(p[1], 2)}`, lx + 42, ly); ly += 4.2; } });
    ly += 4; doc.setFont('helvetica', 'bold'); doc.text('Kennwerte', lx, ly); doc.setFont('helvetica', 'normal'); ly += 5;
    for (const ch of v.checks.filter(c => c.soll != null)) { if (ly > 225) break; doc.text(ch.label.replace(/\s\(.*\)/, ''), lx, ly); doc.text(`${Engine.fmtVal(ch.ist, ch.fmt)} / ${Engine.fmtVal(ch.soll, ch.fmt)}`, lx + 55, ly); doc.text(ch.status === 'ok' ? 'ok' : 'X', lx + 92, ly); ly += 4.2; }
    doc.setDrawColor(0); doc.setLineDashPattern([], 0); northArrow(doc, 40, 40, 0); scaleBar(doc, 25, 255, mm, 25);
    doc.setFontSize(7); doc.setTextColor(120); doc.text('Hintergrund: Amtliche Vermessung © Kantone / geo.admin.ch', 25, 263); doc.setTextColor(0);
    titleBlock(doc, project, settings, { title: 'Situation', scale: '1:500', no: siNo, pageW: PW, pageH: PH });

    /* 3 Grundrisse 1:100 */
    const P = project.plan; const hasPlan = P && P.walls.length && project.planFromVariant === v.id;
    if (hasPlan) {
      for (const l of P.levels.slice().sort((a, b) => a.z - b.z)) {
        doc.addPage('a3', 'landscape'); idx.GR++; const no = planNo(project, 'GR', idx.GR); pages.push([no, `Grundriss ${l.name} 1:100`, doc.getNumberOfPages()]);
        const pts = []; P.walls.filter(w => w.level === l.id).forEach(w => pts.push(w.a, w.b)); (l.outline || []).forEach(o => pts.push(...o));
        if (!pts.length) continue;
        const bb = G.bbox(pts); const s = 10; // 1:100
        const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2; const ox2 = 165, oy2 = 130;
        const T = p => [ox2 + (p[0] - cx) * s, oy2 - (p[1] - cy) * s];
        // Räume
        const inBld = poly => { const c0 = G.centroid(poly); return c0[0] >= bb[0] - 0.5 && c0[0] <= bb[2] + 0.5 && c0[1] >= bb[1] - 0.5 && c0[1] <= bb[3] + 0.5; };
        for (const r of P.rooms.filter(r => r.level === l.id && inBld(r.poly))) {
          doc.setFillColor(r.use === 'HNF' ? 248 : 240, r.use === 'HNF' ? 244 : 240, r.use === 'HNF' ? 236 : 240); poly(doc, r.poly.map(T), 'F');
          const rc = T(G.centroid(r.poly)); doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.text(r.name, rc[0], rc[1], { align: 'center' });
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.text(`${fN(G.absArea(r.poly), 1)} m²  ${r.use}`, rc[0], rc[1] + 4, { align: 'center' });
        }
        // Möbel
        doc.setDrawColor(130); doc.setLineWidth(0.12); for (const f of P.furniture.filter(f => f.level === l.id && inBld(Plan.furnPoly(f)))) poly(doc, Plan.furnPoly(f).map(T), 'S');
        // Wände
        doc.setFillColor(25); doc.setDrawColor(25);
        for (const w of P.walls.filter(w => w.level === l.id)) poly(doc, Plan.wallPoly(w).map(T), 'F');
        // Öffnungen
        for (const o of P.openings) {
          const w = P.walls.find(w => w.id === o.wall); if (!w || w.level !== l.id) continue;
          const L = G.dist(w.a, w.b); const u = [(w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L]; const n = [-u[1], u[0]]; const c0 = [w.a[0] + u[0] * L * o.pos, w.a[1] + u[1] * L * o.pos];
          const Q = (a, b) => T([c0[0] + u[0] * a + n[0] * b, c0[1] + u[1] * a + n[1] * b]); const hw = o.w / 2, ht = w.t / 2 + 0.02;
          doc.setFillColor(255); poly(doc, [Q(-hw, -ht), Q(hw, -ht), Q(hw, ht), Q(-hw, ht)], 'F');
          doc.setDrawColor(25); doc.setLineWidth(0.18);
          if (o.kind === 'garage') { const a = Q(-hw, 0), b = Q(hw, 0); doc.setLineDashPattern([1.5, 1], 0); doc.line(a[0], a[1], b[0], b[1]); doc.setLineDashPattern([], 0); }
          else if (o.type === 'window') { const a = Q(-hw, 0), b = Q(hw, 0); doc.line(a[0], a[1], b[0], b[1]); const a2 = Q(-hw, -ht), b2 = Q(-hw, ht); doc.line(a2[0], a2[1], b2[0], b2[1]); const a3 = Q(hw, -ht), b3 = Q(hw, ht); doc.line(a3[0], a3[1], b3[0], b3[1]); }
          else { const sd = o.flip ? -1 : 1, hs = o.hinge ? 1 : -1; const h0 = Q(hs * hw, sd * ht), t0 = Q(hs * hw, sd * (ht + o.w)); doc.line(h0[0], h0[1], t0[0], t0[1]); const arc = []; for (let i = 0; i <= 12; i++) { const a = i / 12 * Math.PI / 2; arc.push(Q(hs * hw - hs * Math.sin(a) * o.w, sd * (ht + Math.cos(a) * o.w))); } doc.setLineDashPattern([0.8, 0.8], 0); poly(doc, arc, 'S'); doc.setLineDashPattern([], 0); }
        }
        // Gesamtmasse
        const A1 = T([bb[0], bb[1] - 1.5]), B1 = T([bb[2], bb[1] - 1.5]); dimLine(doc, A1, B1, fN(bb[2] - bb[0], 2));
        const A2 = T([bb[0] - 1.5, bb[1]]), B2 = T([bb[0] - 1.5, bb[3]]); dimLine(doc, A2, B2, fN(bb[3] - bb[1], 2));
        doc.setFontSize(8); doc.text(`OK FB ${l.name} = ${l.z >= 0 ? '+' : ''}${fN(l.z, 2)} = ${fN(project.placement.base + l.z, 2)} m ü.M.`, 25, 250);
        northArrow(doc, 40, 40, -(project.placement.rot || 0)); scaleBar(doc, 25, 258, s, 5);
        titleBlock(doc, project, settings, { title: `Grundriss ${l.name}`, scale: '1:100', no, pageW: PW, pageH: PH });
      }
    }

    /* 4 Geländeschnitt 1:200 */
    doc.addPage('a3', 'landscape'); idx.SN++; const snNo = planNo(project, 'SN', idx.SN); pages.push([snNo, 'Geländeschnitt / Höhennachweis 1:200', doc.getNumberOfPages()]);
    {
      const ang = (v.angle || 0) + Math.PI / 2; const fc = G.centroid(fp); const dir = [Math.cos(ang), Math.sin(ang)];
      const half = 30; const s = 5; const ox3 = 210, oy3 = 170; const zRef = m.niveau;
      const X = d => ox3 + d * s, Y = h => oy3 - (h - zRef) * s;
      // Gelände
      const terr = []; for (let d = -half; d <= half; d += 0.5) terr.push([X(d), Y(terrainAt(project.terrain, fc[0] + dir[0] * d, fc[1] + dir[1] * d))]);
      doc.setDrawColor(90, 120, 60); doc.setLineWidth(0.5); poly(doc, terr, 'S');
      // Parzellengrenzen auf Schnittlinie
      for (let i = 0; i < parcel.length; i++) { const a = parcel[i], b = parcel[(i + 1) % parcel.length]; const hit = segLine(a, b, fc, dir); if (hit != null && Math.abs(hit) <= half) { doc.setDrawColor(200, 40, 30); doc.setLineWidth(0.3); doc.setLineDashPattern([2, 1], 0); doc.line(X(hit), Y(zRef) + 15, X(hit), Y(zRef) - project.rules.gh * s - 10); doc.setLineDashPattern([], 0); doc.setFontSize(7); doc.text('Grenze', X(hit) + 1, Y(zRef) + 14); } }
      // Gebäudeteile
      doc.setDrawColor(0); doc.setFillColor(200); doc.setLineWidth(0.4);
      for (const p of v.parts) {
        const ds = []; for (let i = 0; i < p.poly.length; i++) { const hit = segLine(p.poly[i], p.poly[(i + 1) % p.poly.length], fc, dir); if (hit != null) ds.push(hit); }
        if (ds.length >= 2) { const d0 = Math.min(...ds), d1 = Math.max(...ds); const top = Engine.partEave(p, v, project.rules); const tMin = Math.min(terrainAt(project.terrain, fc[0] + dir[0] * d0, fc[1] + dir[1] * d0), terrainAt(project.terrain, fc[0] + dir[0] * d1, fc[1] + dir[1] * d1)); doc.rect(X(d0), Y(top), (d1 - d0) * s, (top - Math.min(p.base, tMin)) * s, 'FD'); for (let f = 1; f < p.nf; f++) { const yy = Y(p.base + f * v.fh); doc.line(X(d0), yy, X(d1), yy); } }
      }
      // Höhenlimite
      doc.setDrawColor(40, 100, 150); doc.setLineDashPattern([3, 1.5], 0); doc.line(X(-half), Y(zRef + project.rules.gh), X(half), Y(zRef + project.rules.gh)); doc.setLineDashPattern([], 0);
      doc.setFontSize(8); doc.setTextColor(40, 100, 150); doc.text(`max. Gesamthöhe ${fN(project.rules.gh, 2)} m ab Niveaupunkt = ${fN(zRef + project.rules.gh, 2)} m ü.M.`, X(-half), Y(zRef + project.rules.gh) - 2); doc.setTextColor(0);
      doc.text(`Niveaupunkt ${fN(zRef, 2)} m ü.M.`, X(1), Y(zRef) + 5); doc.circle(X(0), Y(zRef), 1, 'S');
      doc.text(`Gesamthöhe Projekt: ${fN(m.gh, 2)} m  ·  Fassadenhöhe max.: ${fN(m.fh, 2)} m (zul. ${fN(project.rules.fh, 2)} m)`, 25, 250);
      scaleBar(doc, 25, 258, s, 10);
    }
    titleBlock(doc, project, settings, { title: 'Geländeschnitt / Höhennachweis', scale: '1:200', no: snNo, pageW: PW, pageH: PH });

    /* 5 Flächennachweis (A4) */
    doc.addPage('a4', 'portrait'); idx.NW++; const nwNo = planNo(project, 'NW', idx.NW); pages.push([nwNo, 'Flächen- und Ziffernnachweis', doc.getNumberOfPages()]);
    let yy = 20; doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text('Flächen- und Ziffernnachweis', 20, yy); yy += 6;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110); doc.text(`${nwNo}  ·  ${project.name}  ·  Variante ${v.name}  ·  ${new Date().toLocaleDateString('de-CH')}`, 20, yy); doc.setTextColor(0); yy += 10;
    const row = (cols, bold, xs = [20, 110, 145, 175]) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); cols.forEach((t, i) => doc.text(String(t), xs[i], yy, i ? { align: 'right' } : undefined)); yy += 6; };
    const xsR = [20, 135, 165, 190];
    doc.setFontSize(10); row(['Ziffer / Mass', 'Projekt', 'zulässig', 'Status'], true, xsR); doc.setLineWidth(0.2); doc.line(20, yy - 4, 190, yy - 4);
    for (const ch of v.checks) row([ch.label, Engine.fmtVal(ch.ist, ch.fmt), ch.soll == null ? '–' : Engine.fmtVal(ch.soll, ch.fmt), ch.status === 'ok' ? 'erfüllt' : ch.status === 'fail' ? 'NICHT erfüllt' : 'prüfen'], false, xsR);
    yy += 6; doc.setFontSize(10); row(['Flächen SIA 416', 'm² / m³', '', ''], true, xsR); doc.line(20, yy - 4, 190, yy - 4);
    row(['Grundstücksfläche GSF', fN(m.parcelArea, 1), '', ''], false, xsR);
    row(['Gebäudegrundfläche GGF (überbaut)', fN(m.footprintArea, 1), '', ''], false, xsR);
    row(['Umgebungsfläche UF', fN(m.parcelArea - m.footprintArea, 1), '', ''], false, xsR);
    row(['Geschossfläche GF total', fN(m.gf, 1), '', ''], false, xsR);
    if (hasPlan) {
      for (const a of Plan.areas(project)) row([`  ${a.level.name}: GF ${fN(a.gf, 1)} · NGF ${fN(a.ngf, 1)}`, `HNF ${fN(a.hnf, 1)}`, `NNF ${fN(a.nnf, 1)}`, `VF ${fN(a.vf, 1)}`], false, xsR);
    } else row(['Nettogeschossfläche NGF (Schätzung 82 % GF)', fN(m.ngfEst, 1), '', ''], false, xsR);
    row(['Gebäudevolumen GV', fN(m.gv, 0), '', ''], false, xsR);
    row(['Baumasse über massg. Terrain', fN(m.vAbove, 0), '', ''], false, xsR);
    if (hasPlan) {
      yy += 6; row(['Raumliste', 'Fläche', 'Nutzung', 'Geschoss'], true, xsR); doc.line(20, yy - 4, 190, yy - 4);
      for (const a of Plan.areas(project)) for (const r of a.rooms) { if (yy > 275) { doc.addPage('a4', 'portrait'); yy = 20; } row([r.name, fN(r.area, 1), r.use, a.level.name], false, xsR); }
    }

    /* 6 Kostenschätzung */
    if (costs) {
      doc.addPage('a4', 'portrait'); idx.KO++; const koNo = planNo(project, 'KO', idx.KO); pages.push([koNo, 'Grobkostenschätzung', doc.getNumberOfPages()]);
      yy = 20; doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text('Grobkostenschätzung (±25 %)', 20, yy); yy += 6;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110); doc.text(`${koNo}  ·  Standard ${Engine.COST_STANDARDS[costs.params.standard].name}  ·  Kennwert CHF ${costs.rate}/m³ GV  ·  inkl. MWST`, 20, yy); doc.setTextColor(0); yy += 10;
      doc.setFontSize(9); const xk = [20, 32, 150, 190];
      const krow = (cols, bold) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.text(cols[0], xk[0], yy); doc.text(cols[1], xk[1], yy); if (cols[3]) doc.text(cols[3], xk[3], yy, { align: 'right' }); yy += 4.5; if (cols[2]) { doc.setFontSize(7.5); doc.setTextColor(110); doc.text(cols[2], xk[1], yy); doc.setTextColor(0); doc.setFontSize(9); yy += 5; } };
      krow(['BKP', 'Position', '', 'CHF'], true); doc.line(20, yy - 3, 190, yy - 3);
      for (const l of costs.lines) krow([l.bkp, l.text, l.basis, fN(l.chf, 0)]);
      doc.line(20, yy - 2, 190, yy - 2); yy += 2; krow(['', 'Total Anlagekosten (ohne Land)', '', Engine.fmtCHF(costs.total)], true);
      krow(['', `Bandbreite ±25 %`, '', `${Engine.fmtCHF(costs.range[0])} – ${Engine.fmtCHF(costs.range[1])}`]);
      if (costs.land) krow(['', 'Landpreis', '', Engine.fmtCHF(costs.land)]);
      krow(['', 'Kennwerte', '', `CHF ${fN(costs.perM3, 0)}/m³ GV · CHF ${fN(costs.perM2, 0)}/m² GF`]);
      if ((project.selections || []).length) {
        yy += 6; doc.setFont('helvetica', 'bold'); doc.text('Material- und Produktentscheide', 20, yy); yy += 6; doc.setFont('helvetica', 'normal');
        for (const s of project.selections) { const it = settings._catalogMap[s.catalogId]; if (!it) continue; if (yy > 275) { doc.addPage('a4', 'portrait'); yy = 20; } doc.text(`${it.category}: ${it.name}${it.maker ? ' (' + it.maker + ')' : ''}`, 20, yy); doc.text(`${s.qty || 1} ${it.unit || 'Stk'} · ${s.status || 'offen'}`, 150, yy); doc.text(fN((s.qty || 1) * (it.price || 0), 0), 190, yy, { align: 'right' }); yy += 5; }
      }
    }

    /* Planverzeichnis nachtragen */
    doc.setPage(1); doc.setFontSize(9); let ty = tocY + 4;
    for (const [no, t, pg] of pages) { doc.setFont('helvetica', 'bold'); doc.text(no, 20, ty); doc.setFont('helvetica', 'normal'); doc.text(t, 62, ty); doc.text(`S. ${pg}`, 185, ty, { align: 'right' }); ty += 5.5; }
    return doc;
  }
  function segLine(a, b, o, dir) {
    // Schnitt Segment a-b mit Gerade o + t*dir → t
    const n = [-dir[1], dir[0]]; const da = (a[0] - o[0]) * n[0] + (a[1] - o[1]) * n[1], db = (b[0] - o[0]) * n[0] + (b[1] - o[1]) * n[1];
    if ((da > 0) === (db > 0) || da === db) return null; const t = da / (da - db); const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    return (p[0] - o[0]) * dir[0] + (p[1] - o[1]) * dir[1];
  }

  /* ---------- DXF (R12, LV95-georeferenziert) ---------- */
  function buildDxf(project) {
    const out = []; const L = (...a) => out.push(...a.map(String));
    const layers = new Set();
    const pl = (layer, pts, closed, z = 0) => { layers.add(layer); L(0, 'POLYLINE', 8, layer, 66, 1, 70, closed ? 1 : 0, 10, 0, 20, 0, 30, z); for (const p of pts) L(0, 'VERTEX', 8, layer, 10, p[0].toFixed(3), 20, p[1].toFixed(3), 30, z); L(0, 'SEQEND', 8, layer); };
    const txt = (layer, p, h, s) => { layers.add(layer); L(0, 'TEXT', 8, layer, 10, p[0].toFixed(3), 20, p[1].toFixed(3), 30, 0, 40, h, 1, s); };
    const ln = (layer, a, b) => { layers.add(layer); L(0, 'LINE', 8, layer, 10, a[0].toFixed(3), 20, a[1].toFixed(3), 30, 0, 11, b[0].toFixed(3), 21, b[1].toFixed(3), 31, 0); };
    const body = [];
    const v = project.variants.find(x => x.id === project.activeVariant);
    pl('BC_PARZELLE', project.parcel.polygon, true);
    if (project.buildable) pl('BC_BAUFELD', project.buildable, true);
    if (v) v.parts.forEach(p => pl('BC_VOLUMEN', p.poly, true, p.base));
    for (const e of (project.site && project.site.extras) || []) pl('BC_NEBENBAUTEN', e.poly, true);
    const P = project.plan;
    if (P && project.planFromVariant) for (const l of P.levels) {
      const tag = l.name.replace(/[^A-Za-z0-9]/g, '');
      for (const w of P.walls.filter(w => w.level === l.id)) pl(`BC_${tag}_WAND`, Plan.wallPoly(w).map(p => Plan.toWorld(project, p)), true);
      for (const r of P.rooms.filter(r => r.level === l.id)) { const wp = r.poly.map(p => Plan.toWorld(project, p)); pl(`BC_${tag}_RAUM`, wp, true); const c = G.centroid(wp); txt(`BC_${tag}_TEXT`, c, 0.25, `${r.name} ${fN(G.absArea(r.poly), 1)} m2`); }
      for (const f of P.furniture.filter(f => f.level === l.id)) pl(`BC_${tag}_MOEBEL`, Plan.furnPoly(f).map(p => Plan.toWorld(project, p)), true);
      for (const o of P.openings) {
        const w = P.walls.find(w => w.id === o.wall); if (!w || w.level !== l.id) continue;
        const Lw = G.dist(w.a, w.b); const u = [(w.b[0] - w.a[0]) / Lw, (w.b[1] - w.a[1]) / Lw]; const c = [w.a[0] + u[0] * Lw * o.pos, w.a[1] + u[1] * Lw * o.pos];
        ln(`BC_${tag}_${o.type === 'door' ? 'TUER' : 'FENSTER'}`, Plan.toWorld(project, [c[0] - u[0] * o.w / 2, c[1] - u[1] * o.w / 2]), Plan.toWorld(project, [c[0] + u[0] * o.w / 2, c[1] + u[1] * o.w / 2]));
      }
    }
    const ents = out.splice(0);
    L(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, 6, 0, 'ENDSEC');
    L(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, layers.size);
    let ci = 1; for (const la of layers) L(0, 'LAYER', 2, la, 70, 0, 62, (ci++ % 7) + 1, 6, 'CONTINUOUS');
    L(0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES'); out.push(...ents); L(0, 'ENDSEC', 0, 'EOF');
    return out.join('\r\n');
  }

  function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); }
  function safeName(s) { return (s || 'Projekt').replace(/[^\wäöüÄÖÜ.\- ]+/g, '').trim().replace(/\s+/g, '_'); }

  window.Exporter = { buildPdf, buildDxf, download, safeName, planNo, PLAN_TYPES };
})();
