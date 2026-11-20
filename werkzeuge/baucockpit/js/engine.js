/* Baucockpit – Baurecht, Variantengenerator, Kennzahlen, Kosten */
(function () {
  const { G, terrainAt } = Geo;

  /* ---------- Zonen-Vorlagen Kanton St. Gallen (PBG SG, Begriffe IVHB-nah) ----------
     Musterwerte – IMMER gegen das kommunale Baureglement / Zonenplan prüfen und anpassen. */
  const ZONES_SG = [
    { key: 'W1', name: 'Wohnzone W1', uez: 0.30, bmz: 1.6, gfz: 0.40, ga: 4.0, gh: 8.0, fh: 6.5, gl: 25, vg: 1, note: 'Muster' },
    { key: 'W2', name: 'Wohnzone W2', uez: 0.30, bmz: 2.2, gfz: 0.35, ga: 5.0, gh: 10.5, fh: 8.0, gl: 30, vg: 2, note: 'Muster' },
    { key: 'W3', name: 'Wohnzone W3', uez: 0.35, bmz: 3.2, gfz: 0.30, ga: 6.0, gh: 13.5, fh: 11.0, gl: 40, vg: 3, note: 'Muster' },
    { key: 'WG2', name: 'Wohn-/Gewerbezone WG2', uez: 0.35, bmz: 2.6, gfz: 0.25, ga: 5.0, gh: 11.0, fh: 8.5, gl: 35, vg: 2, note: 'Muster' },
    { key: 'WG3', name: 'Wohn-/Gewerbezone WG3', uez: 0.40, bmz: 3.6, gfz: 0.20, ga: 6.0, gh: 14.0, fh: 11.5, gl: 45, vg: 3, note: 'Muster' },
    { key: 'K', name: 'Kernzone', uez: null, bmz: null, gfz: null, ga: 4.0, gh: 13.0, fh: 10.0, gl: 35, vg: 3, note: 'Muster – Einordnung/Ortsbild massgebend' },
    { key: 'M', name: 'Manuell (eigene Werte)', uez: null, bmz: null, gfz: null, ga: 4.0, gh: 12.0, fh: 9.0, gl: 30, vg: 2, note: 'Manuell' }
  ];

  /* Altes Baugesetz SG (BauG 1972): Gebäude-/Firsthöhe, AZ, kleiner/grosser Grenzabstand, Mehrlängenzuschlag.
     Viele SG-Gemeinden wenden bis zur Revision noch diese Regelbauweise an (Zonenbezeichnung «BauG_…» in der Nutzungsplanung). */
  const ZONES_BAUG = [
    { key: 'B-W1', name: 'Wohnzone W1 (BauG)', system: 'BauG', vg: 1, az: 0.40, gaKlein: 4, gaGross: 6, gbh: 5.0, firsth: 9.0, gl: 25, note: 'Muster altes BauG' },
    { key: 'B-W2', name: 'Wohnzone W2 (BauG)', system: 'BauG', vg: 2, az: 0.50, gaKlein: 4, gaGross: 7, gbh: 7.5, firsth: 11.5, gl: 30, note: 'Muster altes BauG' },
    { key: 'B-W3', name: 'Wohnzone W3 (BauG)', system: 'BauG', vg: 3, az: 0.65, gaKlein: 5, gaGross: 9, gbh: 10.5, firsth: 14.0, gl: 40, note: 'Muster altes BauG' },
    { key: 'B-WG2', name: 'Wohn-/Gewerbezone WG2 (BauG)', system: 'BauG', vg: 2, az: 0.55, gaKlein: 4, gaGross: 7, gbh: 7.5, firsth: 12.0, gl: 35, note: 'Muster altes BauG' },
    { key: 'B-WG3', name: 'Wohn-/Gewerbezone WG3 (BauG)', system: 'BauG', vg: 3, az: 0.70, gaKlein: 5, gaGross: 8, gbh: 10.5, firsth: 14.0, gl: 40, note: 'Muster altes BauG' },
    { key: 'B-K', name: 'Kernzone (BauG)', system: 'BauG', vg: 3, az: null, gaKlein: 4, gaGross: 4, gbh: 10.0, firsth: 14.0, gl: 40, note: 'Muster – Einordnung massgebend' },
    { key: 'B-GI', name: 'Gewerbe-/Industriezone (BauG)', system: 'BauG', vg: 4, az: null, gaKlein: 5, gaGross: 5, gbh: 14.0, firsth: 16.0, gl: 80, note: 'Muster altes BauG' }
  ];
  /** Gemeindebibliothek (BFS-Nr.) – Werte aus Baureglementen, Quelle angegeben. Erweiterbar über «Als Zonenvorlage speichern». */
  const MUNI = {
    3408: { name: 'Uzwil', system: 'BauG', source: 'Baureglement Uzwil inkl. Änderung 2022, Art. 31 (Grundmasse) – Spaltenzuordnung am Original prüfen', url: 'https://www.uzwil.ch/gemeinde/news/oeffentliche-auflagen/2023/2023-03-10_baureglement-inkl.-aenderung-2022-version-fuer-referendum.pdf',
      mlz: { from: 20, f: 0.25, max: 6 }, kn: 0.9, ugMax: 1.2,
      zones: {
        WL: { name: 'Wohnzone Landhäuser WL', vg: 2, az: 0.15, gaKlein: 4, gaGross: 4, gbh: 7.5, firsth: 12.25, gl: 35 },
        WE: { name: 'Wohnzone Ein-/Zweifamilienhäuser WE', vg: 2, az: null, gaKlein: 4, gaGross: 8, gbh: 7.5, firsth: 12.25, gl: 28 },
        W2: { name: 'Wohnzone W2', vg: 2, az: 0.55, gaKlein: 4, gaGross: 8, gbh: 7.5, firsth: 12.25, gl: 35 }, WG2: { name: 'Wohn-/Gewerbezone WG2', vg: 2, az: 0.55, gaKlein: 4, gaGross: 8, gbh: 7.5, firsth: 12.25, gl: 35 },
        W3: { name: 'Wohnzone W3', vg: 3, az: 0.65, gaKlein: 5, gaGross: 10, gbh: 10.25, firsth: 13.75, gl: 40 }, WG3: { name: 'Wohn-/Gewerbezone WG3', vg: 3, az: 0.65, gaKlein: 5, gaGross: 10, gbh: 10.25, firsth: 13.75, gl: 40 },
        W4: { name: 'Wohnzone W4', vg: 4, az: 0.75, gaKlein: 6, gaGross: 12, gbh: 13.0, firsth: 16.5, gl: 45 }, WG4: { name: 'Wohn-/Gewerbezone WG4', vg: 4, az: 0.75, gaKlein: 6, gaGross: 12, gbh: 13.0, firsth: 16.5, gl: 45 },
        GI: { name: 'Gewerbe-Industriezone GI', vg: 4, az: null, gaKlein: 5, gaGross: 5, gbh: 16.5, firsth: 16.5, gl: 999 }, I: { name: 'Industriezone I', vg: 9, az: null, gaKlein: 5, gaGross: 5, gbh: 25, firsth: 25, gl: 999 },
        DK: { name: 'Dorfkernzone DK', vg: 3, az: null, gaKlein: 5, gaGross: 5, gbh: 10.0, firsth: 14.0, gl: 40 }, KB: { name: 'Kernzone Bestand KB', vg: 3, az: null, gaKlein: 4, gaGross: 4, gbh: 10.0, firsth: 14.0, gl: 40 },
        KE: { name: 'Kernzone Entwicklung KE', vg: 5, az: null, gaKlein: 4, gaGross: 6, gbh: 15.75, firsth: 19.25, gl: 60 }
      } },
    3443: { name: 'Gossau', system: 'BauG', source: 'Baureglement Gossau 1994 mit Nachträgen bis 2011, Art. 22 (Tabelle der Grundmasse; AZ-Artikel seit 1.10.2017 nicht mehr anwendbar)', url: 'https://oereblex.sg.ch/api/attachments/16666',
      zones: {
        WE: { name: 'Wohnzone WE', vg: 2, az: 0.4, gaKlein: 4, gaGross: 8, gbh: 6.5, firsth: 9.0, gl: 38, gt: 14 },
        W2: { name: 'Wohnzone W2', vg: 2, az: 0.5, gaKlein: 4.5, gaGross: 9, gbh: 7.5, firsth: 11.0, gl: 38, gt: 14 },
        W3: { name: 'Wohnzone W3', vg: 3, az: 0.65, gaKlein: 5, gaGross: 10, gbh: 10.2, firsth: 14.2, gl: 45, gt: 14 },
        W4: { name: 'Wohnzone W4', vg: 4, az: 0.8, gaKlein: 6, gaGross: 12, gbh: 13.0, firsth: 17.0, gl: 45, gt: 14 },
        WG2: { name: 'Wohn-/Gewerbezone WG2', vg: 2, az: 0.5, gaKlein: 4.5, gaGross: 9, gbh: 7.5, firsth: 11.0, gl: 38, gt: 20 },
        WG3: { name: 'Wohn-/Gewerbezone WG3', vg: 3, az: 0.65, gaKlein: 5, gaGross: 10, gbh: 10.2, firsth: 14.2, gl: 45, gt: 20 },
        WG4: { name: 'Wohn-/Gewerbezone WG4', vg: 4, az: 0.8, gaKlein: 6, gaGross: 12, gbh: 13.0, firsth: 17.0, gl: 45, gt: 20 },
        DK: { name: 'Dorfkernzone DK', vg: 2, az: null, gaKlein: 4, gaGross: 8, gbh: 7.5, firsth: 13.0, gl: 38, gt: 20 }
      } },
    3213: { name: 'Goldach', system: 'BauG', source: 'Baureglement Goldach, Fassung 1.7.2023, Art. 6 (Wohn- und WG-Zonen)', url: 'https://oereblex.sg.ch/api/attachments/18205',
      zones: {
        W2a: { name: 'Wohnzone W2a', vg: 2, az: 0.45, gaKlein: 5, gaGross: 8, gbh: 7.0, firsth: 11.0, gl: 30 },
        W2b: { name: 'Wohnzone W2b', vg: 2, az: 0.55, gaKlein: 5, gaGross: 10, gbh: 7.5, firsth: 11.5, gl: 35 },
        W3: { name: 'Wohnzone W3', vg: 3, az: 0.70, gaKlein: 6, gaGross: 12, gbh: 10.0, firsth: 14.0, gl: 50 },
        W4: { name: 'Wohnzone W4', vg: 4, az: 0.90, gaKlein: 7, gaGross: 14, gbh: 12.5, firsth: 16.5, gl: 50 },
        WG2: { name: 'Wohn-/Gewerbezone WG2', vg: 2, az: null, gaKlein: 5, gaGross: 10, gbh: 7.5, firsth: 11.5, gl: 50 },
        WG3: { name: 'Wohn-/Gewerbezone WG3', vg: 3, az: null, gaKlein: 6, gaGross: 12, gbh: 10.0, firsth: 14.0, gl: 50 },
        WG4: { name: 'Wohn-/Gewerbezone WG4', vg: 4, az: null, gaKlein: 7, gaGross: 14, gbh: 12.5, firsth: 16.5, gl: 50 }
      } },
    3215: { name: 'Steinach', system: 'BauG', source: 'Baureglement Steinach 1999, Art. 9–17', url: 'https://oereblex.sg.ch/api/attachments/9276',
      zones: {
        KI: { name: 'Kernzone I', vg: 3, az: 0.70, gaKlein: 4, gaGross: 4, gbh: 10.5, firsth: 15.0, gl: 35 }, KII: { name: 'Kernzone II', vg: 2, az: 0.50, gaKlein: 4, gaGross: 4, gbh: 8.0, firsth: 12.0, gl: 30 },
        W2: { name: 'Wohnzone W2', vg: 2, az: 0.40, gaKlein: 4, gaGross: 8, gbh: 7.0, firsth: 10.5, gl: 25 }, W3: { name: 'Wohnzone W3', vg: 3, az: 0.50, gaKlein: 5, gaGross: 10, gbh: 9.5, firsth: 13.5, gl: 35 },
        W4: { name: 'Wohnzone W4', vg: 4, az: 0.60, gaKlein: 5, gaGross: 10, gbh: 12.0, firsth: 16.0, gl: 40 },
        WG2: { name: 'Wohn-/Gewerbezone WG2', vg: 2, az: 0.50, gaKlein: 4, gaGross: 8, gbh: 7.5, firsth: 11.0, gl: 30 }, WG3: { name: 'Wohn-/Gewerbezone WG3', vg: 3, az: 0.60, gaKlein: 5, gaGross: 10, gbh: 11.0, firsth: 14.5, gl: 40 },
        GI: { name: 'Gewerbe-Industriezone GI', vg: 9, az: null, gaKlein: 4, gaGross: 4, gbh: 12.0, firsth: 14.0, gl: 999 }, I: { name: 'Industriezone I', vg: 9, az: null, gaKlein: 5, gaGross: 5, gbh: 14.0, firsth: 16.0, gl: 999 }
      } },
    3442: { name: 'Gaiserwald', system: 'BauG', partial: true, source: 'III. Nachtrag Baureglement Gaiserwald (11.8.2003), Art. 8 – nur WG-Zonen; übrige Zonen gemäss Baureglement 2015 erfassen', url: 'https://www.gaiserwald.ch/_docn/34887/III.%20Nachtrag%20zum%20Baureglement.pdf',
      zones: {
        WG2: { name: 'Wohn-/Gewerbezone WG2', vg: 2, az: 0.5, gaKlein: 5, gaGross: 5, gbh: 8.5, firsth: 12.5, gl: 30 },
        WG3: { name: 'Wohn-/Gewerbezone WG3', vg: 3, az: 0.6, gaKlein: 6, gaGross: 6, gbh: 11.0, firsth: 15.0, gl: 40 },
        WG4: { name: 'Wohn-/Gewerbezone WG4', vg: 4, az: 0.7, gaKlein: 7, gaGross: 7, gbh: 13.5, firsth: 17.5, gl: 50 }
      } },
    3427: { name: 'Wil', system: 'BauG', partial: true, source: 'Baureglement Wil 1992 – weiter anwendbare Artikel (Kernzone, W1); übrige Zonen gemäss Baureglement 2020 erfassen', url: 'https://stadtwil.ch/_doc/3000103',
      zones: {
        K: { name: 'Kernzone K', vg: 3, az: null, gaKlein: 4, gaGross: 4, gbh: 9.5, firsth: 13.5, gl: 40, gt: 24 },
        W1: { name: 'Wohnzone W1', vg: 1, az: 0.40, gaKlein: 4, gaGross: 6, gbh: 5.0, firsth: 9.0, gl: 25 }
      } }
  };
  function defaultRules(zoneKey = 'W2') {
    const z = ZONES_SG.concat(ZONES_BAUG).find(z => z.key === zoneKey) || ZONES_SG[1];
    const base = { floorHeight: 3.0, sockel: 0.15, roofBuildup: 0.5, hardscape: null, mlz: { from: 20, f: 0.25, max: 6 }, abgrabMax: 1.5, aufschMax: 1.5 };
    if (z.system === 'BauG') return Object.assign(base, { system: 'BauG', zoneKey: z.key, zoneName: z.name, vg: z.vg, az: z.az, gaKlein: z.gaKlein, gaGross: z.gaGross, ga: z.gaKlein, gbh: z.gbh, firsth: z.firsth, gh: z.firsth, fh: z.gbh, gl: z.gl, uez: null, bmz: null, gfz: null, source: 'Musterwerte altes BauG SG – gegen Baureglement prüfen' });
    return Object.assign(base, { system: 'PBG', zoneKey: z.key, zoneName: z.name, uez: z.uez, bmz: z.bmz, gfz: z.gfz, ga: z.ga, gh: z.gh, fh: z.fh, gl: z.gl, vg: z.vg, source: 'Musterwerte PBG SG – gegen Baureglement prüfen' });
  }
  /** Regeln aus Nutzungsplanung + Gemeindebibliothek ableiten */
  function rulesFromPlanning(project) {
    const pl = project.planning; const bfs = Number(project.parcel.bfs) || 0; const lib = MUNI[bfs];
    const label = (pl && pl.zone && pl.zone.label) || (project.parcel.zone && project.parcel.zone.label) || '';
    const tok = (label.match(/\b(W[A-Z]?\d?[a-z]?|WG\d|WE|WL|DK\d?|KB|KE|K\d?|GI|I|G\d?)\b(?!.*\b(W[A-Z]?\d|WG\d|DK|GI)\b)/) || [])[1] || '';
    const sys = (pl && pl.system) || (lib && lib.system) || 'PBG';
    if (lib && lib.zones) {
      const key = Object.keys(lib.zones).find(k => k === tok) || Object.keys(lib.zones).find(k => tok.startsWith(k)) || Object.keys(lib.zones).find(k => label.includes(k));
      if (key) { const z = lib.zones[key]; const r = defaultRules(sys === 'BauG' ? 'B-W2' : 'W2'); Object.assign(r, z, { system: lib.system, zoneKey: `${bfs}-${key}`, zoneName: `${lib.name}: ${z.name}`, ga: z.gaKlein ?? z.ga, gh: z.firsth ?? z.gh, fh: z.gbh ?? z.fh, mlz: lib.mlz || r.mlz, source: lib.source, sourceUrl: lib.url }); return r; }
    }
    const g = guessZone(label);
    if (sys === 'BauG') { const map = { W1: 'B-W1', W2: 'B-W2', W3: 'B-W3', WG2: 'B-WG2', WG3: 'B-WG3', K: 'B-K', M: 'B-W2' }; const k = /GEWERBE|INDUSTRIE|ARBEIT/i.test(label) ? 'B-GI' : map[g] || 'B-W2'; return defaultRules(k); }
    return defaultRules(g);
  }

  /** Zonenvorschlag aus Bauzonen-Bezeichnung */
  function guessZone(label) {
    const s = (label || '').toUpperCase();
    if (/KERN|DORF|ZENTRUM|\bDK|\bK\d/.test(s)) return 'K';
    if (/GEWERBE|MISCH|ARBEIT/.test(s)) return /3/.test(s) ? 'WG3' : 'WG2';
    if (/WOHN|\bW\d/.test(s)) { if (/W\s?3|3/.test(s)) return 'W3'; if (/W\s?1|1/.test(s)) return 'W1'; return 'W2'; }
    return 'W2';
  }

  /* ---------- Varianten-Formen (lokal, Achse x = Längsrichtung, y = Tiefe Richtung "bergauf") ---------- */
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const TYPES = {
    laengs: { name: 'Längsbau', desc: 'Kompakter Riegel entlang der langen Parzellenseite', ratio: 2.2 },
    kubus: { name: 'Kubus / Punktbau', desc: 'Kompakt, minimale Hüllfläche, gute Energiebilanz', ratio: 1.15 },
    lform: { name: 'L-Form', desc: 'Zwei Flügel, geschützter Aussenraum', ratio: 1.6 },
    staffel: { name: 'Staffelhaus', desc: 'Zwei versetzte Volumen, folgt dem Gelände (Split-Level)', ratio: 1.8 },
    terrasse: { name: 'Terrassenhaus', desc: 'Geschosse treppen gegen den Hang zurück, Terrassen auf den Dächern', ratio: 1.8 }
  };

  /** Teile einer Variante in lokalen Koordinaten, Grösse s = Länge [m] */
  function shapeParts(type, L, floors, fh) {
    switch (type) {
      case 'laengs': { const W = Math.min(13, Math.max(8, L / 2.2)); return [{ poly: rect(-L / 2, -W / 2, L / 2, W / 2), f0: 0, nf: floors }]; }
      case 'kubus': { const W = L / 1.15; return [{ poly: rect(-L / 2, -W / 2, L / 2, W / 2), f0: 0, nf: floors }]; }
      case 'lform': {
        const W = Math.min(10, Math.max(7, L / 3)); const L2 = L * 0.7;
        const poly = [[-L / 2, -L2 / 2], [L / 2, -L2 / 2], [L / 2, -L2 / 2 + W], [-L / 2 + W, -L2 / 2 + W], [-L / 2 + W, L2 / 2], [-L / 2, L2 / 2]];
        return [{ poly, f0: 0, nf: floors }];
      }
      case 'staffel': {
        const W = Math.min(11, Math.max(7, L / 3.2)); const off = W * 0.45;
        return [
          { poly: rect(-L / 2, -W, 0, 0), f0: 0, nf: floors, followTerrain: true },
          { poly: rect(0, -W + off, L / 2, off), f0: 0, nf: floors, followTerrain: true }
        ];
      }
      case 'terrasse': {
        const D = Math.min(12, Math.max(8, L / 2.4)); const step = Math.max(3, D * 0.35);
        const parts = [];
        for (let k = 0; k < floors; k++) parts.push({ poly: rect(-L / 2, -D / 2 + k * step, L / 2, D / 2 + k * step * 0.15), f0: k, nf: 1, terrace: k > 0 });
        return parts;
      }
    }
  }

  /* ---------- Dachformen ---------- */
  const ROOFS = { flach: 'Flachdach', attika: 'Flachdach mit Attika', sattel: 'Satteldach', pult: 'Pultdach' };
  const UG_H = 2.8;
  /** Firsthöhe über Kniestock (Steildach) */
  function roofRise(p) { if (!p.roof) return 0; const mr = G.minRect(p.poly); const tan = Math.tan((p.roof.pitch || 30) * Math.PI / 180); return p.roof.type === 'pult' ? mr.wid * tan : mr.wid / 2 * tan; }
  /** Oberkante Teilvolumen (höchster Punkt) und Traufe */
  function partTop(p, v, r) { const top0 = p.base + p.nf * v.fh; if (p.roof) return top0 + (p.roof.kn || 1.0) + roofRise(p) + 0.3; return top0 + r.roofBuildup; }
  function partEave(p, v, r) { const top0 = p.base + p.nf * v.fh; return p.roof ? top0 + (p.roof.kn || 1.0) + 0.3 : top0 + r.roofBuildup; }

  /** Typologie auf Variante anwenden: UG, Dachform */
  function applyTypology(v, project, typ) {
    const t = Object.assign({ ug: false, roof: 'flach', pitch: 30, kn: 1.0, attikaSet: 1.5 }, typ || v.typ || {});
    v.parts = v.parts.filter(p => !p.attika); v.parts.forEach(p => delete p.roof);
    v.ug = !!t.ug; v.typ = t;
    const maxF0 = Math.max(...v.parts.map(p => p.f0));
    const tops = v.type === 'terrasse' ? v.parts.filter(p => p.f0 === maxF0) : v.parts.slice();
    const pref = frontVec(project);
    const attikaPoly = (poly, set) => {
      const ang = v.angle || 0; const loc = G.rotatePoly(poly, -ang, [0, 0]); const rects = G.rectDecompose(loc);
      if (rects.length !== 1) return G.offset(poly, -set)[0];
      let [x0, y0, x1, y1] = rects[0]; const W = x1 - x0, D = y1 - y0;
      const front = G.rotate([0, -1], ang); const frontLow = front[0] * pref[0] + front[1] * pref[1] >= 0; // lokale -y Seite zeigt nach vorne
      const side = Math.min(1.0, W * 0.08), fr = Math.min(Math.max(set * 2, 2.5), D * 0.35);
      x0 += side; x1 -= side; if (frontLow) y0 += fr; else y1 -= fr;
      return G.rotatePoly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], ang, [0, 0]);
    };
    if (t.roof === 'attika') for (const p of tops) {
      let inset = null; for (const sb of [t.attikaSet, 1.0, 0.6]) { inset = attikaPoly(p.poly, sb); if (inset && G.absArea(inset) > 25) break; inset = null; }
      if (inset) v.parts.push({ poly: inset, base: p.base + p.nf * v.fh, nf: 1, f0: p.f0 + p.nf, attika: true, label: 'Attika' });
    }
    if (t.roof === 'sattel' || t.roof === 'pult') for (const p of tops) p.roof = { type: t.roof, pitch: Number(t.pitch) || (t.roof === 'pult' ? 12 : 30), kn: Number(t.kn) || 1.0 };
    if (project.terrain) placeHeights(v, project);
    return evaluate(v, project);
  }

  /* ---------- Nebenbauten / Parkierung ---------- */
  const PARKING = { none: 'keine', pp2: '2 Aussenparkplätze', carport: 'Carport 2 PP', garage_ext: 'Garage separat 2 PP', garage_int: 'Garage im Gebäude' };
  const EXTRA_DIM = { pp2: { w: 5.5, d: 5.0, h: 0, name: 'Parkplätze' }, carport: { w: 6.0, d: 6.0, h: 2.6, name: 'Carport' }, garage_ext: { w: 6.4, d: 6.4, h: 2.9, name: 'Garage' } };
  /** Erschliessungsseite: Index der Parzellenkante (Standard: tiefste Kante) */
  function accessEdge(project) {
    const pc = project.parcel.polygon; const s = project.site || {};
    if (s.accessEdge != null && s.accessEdge < pc.length) return s.accessEdge;
    let best = 0, bh = Infinity;
    pc.forEach((a, i) => { const b = pc[(i + 1) % pc.length]; const h = project.terrain ? terrainAt(project.terrain, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2) : i; if (G.dist(a, b) > 6 && h < bh) { bh = h; best = i; } });
    return best;
  }
  function computeExtras(project, v) {
    const site = project.site || (project.site = { parking: 'none' }); site.extras = [];
    const dim = EXTRA_DIM[site.parking]; if (!dim || !v) return [];
    const pc = project.parcel.polygon; const i = accessEdge(project); const a = pc[i], b = pc[(i + 1) % pc.length];
    const L = G.dist(a, b); const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; const n = [-u[1], u[0]]; // CCW → links = innen
    const fp = G.union(v.parts.map(p => p.poly)); const keep = fp.map(f => G.offset(f, 1.0)[0] || f);
    const fc = G.centroid(fp[0]); const tc = (fc[0] - a[0]) * u[0] + (fc[1] - a[1]) * u[1];
    const off = site.parking === 'pp2' ? 0.0 : 1.0; let best = null;
    for (let t = 0.3; t <= L - dim.w - 0.3; t += 0.25) {
      const P = (s, d) => [a[0] + u[0] * (t + s) + n[0] * (off + d), a[1] + u[1] * (t + s) + n[1] * (off + d)];
      const poly = [P(0, 0), P(dim.w, 0), P(dim.w, dim.d), P(0, dim.d)];
      if (!G.inside(poly, pc, 0.05)) continue;
      const hit = keep.some(k => G.clip([poly], [k], ClipperLib.ClipType.ctIntersection).reduce((s2, q) => s2 + G.absArea(q), 0) > 0.05);
      if (hit) continue;
      const score = Math.abs(t + dim.w / 2 - tc); if (!best || score < best.score) best = { score, poly, t };
    }
    if (!best) return [];
    const ex = { type: site.parking, name: dim.name, poly: G.ensureCCW(best.poly), h: dim.h, edge: i, doorSide: [a[0] + u[0] * (best.t + dim.w / 2), a[1] + u[1] * (best.t + dim.w / 2)] };
    const terr = ex.poly.map(q => terrainAt(project.terrain, q[0], q[1])); ex.base = Math.max(...terr) - 0.0;
    site.extras = [ex];
    if (off > 0) site.extras.push({ type: 'zufahrt', name: 'Zufahrt', poly: G.ensureCCW([best.poly[0], best.poly[1], [best.poly[1][0] - n[0] * off, best.poly[1][1] - n[1] * off], [best.poly[0][0] - n[0] * off, best.poly[0][1] - n[1] * off]]), h: 0, base: ex.base });
    return site.extras;
  }


  /* ---------- Orientierung, Baufeld, Baulinien, Höhenlage ---------- */
  function frontVec(project) {
    const parcel = project.parcel.polygon; const sl = Geo.slopeOf(project.terrain, parcel);
    if (sl.pct > 5) return [Math.cos(sl.dir), Math.sin(sl.dir)];
    const pc = parcel, i = accessEdge(project), a = pc[i], b = pc[(i + 1) % pc.length], c = G.centroid(pc);
    if (project.site && project.site.accessEdge != null) { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; const d = [c[0] - m[0], c[1] - m[1]]; const L = Math.hypot(...d) || 1; return [d[0] / L, d[1] / L]; }
    return [0, -1];
  }
  /** Parzellenkante der Hauptwohnseite (grosser Grenzabstand) */
  function frontEdge(project) {
    const pc = project.parcel.polygon; const f = frontVec(project); let best = 0, bd = -Infinity;
    pc.forEach((a, i) => { const b = pc[(i + 1) % pc.length]; const L = G.dist(a, b) || 1; const n = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L]; const d = n[0] * f[0] + n[1] * f[1]; if (L > 4 && d > bd) { bd = d; best = i; } });
    return best;
  }
  /** Sperrflächen jenseits von Baulinien, Wald- und Gewässerabstandslinien */
  function forbidden(project) {
    const lines = ((project.planning && project.planning.lines) || []).filter(l => l.code === 71 || /baulinie|abstand|niveau/i.test((l.typ || '') + ' ' + (l.label || '')) && !/niveau/i.test(l.typ || ''));
    const c = G.centroid(project.parcel.polygon); const quads = [];
    for (const l of lines) for (let i = 1; i < l.coords.length; i++) {
      const a = l.coords[i - 1], b = l.coords[i]; const L = G.dist(a, b); if (L < 0.2) continue;
      const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; let n = [-u[1], u[0]];
      if ((c[0] - a[0]) * n[0] + (c[1] - a[1]) * n[1] > 0) n = [-n[0], -n[1]]; // weg von der Parzelle
      const e = 0.5, D = 400;
      quads.push([[a[0] - u[0] * e, a[1] - u[1] * e], [b[0] + u[0] * e, b[1] + u[1] * e], [b[0] + u[0] * e + n[0] * D, b[1] + u[1] * e + n[1] * D], [a[0] - u[0] * e + n[0] * D, a[1] - u[1] * e + n[1] * D]]);
    }
    // Gewässerraum (überlagernde Fläche) ist nicht überbaubar
    for (const o of ((project.planning && project.planning.overlays) || []).filter(o => /gewässerraum|gewaesserraum/i.test((o.label || '') + ' ' + (o.typ || '')))) for (const rg of o.rings || []) if (rg.length > 2) quads.push(rg);
    return quads.length ? G.union(quads.map(G.ensureCCW)) : [];
  }
  function buildableArea(project, margin = 0.05) {
    const r = project.rules; const pc = project.parcel.polygon;
    let bf = G.offset(pc, -((r.system === 'BauG' ? r.gaKlein : r.ga) + margin))[0]; if (!bf) return null;
    if (r.system === 'BauG' && r.gaGross > r.gaKlein) { // grosser Grenzabstand auf der Hauptwohnseite
      const i = frontEdge(project), a = pc[i], b = pc[(i + 1) % pc.length]; const L = G.dist(a, b); const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; const n = [-u[1], u[0]]; const d = r.gaGross + margin, D = 400;
      const strip = [[a[0] - u[0] * D, a[1] - u[1] * D], [b[0] + u[0] * D, b[1] + u[1] * D], [b[0] + u[0] * D + n[0] * d, b[1] + u[1] * D + n[1] * d], [a[0] - u[0] * D + n[0] * d, a[1] - u[1] * D + n[1] * d]];
      bf = G.difference(bf, [G.ensureCCW(strip)]).sort((x, y) => G.absArea(y) - G.absArea(x))[0] || null;
    }
    const fb = forbidden(project); if (bf && fb.length) bf = G.difference(bf, fb).sort((x, y) => G.absArea(y) - G.absArea(x))[0] || null;
    return bf;
  }
  const mlzOf = (len, r) => r.system === 'BauG' && r.mlz ? Math.max(0, Math.min(r.mlz.max, (len - r.mlz.from) * r.mlz.f)) : 0;
  /** Höhenlage: bergseitig ebenerdig (mit UG), sonst Ausgleich Abtrag/Auftrag; eben: höchster Terrainpunkt + Sockel */
  function terrainRing(t, poly) { const out = []; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; const n = Math.max(1, Math.ceil(G.dist(a, b))); for (let k = 0; k < n; k++) { const E = a[0] + (b[0] - a[0]) * k / n, N = a[1] + (b[1] - a[1]) * k / n; out.push({ p: [E, N], h: terrainAt(t, E, N) }); } } return out; }
  function baseFor(poly, project) {
    const t = project.terrain; const r = project.rules; const ug = !!(project.typology && project.typology.ug);
    const ring = terrainRing(t, poly); const hs = ring.map(x => x.h).sort((a, b) => a - b);
    const tmin = hs[0], tmax = hs[hs.length - 1], tmean = hs.reduce((a, b) => a + b, 0) / hs.length; const sock = r.sockel ?? 0.15;
    if (tmax - tmin < 0.8) return { base: tmax + sock, rule: 'ebenes Terrain: höchster Terrainpunkt + Sockel' };
    if (ug) { const up = hs.slice(Math.floor(hs.length * 0.75)); const hu = up.reduce((a, b) => a + b, 0) / up.length; return { base: hu + sock, rule: 'Hang mit UG: EG bergseitig ebenerdig, UG talseitig freigelegt' }; }
    return { base: tmean + sock, rule: 'Hang ohne UG: Ausgleich von Abtrag und Auftrag' };
  }
  function placeHeights(v, project) {
    const fh = v.fh; const np = v.parts.filter(p => !p.attika);
    if (v.type === 'terrasse') { const b = baseFor(np[0].poly, project); np[0].base = b.base; for (let i = 1; i < np.length; i++) np[i].base = np[i - 1].base + fh * np[i - 1].nf; v.hlRule = b.rule; }
    else if (v.type === 'staffel') { np.forEach(p => { const b = baseFor(p.poly, project); p.base = b.base; v.hlRule = b.rule + ' (je Gebäudeteil)'; }); const bs = np.map(p => p.base); if (Math.max(...bs) - Math.min(...bs) < 0.6) np.forEach(p => p.base = Math.max(...bs)); }
    else { const u = G.union(np.map(p => p.poly))[0] || np[0].poly; const b = baseFor(u, project); np.forEach(p => p.base = b.base); v.hlRule = b.rule; }
    v.parts.filter(p => p.attika).forEach(p => { const under = np.slice().sort((x, y) => (y.base + y.nf * fh) - (x.base + x.nf * fh))[0]; p.base = under.base + under.nf * fh; });
  }
  /** Abtrag/Auftrag gegenüber gewachsenem Terrain an der Fassade */
  function earthwork(v, project) {
    const t = project.terrain; const ug = !!v.ug; const np = v.parts.filter(p => !p.attika); let cut = 0, fill = 0;
    for (const p of np) { const g = p.base - (project.rules.sockel ?? 0.15); for (const x of terrainRing(t, p.poly)) { if (x.h > g) cut = Math.max(cut, x.h - g); else if (!(ug && x.h < g - 1.0)) fill = Math.max(fill, g - x.h); } }
    return { cut, fill };
  }

  /** Bauvolumen-Kennzahlen + Baurechtsprüfung einer Variante */
  function evaluate(variant, project) {
    const parcel = project.parcel.polygon; const A = G.absArea(parcel);
    const r = project.rules; const t = project.terrain;
    const parts = variant.parts;
    const fpUnion = G.union(parts.map(p => p.poly));
    const footprint = fpUnion.sort((a, b) => G.absArea(b) - G.absArea(a))[0] || parts[0].poly;
    const uebArea = fpUnion.reduce((s, p) => s + G.absArea(p), 0);
    const c = G.centroid(footprint);
    const niveau = terrainAt(t, c[0], c[1]);
    let gv = 0, vAbove = 0, gf = 0, maxTop = -Infinity, fhMax = 0;
    for (const p of parts) {
      const a = G.absArea(p.poly);
      const terr = p.poly.map(v => terrainAt(t, v[0], v[1]));
      const tMin = Math.min(...terr), tMean = terr.reduce((s, x) => s + x, 0) / terr.length;
      const top = partTop(p, variant, r), eave = partEave(p, variant, r);
      const bodyTop = p.roof ? eave : top;
      gv += a * (bodyTop - Math.min(p.base - 0.3, tMin));
      vAbove += a * Math.max(0, bodyTop - tMean);
      if (p.roof) { const rv = a * roofRise(p) / 2; gv += rv; vAbove += rv; gf += a; }
      gf += a * p.nf;
      maxTop = Math.max(maxTop, top);
      fhMax = Math.max(fhMax, eave - tMin);
    }
    if (variant.ug) { const a = G.absArea(footprint); gv += a * UG_H; gf += a; }
    const gh = maxTop - niveau;
    const mr = G.minRect(footprint);
    const edges = G.edgeDistances(parcel, footprint);
    const gaMin = Math.min(...edges.map(e => e.d));
    const outside = !G.inside(footprint, parcel, 0.5);
    const extras = (project.site && project.site.extras) || [];
    const extraFp = extras.filter(e => e.type !== 'pp2' && e.type !== 'zufahrt').reduce((s, e) => s + G.absArea(e.poly), 0);
    const extraHard = extras.filter(e => e.type === 'pp2' || e.type === 'zufahrt').reduce((s, e) => s + G.absArea(e.poly), 0);
    const hard = r.hardscape != null ? r.hardscape : Math.round(25 + A * 0.06 + extraHard);
    const green = Math.max(0, A - uebArea - extraFp - hard);
    const vgParts = parts.filter(p => !p.attika);
    const m = {
      parcelArea: A, footprintArea: uebArea, gf, gv, vAbove, niveau, top: maxTop, gh, fh: fhMax, length: mr.len, width: mr.wid,
      uez: uebArea / A, bmz: vAbove / A, gfz: green / A, gaMin, edges, floors: Math.max(...vgParts.map(p => p.f0 + p.nf)), hard, green,
      ngfEst: gf * 0.82, hnfEst: gf * 0.62, perimeter: G.perimeter(footprint), extraFp
    };
    const chk = [];
    const add = (key, label, ist, soll, ok, fmt, info) => chk.push({ key, label, ist, soll, status: soll == null ? 'info' : ok ? 'ok' : 'fail', fmt, info });
    add('lage', 'Lage innerhalb Parzelle', outside ? 'nein' : 'ja', 'ja', !outside, 's');
    const eaveMax = Math.max(...parts.map(p => partEave(p, variant, r)));
    const mlz = mlzOf(mr.len, r);
    if (r.system === 'BauG') {
      const fe = frontEdge(project); const gaFront = (m.edges[fe] || {}).d ?? gaMin;
      const aGF = (gf - (variant.ug ? G.absArea(footprint) : 0)) * 0.9; m.az = aGF / A; m.aGF = aGF; m.gbh = eaveMax - niveau; m.mlz = mlz; m.frontEdge = fe;
      add('ga', 'Grenzabstand klein (allseitig)', gaMin, r.gaKlein + mlz, gaMin >= r.gaKlein + mlz - 0.05, 'm', mlz ? `inkl. Mehrlängenzuschlag ${fmtN(mlz, 2)} m` : '');
      add('gag', 'Grenzabstand gross (Hauptwohnseite)', gaFront, r.gaGross + mlz, gaFront >= r.gaGross + mlz - 0.05, 'm', `Parzellenseite ${fe + 1}`);
      add('gbh', 'Gebäudehöhe (ab Niveaupunkt)', m.gbh, r.gbh, m.gbh <= r.gbh + 0.01, 'm');
      add('firsth', 'Firsthöhe (ab Niveaupunkt)', gh, r.firsth, gh <= r.firsth + 0.01, 'm');
      add('gl', 'Gebäudelänge', mr.len, r.gl, mr.len <= r.gl + 0.01, 'm');
      add('az', 'Ausnützungsziffer (aGF ≈ 90 % GF)', m.az, r.az, r.az == null || m.az <= r.az + 1e-3, 'n2');
    } else {
      add('ga', 'Grenzabstand min. (Art. 92 PBG)', gaMin, r.ga, gaMin >= r.ga - 0.05, 'm');
      add('gh', 'Gesamthöhe ab Niveaupunkt (Art. 83)', gh, r.gh, gh <= r.gh + 0.01, 'm', parts.some(p => p.roof) ? 'bis First' : '');
      add('fh', 'Fassadenhöhe max. (Art. 86)', fhMax, r.fh, fhMax <= r.fh + 0.01, 'm', parts.some(p => p.roof) ? 'traufseitig; Giebelseite nach Baureglement prüfen' : '');
      add('gl', 'Gebäudelänge (Art. 82)', mr.len, r.gl, mr.len <= r.gl + 0.01, 'm');
      add('uez', 'Überbauungsziffer', m.uez, r.uez, r.uez == null || m.uez <= r.uez + 1e-4, '%', extraFp ? 'Nebenbauten nach Baureglement ggf. anrechenbar' : '');
      add('bmz', 'Baumassenziffer [m³/m²]', m.bmz, r.bmz, r.bmz == null || m.bmz <= r.bmz + 1e-3, 'n2');
      add('gfz', 'Grünflächenziffer (min.)', m.gfz, r.gfz, r.gfz == null || m.gfz >= r.gfz - 1e-4, '%');
    }
    add('vg', 'Vollgeschosse', m.floors, r.vg, m.floors <= r.vg, 'n0', parts.some(p => p.attika) ? 'Attika nicht als Vollgeschoss gezählt' : parts.some(p => p.roof) ? 'Dachgeschoss nicht als Vollgeschoss gezählt' : '');
    // Baulinien / Abstandslinien
    const fb = forbidden(project);
    if (fb.length) { const over = G.clip([footprint], fb, ClipperLib.ClipType.ctIntersection).reduce((s2, q) => s2 + G.absArea(q), 0); chk.push({ key: 'baulinie', label: 'Baulinien / Abstandslinien', ist: over > 0.05 ? `überschritten (${fmtN(over, 1)} m²)` : 'eingehalten', soll: 'eingehalten', status: over > 0.05 ? 'fail' : 'ok', fmt: 's' }); }
    // Sondernutzungsplan
    for (const o of ((project.planning && project.planning.overlays) || []).filter(o => o.snp)) chk.push({ key: 'snp', label: 'Sondernutzungsplan', ist: o.label, soll: null, status: 'warn', fmt: 's', info: 'Bestimmungen des Sondernutzungsplans gehen der Regelbauweise vor – prüfen' });
    // Höhenlage
    const ew = earthwork(variant, project); m.cut = ew.cut; m.fill = ew.fill;
    chk.push({ key: 'hl', label: 'Höhenlage OK EG', ist: `${fmtN(Math.min(...parts.filter(p => !p.attika).map(p => p.base)), 2)} m ü.M.`, soll: null, status: 'info', fmt: 's', info: variant.hlRule || '' });
    chk.push({ key: 'cut', label: 'Abgrabung max. an Fassade', ist: ew.cut, soll: r.abgrabMax ?? 1.5, status: ew.cut <= (r.abgrabMax ?? 1.5) + 0.01 ? 'ok' : 'warn', fmt: 'm', info: 'Grenzwert gemäss Baureglement prüfen' });
    chk.push({ key: 'fill', label: 'Aufschüttung max. an Fassade', ist: ew.fill, soll: r.aufschMax ?? 1.5, status: ew.fill <= (r.aufschMax ?? 1.5) + 0.01 ? 'ok' : 'warn', fmt: 'm' });
    for (const e of extras.filter(e => e.type === 'carport' || e.type === 'garage_ext')) {
      const d = Math.min(...G.edgeDistances(parcel, e.poly).filter(x => x.edge !== e.edge).map(x => x.d));
      chk.push({ key: 'neben', label: `${e.name}: Grenzabstand (ohne Strassenseite)`, ist: d, soll: null, status: d >= 3 ? 'ok' : 'warn', fmt: 'm', info: 'Kleinbauten: reduzierter Abstand bzw. Strassenabstand nach Baureglement' });
    }
    const slope = Geo.slopeOf(t, parcel);
    m.slope = slope.pct;
    if (slope.pct > 10) chk.push({ key: 'hang', label: 'Hanglage', ist: slope.pct, soll: null, status: 'warn', fmt: '%r', info: 'Gefälle > 10 %: Hangzuschläge/Abgrabungen nach Baureglement prüfen' });
    variant.metrics = m; variant.checks = chk;
    variant.ok = chk.every(c => c.status !== 'fail');
    return variant;
  }

  /** Regelkonforme Varianten generieren */
  function generateVariants(project, opts = {}) {
    const parcel = project.parcel.polygon; const r = project.rules; const t = project.terrain;
    const A = G.absArea(parcel);
    const buildable = buildableArea(project, 0.05);
    if (!buildable || G.absArea(buildable) < 30) return { buildable: null, variants: [], msg: 'Nach Abzug der Grenzabstände bleibt keine sinnvolle Baufläche.' };
    const use = (project.typology && project.typology.use) || 'efh';
    const fh = use === 'gewerbe' ? Math.max(4.5, r.floorHeight) : r.floorHeight;
    const slope = Geo.slopeOf(t, parcel);
    const hasSlope = slope.pct > 6;
    const baseAngles = [G.longestEdgeAngle(parcel), G.longestEdgeAngle(parcel) + Math.PI / 2];
    // Höhenlage: Geschosszahl nach Gesamthöhe begrenzen
    const hLim = r.system === 'BauG' ? r.gbh : r.gh;
    const floorsByH = Math.max(1, Math.floor((hLim - r.sockel - r.roofBuildup) / fh + 1e-6));
    const floors = Math.max(1, Math.min(r.vg || 3, floorsByH, opts.maxFloors || 9, use === 'efh' && !opts.maxFloors ? 2 : 9));
    let maxFp = Math.min(r.uez != null ? r.uez * A : Infinity, r.bmz != null ? (r.bmz * A) / (floors * fh + r.roofBuildup + r.sockel) : Infinity, r.system === 'BauG' && r.az ? r.az * A / (floors * 0.9) : Infinity, opts.maxFootprint || Infinity);
    const legalFp = maxFp; let gfNeed = null, effAdd = 0, garAdd = 0;
    const size = use !== 'efh' ? 'max' : (opts.size || project.sizeMode || 'programm');
    if (size === 'programm' && (project.program || []).length) {
      const typ = project.typology || {}; const park = (project.site && project.site.parking) || 'none';
      let nf = 0, gar = 0; for (const x of project.program) { const n = (x.name || '').toLowerCase(); if (/garage/.test(n)) { if (park === 'garage_int') gar += Number(x.area) || 0; continue; } if (typ.ug && /keller|technik|wasch|disponibel|hobby/.test(n)) continue; nf += Number(x.area) || 0; }
      gfNeed = nf / 0.76; effAdd = typ.roof === 'attika' ? 0.45 : typ.roof && typ.roof !== 'flach' ? 0.55 : 0;
      maxFp = Math.min(maxFp, Math.max(85, (gfNeed / (floors + effAdd) + gar / 0.88) * 1.06)); garAdd = gar / 0.88;
    }
    const types = opts.types || Object.keys(TYPES);
    const bb = G.bbox(buildable);
    const centers = [];
    const step = Math.max(1, Math.min(bb[2] - bb[0], bb[3] - bb[1]) / 7);
    for (let x = bb[0]; x <= bb[2]; x += step) for (let y = bb[1]; y <= bb[3]; y += step) if (G.pointInPoly([x, y], buildable)) centers.push([x, y]);
    const bc = G.centroid(buildable); centers.unshift(bc);
    const variants = [];
    const build = (type, maxFp) => {
      // Terrasse & Staffel: y-Achse (Tiefe) zeigt bergauf
      let angles = baseAngles;
      if ((type === 'terrasse' || type === 'staffel') && hasSlope) angles = [slope.dir + Math.PI / 2];
      let best = null;
      for (const ang of angles) {
        for (const c of centers) {
          let lo = 6, hi = Math.min(r.gl || 60, 60), fit = null;
          for (let it = 0; it < 12; it++) {
            const L = (lo + hi) / 2;
            const nf = type === 'terrasse' ? floors : floors;
            const parts = shapeParts(type, L, nf, fh).map(p => ({ ...p, poly: G.translate(G.rotatePoly(p.poly, ang, [0, 0]), c[0], c[1]) }));
            const union = G.union(parts.map(p => p.poly));
            const area = union.reduce((s, p) => s + G.absArea(p), 0);
            const okIn = union.every(p => G.inside(p, buildable, 0.01));
            const mr = G.minRect(union[0] || parts[0].poly);
            if (okIn && area <= maxFp && mr.len <= (r.gl || 99) + 0.01) { fit = { L, parts, area }; lo = L; } else hi = L;
          }
          if (fit && (!best || fit.area > best.area + 0.5 || (Math.abs(fit.area - best.area) < 0.5 && G.dist(c, bc) < G.dist(best.c, bc)))) best = { ...fit, c, ang };
        }
      }
      if (!best) return null;
      // Höhenlage pro Teil
      const parts = best.parts.map((p, i) => {
        const pc = G.centroid(p.poly);
        let base;
        if (type === 'terrasse') {
          base = terrainAt(t, best.c[0], best.c[1]) + r.sockel;
        } else if (p.followTerrain && hasSlope) base = terrainAt(t, pc[0], pc[1]) + r.sockel;
        else base = terrainAt(t, best.c[0], best.c[1]) + r.sockel;
        return { poly: p.poly, base, nf: p.nf, f0: p.f0, label: type === 'terrasse' ? `Terrasse ${p.f0 + 1}` : `Volumen ${i + 1}` };
      });
      // Terrassenhaus: Basis jeder Stufe auf Oberkante der unteren Stufe begrenzen
      if (type === 'terrasse') for (let i = 1; i < parts.length; i++) parts[i].base = parts[i - 1].base + fh;
      const vtmp = { type, fh, parts }; placeHeights(vtmp, project);
      const v = { id: 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type, name: TYPES[type].name, desc: TYPES[type].desc, fh, parts, angle: best.ang, center: best.c, ug: false, hlRule: vtmp.hlRule };
      // Falls Höhe überschritten → Geschosse reduzieren
      const ev = () => { if (project.typology) { applyTypology(v, project, project.typology); placeHeights(v, project); } return evaluate(v, project); };
      ev();
      let guard = 0;
      while (!v.ok && guard++ < 4 && v.checks.some(c => (c.key === 'gh' || c.key === 'fh' || c.key === 'bmz') && c.status === 'fail')) {
        const np = v.parts.filter(p => !p.attika);
        if (type === 'terrasse' && np.length > 1) v.parts.splice(v.parts.indexOf(np[np.length - 1]), 1); else if (np[0].nf > 1) np.forEach(p => p.nf = Math.max(1, p.nf - 1)); else break;
        ev();
      }
      return v;
    };
    for (const type of types) {
      if (type === 'terrasse' && floors < 2) continue;
      let v = build(type, maxFp); if (!v) continue;
      // Geschoss weggefallen → Grundfläche nach Raumprogramm neu bemessen
      if (gfNeed && v.metrics.floors < floors) { const v2 = build(type, Math.min(legalFp, Math.max(85, (gfNeed / (v.metrics.floors + effAdd) + garAdd) * 1.06))); if (v2 && v2.ok) v = v2; }
      variants.push(v);
    }
    return { buildable, variants, floors, maxFp };
  }

  /** Variante verschieben/drehen (Bearbeitung im Lageplan) */
  function transformVariant(v, project, dx, dy, dAng) {
    const c = G.centroid(G.union(v.parts.map(p => p.poly))[0] || v.parts[0].poly);
    v.parts.forEach(p => { p.poly = G.translate(G.rotatePoly(p.poly, dAng || 0, c), dx || 0, dy || 0); });
    v.angle = (v.angle || 0) + (dAng || 0);
    if (project.terrain) placeHeights(v, project);
    if (project.site && project.site.parking && project.activeVariant === v.id) computeExtras(project, v);
    return evaluate(v, project);
  }

  /* ---------- Kosten (Grobkostenschätzung nach BKP, Genauigkeit ±25 %) ---------- */
  const COST_STANDARDS = {
    einfach: { name: 'Einfach', chfm3: 780 },
    mittel: { name: 'Mittel', chfm3: 920 },
    gehoben: { name: 'Gehoben', chfm3: 1100 },
    hoch: { name: 'Hochwertig', chfm3: 1350 }
  };
  function defaultCostParams() {
    return { standard: 'mittel', chfm3: null, ugChfm3: 650, umgebungChfm2: 140, bkp1pct: 2.0, hangZuschlagPct: 4.0, bkp5pct: 4.5, reservePct: 8, garage: 0, garageChf: 45000, landPrice: 0, mwstIncl: true };
  }
  function estimateCosts(project, catalogMap) {
    const v = project.variants.find(x => x.id === project.activeVariant);
    const cp = Object.assign(defaultCostParams(), project.costs || {});
    const m = v && v.metrics;
    if (!m) return null;
    const rate = cp.chfm3 || COST_STANDARDS[cp.standard].chfm3;
    const fpA = m.footprintArea;
    const gvOver = m.gv - (v.ug ? fpA * UG_H : 0);
    const lines = [];
    const add = (bkp, text, basis, chf, note) => lines.push({ bkp, text, basis, chf: Math.round(chf), note });
    const b2 = gvOver * rate + (v.ug ? fpA * UG_H * cp.ugChfm3 : 0);
    const b1 = b2 * (cp.bkp1pct + (m.slope > 10 ? cp.hangZuschlagPct : 0)) / 100;
    add('1', 'Vorbereitungsarbeiten', `${cp.bkp1pct}%${m.slope > 10 ? ' + Hangzuschlag ' + cp.hangZuschlagPct + '%' : ''} von BKP 2`, b1);
    add('2', 'Gebäude', `GV ${fmtN(gvOver, 0)} m³ × CHF ${rate}/m³${v.ug ? ` + UG ${fmtN(fpA * UG_H, 0)} m³ × CHF ${cp.ugChfm3}` : ''}`, b2, 'inkl. Honorare BKP 29');
    if (cp.garage) add('2', 'Garage / Carport (manuell)', `${cp.garage} Stk × CHF ${fmtN(cp.garageChf, 0)}`, cp.garage * cp.garageChf);
    const EXP = { pp2: ['4', 'Aussenparkplätze 2 PP inkl. Belag', 9000], carport: ['2', 'Carport 2 PP', 28000], garage_ext: ['2', 'Garage separat 2 PP', 58000] };
    for (const e of (project.site && project.site.extras) || []) if (EXP[e.type]) add(EXP[e.type][0], EXP[e.type][1], 'Pauschale Richtwert', EXP[e.type][2]);
    if (v.parts.some(p => p.roof)) add('2', 'Mehrkosten Steildach', '≈ 6 % BKP 2', b2 * 0.06);
    const umgFl = Math.max(0, m.parcelArea - fpA);
    add('4', 'Umgebung', `${fmtN(umgFl, 0)} m² × CHF ${cp.umgebungChfm2}/m²`, umgFl * cp.umgebungChfm2);
    // Katalog-Auswahl (Mehr-/Minderkosten gegenüber Standard)
    let sel = 0;
    for (const s of project.selections || []) {
      const it = catalogMap[s.catalogId]; if (!it) continue;
      const chf = (s.qty || 1) * (Number(it.price) || 0) - (Number(s.allowance) || 0);
      sel += chf;
    }
    if (sel) add('2/9', 'Ausbau-Auswahl aus Katalog', 'Mehr-/Minderkosten ggü. Budgetposition', sel);
    const subtotal = lines.reduce((s, l) => s + l.chf, 0);
    add('5', 'Baunebenkosten', `${cp.bkp5pct}% (Gebühren, Anschlüsse, Versicherungen)`, subtotal * cp.bkp5pct / 100);
    const sub2 = lines.reduce((s, l) => s + l.chf, 0);
    add('–', 'Reserve / Unvorhergesehenes', `${cp.reservePct}%`, sub2 * cp.reservePct / 100);
    const total = lines.reduce((s, l) => s + l.chf, 0);
    const land = cp.landPrice ? cp.landPrice * m.parcelArea : 0;
    return { lines, total, rate, land, range: [total * 0.75, total * 1.25], perM2: total / m.gf, perM3: total / m.gv, params: cp };
  }

  function fmtN(x, d = 1) { if (x == null || isNaN(x)) return '–'; return Number(x).toLocaleString('de-CH', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function fmtCHF(x) { return 'CHF ' + Math.round(x).toLocaleString('de-CH'); }
  function fmtVal(v, f) {
    if (v == null) return '–';
    if (f === 's') return v;
    if (f === 'm') return fmtN(v, 2) + ' m';
    if (f === '%') return fmtN(v * 100, 1) + ' %';
    if (f === '%r') return fmtN(v, 1) + ' %';
    if (f === 'n2') return fmtN(v, 2);
    if (f === 'n0') return fmtN(v, 0);
    return String(v);
  }

  window.Engine = { ZONES_BAUG, MUNI, rulesFromPlanning, frontVec, frontEdge, forbidden, buildableArea, placeHeights, ROOFS, UG_H, PARKING, roofRise, partTop, partEave, applyTypology, accessEdge, computeExtras, ZONES_SG, defaultRules, guessZone, TYPES, generateVariants, evaluate, transformVariant, COST_STANDARDS, defaultCostParams, estimateCosts, fmtN, fmtCHF, fmtVal };
})();
