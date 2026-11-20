/* Baucockpit – Geodaten (geo.admin.ch), Koordinaten & Geometrie */
(function () {
  const API = 'https://api3.geo.admin.ch/rest/services';
  const WMS = 'https://wms.geo.admin.ch/';

  /* ---------- LV95 <-> WGS84 (swisstopo Näherungsformeln, ~1 m) ---------- */
  function lv95ToWgs(E, N) {
    const y = (E - 2600000) / 1e6, x = (N - 1200000) / 1e6;
    let lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
    let lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.0140 * x * x * x;
    return [lat * 100 / 36, lon * 100 / 36];
  }
  function wgsToLv95(lat, lon) {
    const p = (lat * 3600 - 169028.66) / 10000, l = (lon * 3600 - 26782.5) / 10000;
    const E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l * l * l;
    const N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p * p * p;
    return [E, N];
  }

  /* ---------- Polygon-Geometrie ---------- */
  const G = {
    area(poly) { let a = 0; for (let i = 0, n = poly.length; i < n; i++) { const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % n]; a += x1 * y2 - x2 * y1; } return a / 2; },
    absArea(poly) { return Math.abs(G.area(poly)); },
    centroid(poly) {
      let a = 0, cx = 0, cy = 0; const n = poly.length;
      const ox = poly[0][0], oy = poly[0][1];
      for (let i = 0; i < n; i++) {
        const x1 = poly[i][0] - ox, y1 = poly[i][1] - oy, x2 = poly[(i + 1) % n][0] - ox, y2 = poly[(i + 1) % n][1] - oy;
        const f = x1 * y2 - x2 * y1; a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
      }
      if (Math.abs(a) < 1e-9) { const s = poly.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]); return [s[0] / n, s[1] / n]; }
      return [cx / (3 * a) + ox, cy / (3 * a) + oy];
    },
    perimeter(poly) { let s = 0; for (let i = 0; i < poly.length; i++) s += G.dist(poly[i], poly[(i + 1) % poly.length]); return s; },
    dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); },
    bbox(poly) { const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; },
    pointInPoly(pt, poly) {
      let c = false; const [x, y] = pt;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
      }
      return c;
    },
    segDist(p, a, b) {
      const dx = b[0] - a[0], dy = b[1] - a[1]; const l2 = dx * dx + dy * dy;
      let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    },
    closestOnSeg(p, a, b) {
      const dx = b[0] - a[0], dy = b[1] - a[1]; const l2 = dx * dx + dy * dy;
      let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
      return { pt: [a[0] + t * dx, a[1] + t * dy], t };
    },
    /** kleinste Distanz zwischen zwei Polygonen (Ränder) inkl. Lotpunkten */
    polyPolyDist(A, B) {
      let best = { d: Infinity, a: null, b: null };
      const test = (P, Q, swap) => {
        for (const p of P) for (let i = 0; i < Q.length; i++) {
          const c = G.closestOnSeg(p, Q[i], Q[(i + 1) % Q.length]); const d = G.dist(p, c.pt);
          if (d < best.d) best = swap ? { d, a: c.pt, b: p } : { d, a: p, b: c.pt };
        }
      };
      test(A, B, false); test(B, A, true); return best;
    },
    /** Distanz jeder Parzellenkante zum Gebäude (für Grenzabstände je Seite) */
    edgeDistances(parcel, building) {
      return parcel.map((a, i) => {
        const b = parcel[(i + 1) % parcel.length];
        let best = { d: Infinity, p: null, q: null };
        for (const p of building) { const c = G.closestOnSeg(p, a, b); const d = G.dist(p, c.pt); if (d < best.d) best = { d, p, q: c.pt }; }
        return { edge: i, a, b, len: G.dist(a, b), ...best };
      });
    },
    rotate(pt, ang, c = [0, 0]) { const s = Math.sin(ang), co = Math.cos(ang); const x = pt[0] - c[0], y = pt[1] - c[1]; return [c[0] + x * co - y * s, c[1] + x * s + y * co]; },
    rotatePoly(poly, ang, c) { return poly.map(p => G.rotate(p, ang, c)); },
    translate(poly, dx, dy) { return poly.map(p => [p[0] + dx, p[1] + dy]); },
    longestEdgeAngle(poly) {
      let best = 0, ang = 0;
      for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; const l = G.dist(a, b); if (l > best) { best = l; ang = Math.atan2(b[1] - a[1], b[0] - a[0]); } }
      return ang;
    },
    /** minimales umhüllendes Rechteck (für Gebäudelänge nach PBG Art. 82) */
    minRect(poly) {
      let best = null;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length]; const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const r = G.rotatePoly(poly, -ang, [0, 0]); const bb = G.bbox(r); const w = bb[2] - bb[0], h = bb[3] - bb[1];
        if (!best || w * h < best.area) best = { area: w * h, len: Math.max(w, h), wid: Math.min(w, h), ang };
      }
      return best;
    },
    ensureCCW(poly) { return G.area(poly) < 0 ? poly.slice().reverse() : poly; },
    /** achsparalleles (rechtwinkliges) Polygon in Rechtecke zerlegen → [[x0,y0,x1,y1], …] */
    rectDecompose(poly) {
      const r = v => Math.round(v * 1000) / 1000;
      const xs = [...new Set(poly.map(p => r(p[0])))].sort((a, b) => a - b);
      const strips = [];
      for (let i = 0; i < xs.length - 1; i++) {
        const xm = (xs[i] + xs[i + 1]) / 2; const ys = [];
        for (let k = 0; k < poly.length; k++) { const a = poly[k], b = poly[(k + 1) % poly.length]; if ((a[0] - xm) * (b[0] - xm) < 0) ys.push(a[1] + (b[1] - a[1]) * (xm - a[0]) / (b[0] - a[0])); }
        ys.sort((a, b) => a - b); for (let k = 0; k + 1 < ys.length; k += 2) strips.push([xs[i], r(ys[k]), xs[i + 1], r(ys[k + 1])]);
      }
      // gleiche y-Intervalle zusammenfassen
      const out = [];
      for (const s of strips) { const m = out.find(o => Math.abs(o[2] - s[0]) < 1e-3 && Math.abs(o[1] - s[1]) < 1e-3 && Math.abs(o[3] - s[3]) < 1e-3); if (m) m[2] = s[2]; else out.push(s.slice()); }
      return out.sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]));
    },
    rectPoly(r) { return [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]; },
    /* Clipper-Wrapper (Skalierung 1000 = mm) */
    _toC(poly) { return poly.map(p => ({ X: Math.round(p[0] * 1000), Y: Math.round(p[1] * 1000) })); },
    _fromC(path) { return path.map(p => [p.X / 1000, p.Y / 1000]); },
    offset(poly, delta) {
      const co = new ClipperLib.ClipperOffset(2, 250);
      co.AddPath(G._toC(poly), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
      const sol = new ClipperLib.Paths(); co.Execute(sol, delta * 1000);
      return sol.map(G._fromC).sort((a, b) => G.absArea(b) - G.absArea(a));
    },
    clip(subj, clipPolys, type) {
      const c = new ClipperLib.Clipper();
      c.AddPaths(subj.map(G._toC), ClipperLib.PolyType.ptSubject, true);
      c.AddPaths(clipPolys.map(G._toC), ClipperLib.PolyType.ptClip, true);
      const sol = new ClipperLib.Paths();
      c.Execute(type, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
      return sol.map(G._fromC);
    },
    difference(a, b) { return G.clip([a], Array.isArray(b[0][0]) ? b : [b], ClipperLib.ClipType.ctDifference); },
    union(polys) { return G.clip(polys, [], ClipperLib.ClipType.ctUnion); },
    /** liegt Polygon A vollständig in B? (Toleranz in m²) */
    inside(A, B, tol = 0.05) { const d = G.difference(A, B); return d.reduce((s, p) => s + G.absArea(p), 0) <= tol; }
  };

  /* ---------- geo.admin.ch REST ---------- */
  async function getJSON(url, timeout = 20000) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  const GeoAdmin = {
    async search(text) {
      const u = `${API}/api/SearchServer?searchText=${encodeURIComponent(text)}&type=locations&origins=parcel,address,gg25&sr=2056&limit=12&lang=de`;
      const j = await getJSON(u);
      return (j.results || []).map(r => {
        const a = r.attrs || {};
        // In sr=2056: attrs.y = Ost (E), attrs.x = Nord (N)
        return { label: (a.label || '').replace(/<[^>]+>/g, ''), origin: a.origin, E: a.y, N: a.x, lat: a.lat, lon: a.lon, detail: a.detail };
      });
    },
    async identify(E, N, layer, tol = 0) {
      const ext = `${E - 50},${N - 50},${E + 50},${N + 50}`;
      const u = `${API}/all/MapServer/identify?geometry=${E},${N}&geometryType=esriGeometryPoint&layers=all:${layer}` +
        `&mapExtent=${ext}&imageDisplay=1000,1000,96&tolerance=${tol}&returnGeometry=true&geometryFormat=geojson&sr=2056&lang=de`;
      const j = await getJSON(u);
      return j.results || [];
    },
    /** Parzelle an Punkt (Amtliche Vermessung, kantonale Daten via geo.admin) */
    async identifyBox(box, layer) {
      const u = `${API}/all/MapServer/identify?geometry=${box.join(',')}&geometryType=esriGeometryEnvelope&layers=all:${layer}&mapExtent=${box.join(',')}&imageDisplay=1000,1000,96&tolerance=0&returnGeometry=true&geometryFormat=geojson&sr=2056&lang=de&limit=200`;
      const j = await getJSON(u); return j.results || [];
    },
    async parcelAt(E, N) {
      const res = await GeoAdmin.identify(E, N, 'ch.kantone.cadastralwebmap-farbe');
      const hit = res.find(r => r.geometry) || res[0];
      if (!hit) throw new Error('Keine Parzelle an diesem Punkt gefunden');
      const p = hit.properties || hit.attributes || {};
      const poly = GeoAdmin._largestRing(hit.geometry);
      return {
        number: String(p.number ?? p.nummer ?? p.label ?? ''),
        egrid: p.egris_egrid || p.egrid || '',
        canton: p.ak || p.kanton || '',
        identnd: p.identnd || '',
        raw: p,
        polygon: G.ensureCCW(poly.map(c => [c[0], c[1]]))
      };
    },
    _largestRing(geom) {
      if (!geom) return [];
      let rings = [];
      if (geom.type === 'Polygon') rings = [geom.coordinates[0]];
      else if (geom.type === 'MultiPolygon') rings = geom.coordinates.map(p => p[0]);
      else if (geom.rings) rings = geom.rings;
      rings = rings.map(r => { const c = r.slice(); const f = c[0], l = c[c.length - 1]; if (f && l && f[0] === l[0] && f[1] === l[1]) c.pop(); return c; });
      rings.sort((a, b) => G.absArea(b) - G.absArea(a));
      return rings[0] || [];
    },
    async zoneAt(E, N) {
      try {
        const res = await GeoAdmin.identify(E, N, 'ch.are.bauzonen');
        if (!res.length) return null;
        const p = res[0].properties || res[0].attributes || {};
        return { raw: p, label: p.ch_bez_d || p.bez_d || p.typ_kommunal_bezeichnung || p.label || '', code: p.ch_code_hn ?? p.ch_code ?? '', gemeinde: p.name || p.name_ || p.gemeinde_name || p.gemname || '', bfs: p.bfs_no || '' };
      } catch (e) { return null; }
    },
    async gemeindeAt(E, N) {
      try {
        const res = await GeoAdmin.identify(E, N, 'ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill');
        const all = res.map(r => r.properties || r.attributes || {});
        const p = all.find(x => x.is_current_jahr) || all.sort((a, b) => (b.jahr || 0) - (a.jahr || 0))[0] || {};
        return { name: p.gemname || p.label || p.name || '', bfs: p.gde_nr || p.bfs_nummer || p.id || '', kanton: p.kanton || '' };
      } catch (e) { return null; }
    },
    async buildingsAround(E, N) {
      try {
        const res = await GeoAdmin.identify(E, N, 'ch.bfs.gebaeude_wohnungs_register', 60);
        return res.map(r => ({ egid: (r.properties || {}).egid, adresse: (r.properties || {}).strname_deinr || '', baujahr: (r.properties || {}).gbauj, E: r.geometry && r.geometry.coordinates ? r.geometry.coordinates[0] : null, N: r.geometry && r.geometry.coordinates ? r.geometry.coordinates[1] : null }));
      } catch (e) { return []; }
    },
    /* ---------- geodienste.ch WFS (Amtliche Vermessung, Nutzungsplanung; CORS) ---------- */
    async wfs(db, type, bbox, count = 400) {
      const u = `https://geodienste.ch/db/${db}/deu?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=${type}&BBOX=${bbox.map(v => v.toFixed(1)).join(',')},urn:ogc:def:crs:EPSG::2056&OUTPUTFORMAT=${encodeURIComponent('application/json; subtype=geojson')}&COUNT=${count}`;
      const j = await getJSON(u, 30000); return j.features || [];
    },
    _rings(geom) {
      if (!geom) return [];
      const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
      return polys.map(p => { const r = p[0].map(c => [c[0], c[1]]); const f = r[0], l = r[r.length - 1]; if (f[0] === l[0] && f[1] === l[1]) r.pop(); return G.ensureCCW(r); });
    },
    _lines(geom) {
      if (!geom) return [];
      if (geom.type === 'LineString') return [geom.coordinates.map(c => [c[0], c[1]])];
      if (geom.type === 'MultiLineString') return geom.coordinates.map(l => l.map(c => [c[0], c[1]]));
      return [];
    },
    /** Umgebung: Gebäude (AV) mit Geschosszahl (GWR) und Verkehrsflächen */
    async surroundings(center, radius = 110) {
      const box = [center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius];
      const [lc, gwr] = await Promise.all([
        GeoAdmin.wfs('av_0', 'ms:LCSF', box, 2000).catch(() => []),
        (async () => { try { const env = box.join(','); const j = await getJSON(`${API}/all/MapServer/identify?geometry=${env}&geometryType=esriGeometryEnvelope&layers=all:ch.bfs.gebaeude_wohnungs_register&mapExtent=${env}&imageDisplay=1000,1000,96&tolerance=0&returnGeometry=true&geometryFormat=geojson&sr=2056&lang=de&limit=500`); return j.results || []; } catch (e) { return []; } })()
      ]);
      const pts = gwr.map(r => ({ egid: String((r.properties || {}).egid || ''), floors: (r.properties || {}).gastw, kat: (r.properties || {}).gkat, year: (r.properties || {}).gbauj, xy: r.geometry && r.geometry.coordinates }));
      const buildings = [], ground = [];
      for (const f of lc) {
        const p = f.properties || {}; const rings = GeoAdmin._rings(f.geometry);
        if (p.Art === 'Gebaeude') for (const r of rings) {
          if (G.absArea(r) < 6) continue;
          const g = pts.find(x => (p.GWR_EGID && x.egid === String(p.GWR_EGID)) || (x.xy && G.pointInPoly(x.xy, r)));
          buildings.push({ poly: r, floors: g && g.floors || null, kat: g && g.kat || null, year: g && g.year || null, egid: p.GWR_EGID || (g && g.egid) || '' });
        } else if (/Strasse|Trottoir|Verkehrsinsel|Bahn|befestigte/.test(p.Art || '')) for (const r of rings) ground.push({ poly: r, art: p.Art });
        else if (/Gewaesser/.test(p.Art || '')) for (const r of rings) ground.push({ poly: r, art: p.Art });
      }
      return { buildings, ground, box, loaded: new Date().toISOString() };
    },
    async height(E, N) {
      const j = await getJSON(`${API}/height?easting=${E}&northing=${N}&sr=2056`);
      return parseFloat(j.height);
    },
    async profile(coords, nb) {
      const geom = encodeURIComponent(JSON.stringify({ type: 'LineString', coordinates: coords }));
      const j = await getJSON(`${API}/profile.json?geom=${geom}&sr=2056&nb_points=${nb}&distinct_points=true`);
      return j.map(p => ({ dist: p.dist, h: (p.alts && (p.alts.DTM2 ?? p.alts.COMB ?? p.alts.DTM25)), E: p.easting, N: p.northing }));
    },
    /** Geländeraster: Profil-Linien über die Parzelle (+Rand) */
    async terrainGrid(poly, margin = 20, n = 25, onProgress) {
      const bb = G.bbox(poly);
      const x0 = bb[0] - margin, y0 = bb[1] - margin, x1 = bb[2] + margin, y1 = bb[3] + margin;
      const size = Math.max(x1 - x0, y1 - y0);
      const dx = size / (n - 1);
      const heights = new Array(n * n).fill(null);
      let done = 0;
      const rows = [...Array(n).keys()];
      const worker = async () => {
        while (rows.length) {
          const j = rows.shift(); const yy = y0 + j * dx;
          let pts;
          try { pts = await GeoAdmin.profile([[x0, yy], [x0 + size, yy]], n * 2); }
          catch (e) { pts = null; }
          for (let i = 0; i < n; i++) {
            const d = i * dx; let h = null;
            if (pts && pts.length) {
              let k = pts.findIndex(p => p.dist >= d);
              if (k <= 0) h = pts[Math.max(0, k)].h; else { const a = pts[k - 1], b = pts[k]; const t = (d - a.dist) / ((b.dist - a.dist) || 1); h = a.h + t * (b.h - a.h); }
            }
            heights[j * n + i] = h;
          }
          done++; onProgress && onProgress(done / n);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      // Lücken mit Punktabfragen füllen
      for (let k = 0; k < heights.length; k++) if (heights[k] == null || isNaN(heights[k])) {
        const i = k % n, j = Math.floor(k / n);
        try { heights[k] = await GeoAdmin.height(x0 + i * dx, y0 + j * dx); } catch (e) { heights[k] = 0; }
      }
      const valid = heights.filter(h => h != null);
      return { origin: [x0, y0], dx, n, heights, min: Math.min(...valid), max: Math.max(...valid), source: 'swissALTI3D (geo.admin.ch)' };
    },
    wmsUrl(layer, bbox, w, h, fmt = 'image/png') {
      return `${WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layer}&STYLES=&CRS=EPSG:2056&BBOX=${bbox.join(',')}&WIDTH=${w}&HEIGHT=${h}&FORMAT=${encodeURIComponent(fmt)}&TRANSPARENT=true`;
    },
    oerebUrl(egrid) { return egrid ? `https://www.geoportal.ch/ktsg/map/40?egrid=${egrid}` : null; },
    mapUrl(E, N) { return `https://map.geo.admin.ch/#/map?lang=de&center=${E.toFixed(0)},${N.toFixed(0)}&z=12&bgLayer=ch.swisstopo.pixelkarte-farbe&layers=ch.kantone.cadastralwebmap-farbe;ch.are.bauzonen`; }
  };


  /* ---------- Nutzungsplanung (geodienste.ch, harmonisiert, kantonal/kommunal) ---------- */
  const NPL = 'https://geodienste.ch/db/npl_nutzungsplanung_v1_2_0/deu?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&SRSNAME=EPSG:2056&OUTPUTFORMAT=geojson';
  async function nplLayer(type, bb) {
    const u = `${NPL}&TYPENAMES=ms:${type}&BBOX=${bb.join(',')},urn:ogc:def:crs:EPSG::2056&COUNT=200`;
    const j = await getJSON(u, 25000); return j.features || [];
  }
  const ringsOf = g => !g ? [] : g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map(p => p[0]) : [];
  const linesOf = g => !g ? [] : g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
  const docsOf = p => { try { const d = typeof p.dokument === 'string' ? JSON.parse(p.dokument) : p.dokument; return ((d && d.Dokumente) || []).map(x => ({ titel: x.Titel, link: x.Link, nr: x.OffizielleNr, typ: x.Typ })); } catch (e) { return []; } };
  GeoAdmin.planning = async function (parcel) {
    const bb = G.bbox(parcel); const A = G.absArea(parcel);
    const inter = ring => G.clip([parcel], [ring.map(c => [c[0], c[1]])], ClipperLib.ClipType.ctIntersection).reduce((s, q) => s + G.absArea(q), 0);
    const [gn, fl, li] = await Promise.all([
      nplLayer('grundnutzung', [bb[0] - 2, bb[1] - 2, bb[2] + 2, bb[3] + 2]).catch(() => null),
      nplLayer('ueberlagernde_nutzungsplaninhalte_flaechenbezogene_festlegungen', [bb[0] - 2, bb[1] - 2, bb[2] + 2, bb[3] + 2]).catch(() => null),
      nplLayer('ueberlagernde_nutzungsplaninhalte_linienbezogene_festlegungen', [bb[0] - 40, bb[1] - 40, bb[2] + 40, bb[3] + 40]).catch(() => null)
    ]);
    if (!gn && !fl && !li) throw new Error('Nutzungsplanung nicht erreichbar');
    const zones = (gn || []).map(f => ({ p: f.properties, a: ringsOf(f.geometry).reduce((s, r) => s + inter(r), 0) })).filter(z => z.a > 0.5).sort((a, b) => b.a - a.a);
    const z = zones[0] && zones[0].p;
    const overlays = (fl || []).map(f => ({ p: f.properties, g: f.geometry, a: ringsOf(f.geometry).reduce((s, r) => s + inter(r), 0) })).filter(o => o.a > 1).map(o => ({
      rings: ringsOf(o.g).map(r => r.map(c => [c[0], c[1]])),
      label: o.p.typ_kommunal_bezeichnung && o.p.typ_kommunal_bezeichnung !== 'BauG_Sondernutzungsplan' ? o.p.typ_kommunal_bezeichnung : (o.p.bemerkungen || o.p.typ_kantonal_bezeichnung),
      typ: o.p.typ_kantonal_bezeichnung, code: o.p.hauptnutzung_code, share: o.a / A, snp: o.p.hauptnutzung_code === 61 || /sondernutzung|überbauungsplan|gestaltungsplan/i.test(o.p.typ_kantonal_bezeichnung || ''), docs: docsOf(o.p), status: o.p.rechtsstatus }));
    const lines = (li || []).flatMap(f => linesOf(f.geometry).map(c => ({ coords: c.map(q => [q[0], q[1]]), label: f.properties.typ_kommunal_bezeichnung, typ: f.properties.typ_kantonal_bezeichnung, code: f.properties.hauptnutzung_code, note: f.properties.bemerkungen, docs: docsOf(f.properties) })))
      .filter(l => l.coords.some((q, i) => i && G.segDist(G.centroid(parcel), l.coords[i - 1], q) < Math.max(bb[2] - bb[0], bb[3] - bb[1]) / 2 + 30));
    const label = z ? (z.typ_kommunal_bezeichnung || z.typ_kantonal_bezeichnung || '') : '';
    const sys = /PBG/i.test(label + (z && z.typ_kantonal_bezeichnung)) ? 'PBG' : /BauG/i.test(label + (z && z.typ_kantonal_bezeichnung)) ? 'BauG' : null;
    return {
      loaded: new Date().toISOString(), source: 'Nutzungsplanung (kantonal/kommunal) via geodienste.ch',
      zone: z ? { label: label.replace(/^(BauG|PBG)_/, ''), raw: label, kantonal: (z.typ_kantonal_bezeichnung || '').replace(/^(BauG|PBG)_/, ''), haupt: z.hauptnutzung_bezeichnung, share: zones[0].a / A, docs: docsOf(z), status: z.rechtsstatus, others: zones.slice(1).map(o => (o.p.typ_kommunal_bezeichnung || '').replace(/^(BauG|PBG)_/, '')) } : null,
      system: sys, overlays, lines
    };
  };

  /* ---------- Umgebungsgebäude: OSM-Grundrisse + GWR-Geschosse (Fallback swisstopo VECTOR25) ---------- */
  GeoAdmin.context = async function (center, radius = 110) {
    const [E, N] = center; const sw = lv95ToWgs(E - radius, N - radius), ne = lv95ToWgs(E + radius, N + radius);
    let polys = [];
    try {
      const q = `[out:json][timeout:25];(way["building"](${sw[0]},${sw[1]},${ne[0]},${ne[1]}););out geom tags;`;
      const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q) });
      const j = await r.json();
      polys = (j.elements || []).filter(e => e.geometry && e.geometry.length > 3).map(e => ({ poly: G.ensureCCW(e.geometry.slice(0, -1).map(g => wgsToLv95(g.lat, g.lon))), tags: e.tags || {}, src: 'OpenStreetMap' }));
    } catch (e) { polys = []; }
    if (!polys.length) {
      try {
        const env = `${E - radius},${N - radius},${E + radius},${N + radius}`;
        const res = await getJSON(`${API}/all/MapServer/identify?geometry=${env}&geometryType=esriGeometryEnvelope&layers=all:ch.swisstopo.vec25-gebaeude&mapExtent=${env}&imageDisplay=1000,1000,96&tolerance=0&returnGeometry=true&geometryFormat=geojson&sr=2056&limit=200`);
        polys = (res.results || []).flatMap(r => ringsOf(r.geometry).map(rg => ({ poly: G.ensureCCW(rg.slice(0, -1).map(c => [c[0], c[1]])), tags: {}, src: 'swisstopo VECTOR25' })));
      } catch (e) { }
    }
    let gwr = [];
    try {
      const env = `${E - radius},${N - radius},${E + radius},${N + radius}`;
      const res = await getJSON(`${API}/all/MapServer/identify?geometry=${env}&geometryType=esriGeometryEnvelope&layers=all:ch.bfs.gebaeude_wohnungs_register&mapExtent=${env}&imageDisplay=1000,1000,96&tolerance=0&returnGeometry=false&sr=2056&limit=200`);
      gwr = (res.results || []).map(r => r.properties || r.attributes || {}).filter(p => p.gkode).map(p => ({ E: p.gkode, N: p.gkodn, gastw: p.gastw, garea: p.garea, gkat: p.gkat, gklas: p.gklas, gbauj: p.gbauj, adr: p.strname_deinr || p.label }));
    } catch (e) { }
    const buildings = polys.filter(b => G.absArea(b.poly) > 6).map(b => {
      const t = b.tags; const g = gwr.find(x => G.pointInPoly([x.E, x.N], b.poly));
      const lv = Number(t['building:levels']) || (g && g.gastw) || (G.absArea(b.poly) < 25 ? 1 : 2);
      const h = Number(String(t.height || '').replace(/[^\d.]/g, '')) || lv * 3.0 + (G.absArea(b.poly) < 25 ? 0.2 : 0.6);
      const roof = t['roof:shape'] || (G.absArea(b.poly) < 25 ? 'flat' : null);
      return { poly: b.poly, h, levels: lv, roof, src: b.src + (g ? ' + GWR' : ''), adr: g && g.adr, baujahr: g && g.gbauj };
    });
    return { loaded: new Date().toISOString(), radius, buildings, gwrCount: gwr.length };
  };

  /** Terrainhöhe an Punkt (bilinear) */
  function terrainAt(t, E, N) {
    if (!t) return 0;
    const fx = (E - t.origin[0]) / t.dx, fy = (N - t.origin[1]) / t.dx;
    const i = Math.max(0, Math.min(t.n - 2, Math.floor(fx))), j = Math.max(0, Math.min(t.n - 2, Math.floor(fy)));
    const u = Math.max(0, Math.min(1, fx - i)), v = Math.max(0, Math.min(1, fy - j));
    const h = (a, b) => t.heights[b * t.n + a];
    return (1 - u) * (1 - v) * h(i, j) + u * (1 - v) * h(i + 1, j) + (1 - u) * v * h(i, j + 1) + u * v * h(i + 1, j + 1);
  }
  /** Gefälle der Parzelle (%), Fallrichtung (rad, Richtung bergab) */
  function slopeOf(t, poly) {
    if (!t) return { pct: 0, dir: 0 };
    const c = G.centroid(poly); const d = 5;
    const gx = (terrainAt(t, c[0] + d, c[1]) - terrainAt(t, c[0] - d, c[1])) / (2 * d);
    const gy = (terrainAt(t, c[0], c[1] + d) - terrainAt(t, c[0], c[1] - d)) / (2 * d);
    const g = Math.hypot(gx, gy);
    return { pct: g * 100, dir: Math.atan2(-gy, -gx) };
  }

  window.Geo = { lv95ToWgs, wgsToLv95, G, GeoAdmin, terrainAt, slopeOf };
})();
