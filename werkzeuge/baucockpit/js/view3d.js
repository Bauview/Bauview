/* Baucockpit – 3D-Ansicht: Gelände, Varianten, begehbares Modell, Export */
(function () {
  const { G, terrainAt, GeoAdmin } = Geo;

  /* Fassaden-/Materialstile */
  const STYLES = {
    holz: { name: 'Holz', wall: '#a7774a', wall2: '#8d6239', roof: '#4a4a48', frame: '#3b2f25', tex: 'vbatten' },
    beton_holz: { name: 'Sichtbeton und Holz', wall: '#b9b7b1', wall2: '#a26f42', roof: '#5b5b58', frame: '#2b2b2b', tex: 'concrete' },
    minimal: { name: 'Minimal hell', wall: '#f1eee8', wall2: '#e4e0d8', roof: '#d8d5cf', frame: '#9a9a9a', tex: 'plain' },
    dunkel: { name: 'Dunkle Hülle', wall: '#2f3133', wall2: '#3c3f42', roof: '#202122', frame: '#151515', tex: 'vbatten' },
    stein_putz: { name: 'Naturstein und Putz', wall: '#e9e3d6', wall2: '#9b9184', roof: '#66625c', frame: '#4a4036', tex: 'stone' },
    alpin: { name: 'Alpin modern', wall: '#7a5a3e', wall2: '#cfc8bb', roof: '#3b3b3b', frame: '#2a2018', tex: 'vbatten' },
    putz_holz: { name: 'Putz und Holz', wall: '#ece7de', wall2: '#b0814f', roof: '#5a5854', frame: '#3a3a3a', tex: 'plain' },
    metall: { name: 'Metall', wall: '#8b9096', wall2: '#6d7177', roof: '#4b4f53', frame: '#1f2124', tex: 'seam' }
  };

  function makeTexture(kind, color) {
    const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
    x.fillStyle = color; x.fillRect(0, 0, 256, 256);
    const shade = (a) => `rgba(0,0,0,${a})`, light = (a) => `rgba(255,255,255,${a})`;
    if (kind === 'vbatten') { for (let i = 0; i < 256; i += 16) { x.fillStyle = shade(0.25); x.fillRect(i, 0, 2, 256); x.fillStyle = light(0.06); x.fillRect(i + 3, 0, 5, 256); } }
    if (kind === 'seam') { for (let i = 0; i < 256; i += 32) { x.fillStyle = shade(0.3); x.fillRect(i, 0, 2, 256); x.fillStyle = light(0.1); x.fillRect(i + 2, 0, 2, 256); } }
    if (kind === 'concrete') { for (let i = 0; i < 2500; i++) { x.fillStyle = Math.random() > 0.5 ? shade(0.04) : light(0.05); x.fillRect(Math.random() * 256, Math.random() * 256, 2, 2); } x.strokeStyle = shade(0.15); x.strokeRect(0, 0, 256, 128); x.strokeRect(0, 128, 256, 128); }
    if (kind === 'stone') { for (let y = 0; y < 256; y += 32) for (let xx = (y / 32 % 2) * 24; xx < 256; xx += 48) { x.fillStyle = `hsl(35,${8 + Math.random() * 8}%,${48 + Math.random() * 18}%)`; x.fillRect(xx + 1, y + 1, 46, 30); } }
    if (kind === 'plain') { for (let i = 0; i < 1200; i++) { x.fillStyle = shade(0.025); x.fillRect(Math.random() * 256, Math.random() * 256, 1, 1); } }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.encoding = THREE.sRGBEncoding; return t;
  }

  class View3D {
    constructor(container, app) {
      this.app = app; this.el = container;
      const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      r.setPixelRatio(Math.min(2, window.devicePixelRatio)); r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
      r.outputEncoding = THREE.sRGBEncoding; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.9;
      container.appendChild(r.domElement); this.renderer = r;
      this.scene = new THREE.Scene(); this.scene.background = new THREE.Color('#dfe7ec'); this.scene.fog = new THREE.Fog('#dfe7ec', 400, 1600);
      this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 3000); this.camera.position.set(60, 45, 60);
      this.orbit = new THREE.OrbitControls(this.camera, r.domElement); this.orbit.enableDamping = true; this.orbit.maxPolarAngle = Math.PI * 0.495;
      this.walk = new THREE.PointerLockControls(this.camera, r.domElement); this.walkMode = false; this.keys = {};
      this.hemi = new THREE.HemisphereLight('#ffffff', '#8a8070', 0.55); this.scene.add(this.hemi);
      this.sun = new THREE.DirectionalLight('#fff6e8', 1.25); this.sun.castShadow = true; this.sun.shadow.mapSize.set(2048, 2048);
      Object.assign(this.sun.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, near: 1, far: 500 }); this.scene.add(this.sun, this.sun.target);
      this.root = new THREE.Group(); this.scene.add(this.root);
      this.opts = { showTerrain: true, showMassing: true, showBuilding: true, showFurniture: true, cutLevel: 99, styleKey: 'putz_holz', sunHour: 14, sunMonth: 6, showOrtho: true, showContext: true };
      this.clock = new THREE.Clock();
      window.addEventListener('keydown', e => { this.keys[e.code] = true; if (this.walkMode && (e.code === 'PageUp' || e.code === 'PageDown')) this._levelJump(e.code === 'PageUp' ? 1 : -1); });
      window.addEventListener('keyup', e => { this.keys[e.code] = false; });
      this.walk.addEventListener('unlock', () => { if (this.walkMode) this.setWalk(false); });
      this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(container); this.resize();
      const loop = () => { this.raf = requestAnimationFrame(loop); if (this.el.isConnected && this.el.offsetParent !== null) this._tick(); }; loop();
    }
    resize() { const w = this.el.clientWidth || 300, h = this.el.clientHeight || 200; this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
    _tick() {
      const dt = Math.min(0.05, this.clock.getDelta());
      if (this.walkMode && this.walk.isLocked) {
        const sp = (this.keys.ShiftLeft ? 4.5 : 1.8) * dt;
        if (this.keys.KeyW || this.keys.ArrowUp) this.walk.moveForward(sp);
        if (this.keys.KeyS || this.keys.ArrowDown) this.walk.moveForward(-sp);
        if (this.keys.KeyA || this.keys.ArrowLeft) this.walk.moveRight(-sp);
        if (this.keys.KeyD || this.keys.ArrowRight) this.walk.moveRight(sp);
        // Bodenhöhe: Geschoss oder Gelände
        const p = this.camera.position; const g = this._groundAt(p.x, p.z); p.y += ((g + 1.65) - p.y) * Math.min(1, dt * 8);
      } else this.orbit.update();
      this.renderer.render(this.scene, this.camera);
    }
    /* Koordinatensystem: x = E - E0, z = -(N - N0), y = H - H0 */
    w(E, N, H) { return new THREE.Vector3(E - this.E0, H - this.H0, -(N - this.N0)); }
    _groundAt(x, z) {
      const E = x + this.E0, N = -z + this.N0;
      let best = this.terrain ? terrainAt(this.terrain, E, N) - this.H0 : 0;
      if (this.floors) {
        const camY = this.camera.position.y - 1.65;
        for (const f of this.floors) if (G.pointInPoly([E, N], f.poly) && f.y <= camY + 1.2 && f.y > best - 0.01) best = f.y;
      }
      return best;
    }
    _levelJump(d) {
      if (!this.floors || !this.floors.length) return;
      const ys = [...new Set(this.floors.map(f => Math.round(f.y * 100) / 100))].sort((a, b) => a - b);
      const cur = this.camera.position.y - 1.65; let idx = ys.findIndex(y => y > cur - 0.3); if (idx < 0) idx = ys.length - 1;
      const n = ys[Math.max(0, Math.min(ys.length - 1, idx + d))]; this.camera.position.y = n + 1.65 + 0.01;
      this.floors.forEach(f => f._force = f.y === n); // Ebene erzwingen
    }
    setWalk(on) {
      this.walkMode = on;
      if (on) {
        // Start vor der Haustür bzw. im EG
        const s = this.walkStart || this.orbit.target.clone();
        this.camera.position.set(s.x, s.y + 1.65, s.z); this.walk.lock(); this.orbit.enabled = false;
        if (this.walkLook) this.camera.lookAt(this.walkLook);
      } else { this.walk.unlock(); this.orbit.enabled = true; this.camera.position.set(this.orbit.target.x + 40, this.orbit.target.y + 30, this.orbit.target.z + 40); }
      this.app.onWalkChange && this.app.onWalkChange(on);
    }
    clear() { while (this.root.children.length) { const o = this.root.children.pop(); o.traverse(c => { c.geometry && c.geometry.dispose(); }); } if (this.mats) Object.values(this.mats).forEach(m => { m.map && m.map.dispose(); m.dispose(); }); if (this._terrMat) { this._terrMat.map && this._terrMat.map.dispose(); this._terrMat.dispose(); } }

    /** Szene aus Projekt aufbauen */
    build(project) {
      this.project = project;
      this.clear(); this.floors = [];
      const parcel = project.parcel && project.parcel.polygon; if (!parcel || !parcel.length) return;
      const c = G.centroid(parcel); this.E0 = c[0]; this.N0 = c[1];
      this.terrain = project.terrain; this.H0 = this.terrain ? this.terrain.min : 0;
      const st = STYLES[this.opts.styleKey] || STYLES.putz_holz;
      const facadeSel = this.app.facadeColor && this.app.facadeColor();
      this.mats = {
        wall: new THREE.MeshStandardMaterial({ color: facadeSel || st.wall, map: makeTexture(st.tex, facadeSel || st.wall), roughness: 0.85 }),
        wall2: new THREE.MeshStandardMaterial({ color: st.wall2, map: makeTexture(st.tex === 'plain' ? 'vbatten' : st.tex, st.wall2), roughness: 0.8 }),
        inner: new THREE.MeshStandardMaterial({ color: '#f4f1ec', roughness: 0.95 }),
        slab: new THREE.MeshStandardMaterial({ color: '#d9d4cb', roughness: 0.9 }),
        floor: new THREE.MeshStandardMaterial({ color: '#c8a77f', roughness: 0.7 }),
        roof: new THREE.MeshStandardMaterial({ color: st.roof, roughness: 0.9, side: THREE.DoubleSide }),
        frame: new THREE.MeshStandardMaterial({ color: st.frame, roughness: 0.5 }),
        glass: new THREE.MeshPhysicalMaterial({ color: '#a9c4d1', roughness: 0.05, metalness: 0, transmission: 0.6, transparent: true, opacity: 0.35 }),
        door: new THREE.MeshStandardMaterial({ color: '#5b4a3a', roughness: 0.6 }),
        furn: new THREE.MeshStandardMaterial({ color: '#e9e4dc', roughness: 0.8 }),
        furn2: new THREE.MeshStandardMaterial({ color: '#7f8a8f', roughness: 0.7 }),
        mass: new THREE.MeshStandardMaterial({ color: '#f3efe8', roughness: 0.9 }),
        massGhost: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, transparent: true, opacity: 0.25 }),
        path: new THREE.MeshStandardMaterial({ color: '#b9b2a6', roughness: 0.95 })
      };
      if (this.terrain && this.opts.showTerrain) this._terrain(project);
      this._line(parcel, '#d0462f', 0.15, true);
      const bld = project.buildable; if (bld) this._line(bld, '#2d6a8f', 0.12, true, true);
      const v = project.variants.find(x => x.id === project.activeVariant);
      const hasPlan = project.plan && project.plan.walls.length && project.planFromVariant;
      if (v && this.opts.showMassing) this._massing(v, hasPlan && this.opts.showBuilding);
      if (hasPlan && this.opts.showBuilding) this._building(project);
      if (this.terrain) this._extras(project);
      if (project.context && this.opts.showContext) this._context(project);
      this._sun();
      // Kamera-Ziel
      const ty = v ? v.parts[0].base - this.H0 + 3 : 0;
      this.orbit.target.set(0, ty, 0);
      if (!this._camSet) { const bb = G.bbox(parcel); const s = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * (project.context && this.opts.showContext ? 2.6 : 1); this.camera.position.set(s * 0.9, ty + s * 0.7, s * 0.9); this._camSet = true; }
    }
    resetCamera() { this._camSet = false; }
    _sun() {
      // vereinfachte Sonnenstellung (Breite 47.4°)
      const lat = 47.4 * Math.PI / 180, decl = 23.44 * Math.PI / 180 * Math.sin((2 * Math.PI / 12) * (this.opts.sunMonth - 3.7));
      const h = (this.opts.sunHour - 12.5) * 15 * Math.PI / 180;
      const alt = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(h));
      const az = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)); // ab Süden
      const d = 150; const x = -Math.sin(az) * Math.cos(alt) * d, z = Math.cos(az) * Math.cos(alt) * d, y = Math.max(2, Math.sin(alt) * d);
      this.sun.position.set(this.orbit.target.x + x, this.orbit.target.y + y, this.orbit.target.z + z); this.sun.target.position.copy(this.orbit.target);
      this.sun.intensity = alt > 0 ? 1.3 : 0.05; this.hemi.intensity = alt > 0 ? 0.55 : 0.25;
    }
    _terrain(project) {
      const t = (this.opts.showContext && project.context && project.context.terrain) || this.terrain; const n = t.n; const size = t.dx * (n - 1);
      const geo = new THREE.PlaneGeometry(size, size, n - 1, n - 1);
      const pos = geo.attributes.position;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const idx = (n - 1 - j) * n + i; // PlaneGeometry: Zeilen von oben (+y) nach unten
        const E = t.origin[0] + i * t.dx, N = t.origin[1] + j * t.dx;
        pos.setXYZ(idx, E - this.E0, t.heights[j * n + i] - this.H0, -(N - this.N0));
      }
      geo.computeVertexNormals();
      const mat = this._terrMat = new THREE.MeshStandardMaterial({ color: '#7d9560', roughness: 1 });
      const mesh = new THREE.Mesh(geo, mat); mesh.receiveShadow = true; mesh.name = 'Gelaende'; this.root.add(mesh);
      if (this.opts.showOrtho) {
        const bbox = [t.origin[0], t.origin[1], t.origin[0] + size, t.origin[1] + size];
        const px = size > 150 ? 2048 : 1024; const url = GeoAdmin.wmsUrl('ch.swisstopo.swissimage', bbox, px, px, 'image/jpeg');
        new THREE.TextureLoader().setCrossOrigin('anonymous').load(url, tex => {
          tex.encoding = THREE.sRGBEncoding; tex.flipY = true; mat.map = tex; mat.color.set('#ffffff'); mat.needsUpdate = true;
          // UV: PlaneGeometry-Standard passt (u: West→Ost, v: Süd→Nord)
        }, undefined, () => {});
      }
    }
    _line(poly, color, lift, closed, dashed) {
      const pts = poly.map(p => this.w(p[0], p[1], (this.terrain ? terrainAt(this.terrain, p[0], p[1]) : this.H0) + lift));
      // Linie dem Gelände folgend verdichten
      const dense = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length]; const L = G.dist(a, b); const k = Math.max(1, Math.ceil(L / 2));
        for (let s = 0; s < k; s++) { const t = s / k; const E = a[0] + (b[0] - a[0]) * t, N = a[1] + (b[1] - a[1]) * t; dense.push(this.w(E, N, (this.terrain ? terrainAt(this.terrain, E, N) : this.H0) + lift)); }
      }
      if (closed) dense.push(dense[0]);
      const geo = new THREE.BufferGeometry().setFromPoints(dense.length ? dense : pts);
      const mat = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 1, gapSize: 0.6 }) : new THREE.LineBasicMaterial({ color, linewidth: 2 });
      const l = new THREE.Line(geo, mat); if (dashed) l.computeLineDistances(); this.root.add(l);
    }
    _prism(poly, y0, y1, mat, name, holes) {
      const shape = new THREE.Shape(poly.map(p => new THREE.Vector2(p[0] - this.E0, p[1] - this.N0)));
      for (const h of holes || []) shape.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p[0] - this.E0, p[1] - this.N0))));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.01, y1 - y0), bevelEnabled: false });
      geo.rotateX(-Math.PI / 2); // Shape-y (Nord) → -z
      geo.translate(0, y0 - this.H0, 0);
      const m = new THREE.Mesh(geo, mat); m.castShadow = m.receiveShadow = true; if (name) m.name = name; this.root.add(m); return m;
    }
    /** Mesh mit lokaler Basis (u = Länge, v = Höhe/Normale, w = Breite) platzieren */
    _orient(mesh, u, n, w, center) { if (new THREE.Vector3().crossVectors(u, n).dot(w) < 0) w = w.clone().negate(); const m = new THREE.Matrix4().makeBasis(u, n, w); mesh.quaternion.setFromRotationMatrix(m); mesh.position.copy(center); }
    /** Steildach über Rechteck (Weltkoordinaten-Ecken p0..p3, achsparallel im Plan) */
    _pitchedRoof(corners, eaveY, roof, solid, mat) {
      const [p0, p1, , p3] = corners; const L1 = G.dist(p0, p1), L2 = G.dist(p0, p3);
      // First parallel zur längeren Seite
      const [a, b, c] = L1 >= L2 ? [p0, p1, p3] : [p0, p3, p1];
      const len = G.dist(a, b), span = G.dist(a, c); const tan = Math.tan((roof.pitch || 30) * Math.PI / 180);
      const U = new THREE.Vector3(b[0] - a[0], 0, -(b[1] - a[1])).normalize(); const S = new THREE.Vector3(c[0] - a[0], 0, -(c[1] - a[1])).normalize();
      const A3 = this.w(a[0], a[1], eaveY); const ov = 0.5, ovG = 0.3, th = 0.28;
      const rise = roof.type === 'pult' ? span * tan : span / 2 * tan;
      if (solid) { // Massenmodell: Giebelprisma
        const sh = new THREE.Shape(roof.type === 'pult' ? [new THREE.Vector2(0, 0), new THREE.Vector2(span, 0), new THREE.Vector2(span, rise)] : [new THREE.Vector2(0, 0), new THREE.Vector2(span, 0), new THREE.Vector2(span / 2, rise)]);
        const g = new THREE.ExtrudeGeometry(sh, { depth: len, bevelEnabled: false }); const m = new THREE.Mesh(g, mat); m.castShadow = m.receiveShadow = true;
        const Y = new THREE.Vector3(0, 1, 0); const Z = U.clone(); const X = S.clone(); // shape x→S, y→Y, extrude z→U
        const mir = new THREE.Vector3().crossVectors(X, Y).dot(Z) < 0;
        this._orient(m, X, Y, Z, mir ? A3.clone().add(U.clone().multiplyScalar(len)) : A3); m.name = 'Dach'; this.root.add(m); return;
      }
      const planes = roof.type === 'pult' ? [[0, span, 1]] : [[0, span / 2, 1], [span, span / 2, -1]];
      for (const [s0, s1w, dir] of planes) {
        const run = s1w + ov; const slopeLen = run / Math.cos(Math.atan(tan));
        const dirS = S.clone().multiplyScalar(dir); const up = new THREE.Vector3(0, 1, 0);
        const slopeV = dirS.clone().add(up.clone().multiplyScalar(tan)).normalize();
        const normal = new THREE.Vector3().crossVectors(slopeV, U).normalize(); if (normal.y < 0) normal.negate();
        const eave = A3.clone().add(S.clone().multiplyScalar(s0)).add(dirS.clone().multiplyScalar(-ov)).add(up.clone().multiplyScalar(-ov * tan));
        const center = eave.clone().add(slopeV.clone().multiplyScalar(slopeLen / 2)).add(U.clone().multiplyScalar(len / 2)).add(normal.clone().multiplyScalar(th / 2 + 0.02));
        const g = new THREE.BoxGeometry(len + 2 * ovG, th, slopeLen); const m = new THREE.Mesh(g, mat); m.castShadow = m.receiveShadow = true;
        this._orient(m, U, normal, slopeV, center); m.name = 'Dach'; this.root.add(m);
      }
    }
    _massing(v, ghost) {
      for (const p of v.parts) {
        const tMin = Math.min(...p.poly.map(q => terrainAt(this.terrain, q[0], q[1])));
        const eave = Engine.partEave(p, v, this.project.rules);
        const y0 = ghost ? p.base : Math.min(p.base, tMin) - 0.1; const y1 = p.roof ? eave : p.base + p.nf * v.fh + 0.5;
        const m = this._prism(p.poly, y0, y1, ghost ? this.mats.massGhost : this.mats.mass, 'Volumen');
        if (p.roof && !ghost) for (const r of G.rectDecompose(G.rotatePoly(p.poly, -(v.angle || 0), [0, 0]))) this._pitchedRoof(G.rectPoly(r).map(q => G.rotate(q, v.angle || 0)), eave, p.roof, true, this.mats.roof);
        if (ghost) { m.castShadow = false; continue; }
        for (let f = 1; f < p.nf + 1; f++) {
          const y = p.base + f * v.fh - this.H0;
          const pts = [...p.poly, p.poly[0]].map(q => new THREE.Vector3(q[0] - this.E0, y + 0.02, -(q[1] - this.N0)));
          this.root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#b8b0a3' })));
        }
      }
    }
    /** Nachbargebäude (AV/GWR), Strassen und Gewässer */
    _context(project) {
      const cx = project.context; const t = cx.terrain || this.terrain; const parcel = project.parcel.polygon;
      const mB = new THREE.MeshStandardMaterial({ color: '#dcd8d0', roughness: 0.95 });
      const mR = new THREE.MeshStandardMaterial({ color: '#8f8077', roughness: 0.9, side: THREE.DoubleSide });
      const mBest = new THREE.MeshStandardMaterial({ color: '#c0563c', roughness: 0.9, transparent: true, opacity: 0.35 });
      const mStr = new THREE.MeshStandardMaterial({ color: '#8c8984', roughness: 1 });
      const mWat = new THREE.MeshStandardMaterial({ color: '#6f9fc0', roughness: 0.3 });
      const box = cx.box || null;
      for (const g of cx.ground || []) { const poly = box ? (G.clip([g.poly], [[[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]], ClipperLib.ClipType.ctIntersection)[0]) : g.poly; if (poly && poly.length > 2) this._drape(poly, /Gewaesser/.test(g.art) ? mWat : mStr, 0.04, g.art, t); }
      for (const b of cx.buildings || []) {
        const own = G.pointInPoly(G.centroid(b.poly), parcel);
        const hs = b.poly.map(q => terrainAt(t, q[0], q[1])); const base = Math.min(...hs) - 0.3;
        const eave = Math.max(...hs) + b.h;
        this._prism(b.poly, base, eave, own ? mBest : mB, own ? 'Bestand (Parzelle)' : 'Nachbargebäude');
        if (!own && b.roof === 'gable') {
          const mr = G.minRect(b.poly); const rp = G.rotatePoly(b.poly, -mr.ang, [0, 0]); const bb = G.bbox(rp);
          const corners = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].map(q => G.rotate(q, mr.ang));
          this._pitchedRoof(corners, eave, { type: 'sattel', pitch: 30 }, true, mR);
        }
      }
    }
    _extras(project) {
      const ex = (project.site && project.site.extras) || [];
      for (const e of ex) {
        if (e.type === 'pp2' || e.type === 'zufahrt') { this._drape(e.poly, this.mats.path, 0.06, e.type === 'pp2' ? 'Parkplatz' : 'Zufahrt'); continue; }
        const y0 = e.base;
        if (e.type === 'garage_ext') { this._prism(e.poly, y0 - 0.3, y0 + e.h, this.mats.wall2, 'Garage'); this._prism(G.offset(e.poly, 0.2)[0], y0 + e.h, y0 + e.h + 0.25, this.mats.roof, 'Garagendach'); }
        else { // Carport: Stützen + Dach
          for (const q of G.offset(e.poly, -0.15)[0]) this._prism(G.offset([[q[0] - 0.08, q[1] - 0.08], [q[0] + 0.08, q[1] - 0.08], [q[0] + 0.08, q[1] + 0.08], [q[0] - 0.08, q[1] + 0.08]], 0)[0], y0, y0 + e.h, this.mats.frame, 'Stuetze');
          this._prism(G.offset(e.poly, 0.3)[0], y0 + e.h, y0 + e.h + 0.22, this.mats.wall2, 'Carportdach'); this._drape(e.poly, this.mats.path, 0.04, 'Carportboden');
        }
      }
    }
    /** Fläche dem Gelände folgend (Beläge) */
    _drape(poly, mat, lift, name, terr) {
      const T0 = terr || this.terrain;
      const bb = G.bbox(poly); const n = 10; const verts = [], idx = [];
      const shape = new THREE.Shape(poly.map(p => new THREE.Vector2(p[0], p[1]))); const g = new THREE.ShapeGeometry(shape, 1);
      // feiner triangulieren über Rastergitter (Clip)
      const geo = new THREE.BufferGeometry(); const pos = [];
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const x0 = bb[0] + (bb[2] - bb[0]) * i / n, x1 = bb[0] + (bb[2] - bb[0]) * (i + 1) / n, y0 = bb[1] + (bb[3] - bb[1]) * j / n, y1 = bb[1] + (bb[3] - bb[1]) * (j + 1) / n;
        for (const c of G.clip([[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]], [poly], ClipperLib.ClipType.ctIntersection)) {
          for (let k = 1; k + 1 < c.length; k++) for (const q of [c[0], c[k], c[k + 1]]) { const v = this.w(q[0], q[1], terrainAt(T0, q[0], q[1]) + lift); pos.push(v.x, v.y, v.z); }
        }
      }
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals(); g.dispose();
      const m = new THREE.Mesh(geo, mat); m.material.side = THREE.DoubleSide; m.receiveShadow = true; m.name = name; this.root.add(m);
    }
    _building(project) {
      const P = project.plan; const pl = project.placement; const toW = p => Plan.toWorld(project, p);
      const levels = P.levels.slice().sort((a, b) => a.z - b.z);
      const visible = levels.filter((l, i) => i <= this.opts.cutLevel);
      let doorWorld = null;
      for (const l of visible) {
        const y0 = pl.base + l.z; const H = l.h; const cut = l === visible[visible.length - 1] && visible.length < levels.length;
        // Bodenplatte mit Treppenloch
        for (const o of l.outline || []) {
          const wp = o.map(toW); const holes = (l.holes || []).map(h => h.map(toW));
          this._prism(wp, y0 - 0.25, y0, this.mats.slab, 'Decke', holes);
          this._prism(G.offset(wp, -0.36)[0] || wp, y0, y0 + 0.02, this.mats.floor, 'Boden', holes);
          this.floors.push({ poly: wp, y: y0 + 0.02 - this.H0 });
        }
        // Dach
        if (!cut && l.roof) { for (const r of l.roofRects || []) this._pitchedRoof(G.rectPoly(r).map(toW), y0 + (l.roof.kn || 1), l.roof, false, this.mats.roof); }
        else if (!cut) {
          const above = levels.filter(a => Math.abs(a.z - (l.z + H)) < 0.05).flatMap(a => (a.outline || []).map(o => o.map(toW)));
          for (const o of l.outline || []) {
            const wp = o.map(toW); const free = above.length ? G.difference(wp, above) : [wp];
            for (const f of free) if (G.absArea(f) > 0.5) { this._prism(f, y0 + H - 0.3, y0 + H + 0.2, this.mats.roof, 'Dach'); const att = G.offset(f, -0.2)[0]; if (att) { const ring = G.difference(f, att); ring.forEach(r => this._prism(r, y0 + H + 0.2, y0 + H + (above.length ? 1.1 : 0.45), this.mats.roof, 'Brüstung')); } }
          }
        }
        // Wände als Profil mit Aussparungen (Dachschräge im DG)
        const fullH = l.roof ? null : H - 0.25;
        for (const w of P.walls.filter(w => w.level === l.id)) {
          const ops = P.openings.filter(o => o.wall === w.id).sort((a, b) => a.pos - b.pos);
          const A = toW(w.a), B = toW(w.b); const L = G.dist(A, B); if (L < 0.02) continue;
          const ang = Math.atan2(B[1] - A[1], B[0] - A[0]);
          const s0 = -(w.ext ? w.t / 2 : 0), s1 = L + (w.ext ? w.t / 2 : 0);
          const hAt = s => { if (cut) return 1.2; if (!l.roof) return fullH; const u = (s / (G.dist(w.a, w.b) || 1)); const pt = [w.a[0] + (w.b[0] - w.a[0]) * u, w.a[1] + (w.b[1] - w.a[1]) * u]; return Plan.roofHeightAt(l, pt); };
          const tops = [[s0, hAt(s0)]];
          if (l.roof && !cut) for (let k = 1; k < 24; k++) { const s = s0 + (s1 - s0) * k / 24; tops.push([s, hAt(s)]); }
          tops.push([s1, hAt(s1)]);
          const sh = new THREE.Shape(); sh.moveTo(s0, 0); sh.lineTo(s1, 0); for (const [s, h] of tops.slice().reverse()) sh.lineTo(s, h); sh.closePath();
          const minTop = Math.min(...tops.map(t => t[1]));
          for (const o of ops) { const c = o.pos * L, h = o.w / 2; const top = Math.min(o.sill + o.h, minTop - 0.05); if (top - o.sill < 0.2 && !cut) continue; const z1 = cut ? Math.min(top, 1.15) : top; if (z1 <= o.sill + 0.05) continue; const hole = new THREE.Path(); hole.moveTo(c - h, o.sill); hole.lineTo(c + h, o.sill); hole.lineTo(c + h, z1); hole.lineTo(c - h, z1); hole.closePath(); if (o.sill <= 0.001) { /* Türschwelle: Loch knapp über Boden */ hole.curves = []; const hp = new THREE.Path(); hp.moveTo(c - h, 0.001); hp.lineTo(c + h, 0.001); hp.lineTo(c + h, z1); hp.lineTo(c - h, z1); hp.closePath(); sh.holes.push(hp); } else sh.holes.push(hole); }
          const g = new THREE.ExtrudeGeometry(sh, { depth: w.t, bevelEnabled: false }); g.translate(0, 0, -w.t / 2);
          const mesh = new THREE.Mesh(g, w.ext ? this.mats.wall : this.mats.inner); mesh.castShadow = mesh.receiveShadow = true; mesh.name = w.ext ? 'Aussenwand' : 'Innenwand';
          mesh.position.copy(this.w(A[0], A[1], y0)); mesh.rotation.y = ang; this.root.add(mesh);
          const piece = (a0, a1, z0, z1, mat, depth) => {
            if (a1 - a0 < 0.005 || z1 - z0 < 0.005) return; const gg = new THREE.BoxGeometry(a1 - a0, z1 - z0, depth); const m = new THREE.Mesh(gg, mat); const mid = (a0 + a1) / 2;
            m.position.copy(this.w(A[0] + Math.cos(ang) * mid, A[1] + Math.sin(ang) * mid, y0 + (z0 + z1) / 2)); m.rotation.y = ang; m.castShadow = true; this.root.add(m);
          };
          for (const o of ops) {
            const c = o.pos * L, h = o.w / 2; const top = Math.min(o.sill + o.h, minTop - 0.05, cut ? 1.15 : 99);
            if (o.type === 'window') { piece(c - h, c + h, o.sill, top, this.mats.glass, 0.03); piece(c - h, c + h, o.sill, o.sill + 0.06, this.mats.frame, w.t * 0.6); piece(c - h, c - h + 0.06, o.sill, top, this.mats.frame, 0.1); piece(c + h - 0.06, c + h, o.sill, top, this.mats.frame, 0.1); piece(c - h, c + h, top - 0.06, top, this.mats.frame, 0.1); }
            else if (o.kind === 'garage') piece(c - h, c + h, 0, top, this.mats.frame, 0.06);
            else if (o.type === 'door') {
              const dh = Math.min(o.h, top); const dg = new THREE.BoxGeometry(o.w, dh, 0.04); dg.translate(o.w / 2, dh / 2, 0);
              const dm = new THREE.Mesh(dg, this.mats.door); const hs = o.hinge ? 1 : -1, sd = o.flip ? -1 : 1;
              const hingeS = c + hs * h; dm.position.copy(this.w(A[0] + Math.cos(ang) * hingeS, A[1] + Math.sin(ang) * hingeS, y0)); dm.rotation.y = ang + (hs > 0 ? Math.PI : 0) + sd * hs * 1.1; dm.castShadow = true; this.root.add(dm);
              if (w.ext && Math.abs(l.z) < 0.01 && (!doorWorld || o.kind === 'entry')) doorWorld = { E: A[0] + Math.cos(ang) * c, N: A[1] + Math.sin(ang) * c, y: y0, n: [-Math.sin(ang), Math.cos(ang)] };
            }
          }
        }
        if (this.opts.showFurniture) for (const f of P.furniture.filter(f => f.level === l.id)) this._furniture(f, project, y0, f.h || H);
        else for (const f of P.furniture.filter(f => f.level === l.id && f.stair)) this._furniture(f, project, y0, f.h || H);
      }
      if (doorWorld && this.terrain) this._path(project, doorWorld);
    }
    _furniture(f, project, y0, H) {
      const d = Plan.FURN[f.type]; if (!d) return;
      const c = Plan.toWorld(project, [f.x, f.y]); const rot = (project.placement.rot || 0) + (f.rot || 0) * Math.PI / 180;
      const grp = new THREE.Group(); grp.position.copy(this.w(c[0], c[1], y0 + 0.02)); grp.rotation.y = rot; grp.name = 'Moebel_' + f.type;
      const box = (w, h, dd, x, y, z, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, dd), m || this.mats.furn); b.position.set(x, y, z); b.castShadow = b.receiveShadow = true; grp.add(b); };
      if (f.type === 'treppe') {
        const n = Math.round(H / 0.175); const run = d.d / n;
        for (let i = 0; i < n; i++) box(d.w, 0.05, run + 0.02, 0, (i + 1) * H / n - 0.025, d.d / 2 - (i + 0.5) * run, this.mats.slab);
        box(0.04, 0.9, d.d, d.w / 2, H / 2 + 0.45, 0, this.mats.frame);
        // Treppe als begehbare Rampe für den Rundgang
        const ramp = { stair: true, poly: Plan.furnPoly(f).map(p => Plan.toWorld(project, p)), y0: y0 - this.H0, H };
        this.floors.push({ poly: ramp.poly, y: y0 - this.H0 + 0.02, stair: true });
      } else if (f.type === 'auto') { box(d.w, 0.7, d.d, 0, 0.45, 0, this.mats.furn2); box(d.w * 0.9, 0.5, d.d * 0.5, 0, 1.05, 0.1, this.mats.glass); }
      else if (f.type === 'kueche') { box(d.w, d.h, d.d, 0, d.h / 2, 0); box(d.w, 0.7, 0.35, 0, 1.85, -d.d / 2 + 0.17); }
      else if (f.type === 'bett' || f.type === 'bett1') { box(d.w, 0.45, d.d, 0, 0.22, 0); box(d.w, 0.9, 0.08, 0, 0.45, -d.d / 2); }
      else if (f.type === 'sofa') { box(d.w, 0.42, d.d, 0, 0.21, 0, this.mats.furn2); box(d.w, 0.4, 0.2, 0, 0.6, -d.d / 2 + 0.1, this.mats.furn2); }
      else if (f.type === 'tisch') { box(d.w, 0.05, d.d, 0, 0.73, 0, this.mats.floor); for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.06, 0.7, 0.06, sx * (d.w / 2 - 0.1), 0.35, sz * (d.d / 2 - 0.1), this.mats.frame); }
      else box(d.w, d.h, d.d, 0, d.h / 2, 0);
      this.root.add(grp);
    }
    _path(project, door) {
      const parcel = project.parcel.polygon;
      // nächster Punkt auf der Parzellengrenze (Annahme: Erschliessung dort)
      let best = null; for (let i = 0; i < parcel.length; i++) { const c = G.closestOnSeg([door.E, door.N], parcel[i], parcel[(i + 1) % parcel.length]); const d = G.dist(c.pt, [door.E, door.N]); if (!best || d < best.d) best = { d, pt: c.pt }; }
      const start = [door.E + door.n[0] * 0.3, door.N + door.n[1] * 0.3];
      // Tür zeigt nach aussen?
      const fpIn = G.pointInPoly([door.E + door.n[0] * 1, door.N + door.n[1] * 1], G.union((project.plan.levels.find(x => Math.abs(x.z) < 0.01) || project.plan.levels[0]).outline.map(o => o.map(p => Plan.toWorld(project, p))))[0] || []);
      const nrm = fpIn ? [-door.n[0], -door.n[1]] : door.n;
      const p0 = [door.E + nrm[0] * 0.2, door.N + nrm[1] * 0.2], p1 = [door.E + nrm[0] * 2.5, door.N + nrm[1] * 2.5], p2 = best.pt;
      const pts = [p0, p1, p2]; const wdt = 1.3; const verts = []; const idx = [];
      const dense = [];
      for (let i = 0; i < pts.length - 1; i++) { const a = pts[i], b = pts[i + 1]; const L = G.dist(a, b); const k = Math.max(1, Math.ceil(L / 1)); for (let s = 0; s < k; s++) dense.push([a[0] + (b[0] - a[0]) * s / k, a[1] + (b[1] - a[1]) * s / k]); }
      dense.push(p2);
      dense.forEach((p, i) => {
        const q = dense[Math.min(i + 1, dense.length - 1)], r = dense[Math.max(i - 1, 0)]; const dx = q[0] - r[0], dy = q[1] - r[1]; const L = Math.hypot(dx, dy) || 1; const n = [-dy / L * wdt / 2, dx / L * wdt / 2];
        const tg = terrainAt(this.terrain, p[0], p[1]) + 0.05; const dd = G.dist(p, p0);
        const h = i === 0 ? door.y : tg + Math.max(0, door.y - tg) * Math.max(0, 1 - dd / 3.5);
        const a = this.w(p[0] + n[0], p[1] + n[1], h), b = this.w(p[0] - n[0], p[1] - n[1], h); verts.push(a.x, a.y, a.z, b.x, b.y, b.z);
        if (i) { const k = i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
      });
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3)); geo.setIndex(idx); geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, this.mats.path); m.material.side = THREE.DoubleSide; m.receiveShadow = true; m.name = 'Zugangsweg'; this.root.add(m);
      this.walkStart = this.w(p2[0], p2[1], terrainAt(this.terrain, p2[0], p2[1]));
      this.walkLook = this.w(door.E, door.N, door.y + 1.6);
    }
    applyStyle(key) { this.opts.styleKey = key; }
    screenshot(w = 1920, h = 1080) {
      const r = this.renderer; const old = new THREE.Vector2(); r.getSize(old);
      r.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); r.render(this.scene, this.camera);
      const url = r.domElement.toDataURL('image/jpeg', 0.9);
      r.setSize(old.x, old.y, false); this.resize(); return url;
    }
    exportScene(fmt) {
      const grp = this.root.clone(true);
      // Lumion: Meter, Y-up, Ursprung = Parzellenschwerpunkt (LV95 im Dateinamen/Meta)
      return new Promise((resolve, reject) => {
        if (fmt === 'obj') resolve(new Blob([new THREE.OBJExporter().parse(grp)], { type: 'text/plain' }));
        else if (fmt === 'dae') { const r = new THREE.ColladaExporter().parse(grp, null, { upAxis: 'Y_UP', unitName: 'meter', unitMeter: 1 }); resolve(new Blob([r.data], { type: 'model/vnd.collada+xml' })); }
        else new THREE.GLTFExporter().parse(grp, res => resolve(new Blob([res], { type: 'model/gltf-binary' })), reject, { binary: true });
      });
    }
  }

  window.View3D = View3D; window.STYLES = STYLES;
})();
