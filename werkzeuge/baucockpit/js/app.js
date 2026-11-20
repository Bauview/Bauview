/* Baucockpit – Applikation */
(function () {
  const { G, GeoAdmin, lv95ToWgs, wgsToLv95 } = Geo;
  const fN = Engine.fmtN, fV = Engine.fmtVal;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = Plan.uid;

  const STEPS = [
    { key: 'parcel', n: 1, name: 'Parzelle' },
    { key: 'rules', n: 2, name: 'Baurecht' },
    { key: 'variants', n: 3, name: 'Varianten im Gelände' },
    { key: 'plan', n: 4, name: 'Raumprogramm & Grundriss' },
    { key: 'v3d', n: 5, name: 'Begehbares 3D' },
    { key: 'media', n: 6, name: 'Bilder & Katalog' },
    { key: 'costs', n: 7, name: 'Kosten & Baueingabe' }
  ];

  function newProject(settings) {
    return {
      id: uid('p'), name: 'Neues Projekt', created: new Date().toISOString(), updated: new Date().toISOString(),
      meta: { projNr: settings.projNrPrefix || '', client: '', address: '', notes: '' },
      parcel: { polygon: [], number: '', egrid: '', gemeinde: '', canton: '', area: 0, zone: null, source: '' },
      terrain: null, rules: Engine.defaultRules('W2'), buildable: null,
      variants: [], activeVariant: null, genOpts: { maxFloors: null },
      program: Plan.DEFAULT_PROGRAM.map(r => ({ ...r, id: uid('r') })), plan: Plan.emptyPlan(), placement: null, planFromVariant: null,
      style: 'putz_holz', selections: [], costs: Engine.defaultCostParams(), images: []
    };
  }

  const App = {
    project: null, projects: [], catalog: [], settings: {}, step: 'projects', dirty: false, v3: null,

    async init() {
      this.settings = Object.assign({ office: 'Helbling Architektur GmbH', officeAddr: 'Engelburg SG', author: '', projNrPrefix: '' }, await Store.getSetting('office', {}));
      this.catalog = await Store.all('catalog');
      if (!this.catalog.length) { for (const c of Catalog.SEED) await Store.put('catalog', c); this.catalog = await Store.all('catalog'); }
      this.projects = (await Store.all('projects')).sort((a, b) => b.updated.localeCompare(a.updated));
      this.dirHandle = await Store.getSetting('dirHandle', null);
      Store.persist();
      if (this.dirHandle && this.dirHandle.queryPermission && (await this.dirHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = 'Ordner-Sync aktivieren'; b.onclick = async () => { if ((await this.dirHandle.requestPermission({ mode: 'readwrite' })) === 'granted') { b.remove(); this.syncToFolder(); } }; $('#save-state').after(b);
      }
      const last = await Store.getSetting('lastProject', null);
      if (last && this.projects.find(p => p.id === last)) await this.open(last, false);
      $('#btn-projects').onclick = () => this.go('projects');
      this.renderNav(); this.go(this.project ? (await Store.getSetting('lastStep', 'parcel')) : 'projects');
      window.addEventListener('beforeunload', e => { if (this.dirty) { this.saveNow(); } });
    },

    /* ---------- Speicher ---------- */
    markDirty() {
      if (!this.project) return; this.dirty = true; $('#save-state').classList.add('dirty'); $('#save-state span').textContent = 'ungespeichert';
      clearTimeout(this._st); this._st = setTimeout(() => this.saveNow(), 700);
    },
    async saveNow() {
      if (!this.project) return; this.project.updated = new Date().toISOString();
      await Store.put('projects', this.project);
      this.dirty = false; $('#save-state').classList.remove('dirty'); $('#save-state span').textContent = 'gespeichert ' + new Date().toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
      const i = this.projects.findIndex(p => p.id === this.project.id); if (i >= 0) this.projects[i] = this.project; else this.projects.unshift(this.project);
      clearTimeout(this._sync); this._sync = setTimeout(() => this.syncToFolder(), 4000);
    },
    async syncToFolder() {
      const h = this.dirHandle; if (!h || !h.queryPermission) return;
      try {
        if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted') return;
        const name = `${Exporter.safeName(this.project.name)}__${this.project.id}.baucockpit.json`;
        const fh = await h.getFileHandle(name, { create: true }); const w = await fh.createWritable();
        await w.write(JSON.stringify(this.project)); await w.close();
      } catch (e) { console.warn('Ordner-Sync', e); }
    },
    async open(id, nav = true) {
      if (this.dirty) await this.saveNow();
      const p = await Store.get('projects', id); if (!p) return;
      this.project = this.migrate(p); Store.setSetting('lastProject', id);
      $('#proj-name').textContent = p.name; this.renderNav(); if (nav) this.go('parcel');
    },
    migrate(p) {
      const d = newProject(this.settings);
      for (const k of Object.keys(d)) if (p[k] === undefined) p[k] = d[k];
      p.costs = Object.assign(Engine.defaultCostParams(), p.costs); return p;
    },
    async create() { const p = newProject(this.settings); this.project = p; await this.saveNow(); await this.open(p.id); },
    get catalogMap() { return Object.fromEntries(this.catalog.map(c => [c.id, c])); },

    /* ---------- Navigation ---------- */
    renderNav() {
      const p = this.project; const done = {
        parcel: p && p.parcel.polygon.length > 2, rules: p && p.parcel.polygon.length > 2 && p.rulesConfirmed, variants: p && !!p.activeVariant,
        plan: p && p.plan.rooms.length > 0, v3d: p && p.images.length > 0, media: p && p.selections.length > 0, costs: false
      };
      $('#nav').innerHTML = `
        <button data-go="projects" class="${this.step === 'projects' ? 'on' : ''}"><span class="num">≡</span>Projekte</button>
        <div class="grp">Ablauf</div>
        ${STEPS.map(s => `<button data-go="${s.key}" class="${this.step === s.key ? 'on' : ''} ${done[s.key] ? 'done' : ''}" ${p ? '' : 'disabled'}><span class="num">${done[s.key] ? '✓' : s.n}</span>${s.name}</button>`).join('')}
        <div class="grp">Verwaltung</div>
        <button data-go="catalog" class="${this.step === 'catalog' ? 'on' : ''}"><span class="num">◫</span>Katalog verwalten</button>
        <button data-go="settings" class="${this.step === 'settings' ? 'on' : ''}"><span class="num">⚙</span>Einstellungen & Daten</button>
        <div class="foot">Daten bleiben lokal auf diesem Gerät (Browser-Speicher${this.dirHandle ? ' + Projektordner' : ''}).<br>Geodaten: geo.admin.ch</div>`;
      $$('#nav [data-go]').forEach(b => b.onclick = () => this.go(b.dataset.go));
    },
    go(step) {
      if (step !== 'projects' && step !== 'settings' && step !== 'catalog' && !this.project) step = 'projects';
      if (this.v3 && this.v3.walkMode) this.v3.setWalk(false);
      this.step = step; Store.setSetting('lastStep', step); this.renderNav();
      const main = $('#main'); main.innerHTML = ''; main.scrollTop = 0;
      const fn = { projects: this.pProjects, parcel: this.pParcel, rules: this.pRules, variants: this.pVariants, plan: this.pPlan, v3d: this.p3D, media: this.pMedia, costs: this.pCosts, settings: this.pSettings, catalog: this.pCatalog }[step];
      fn.call(this, main);
    },
    toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(this._tt); this._tt = setTimeout(() => t.classList.remove('show'), ms); },
    dialog(title, bodyHtml, buttons) {
      return new Promise(res => {
        const d = $('#dlg'); $('#dlg-h').textContent = title; $('#dlg-b').innerHTML = bodyHtml;
        $('#dlg-f').innerHTML = buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : ''}" value="${i}">${esc(b.label)}</button>`).join('');
        d.onclose = () => { const i = Number(d.returnValue); const vals = {}; $$('#dlg-b [name]').forEach(el => vals[el.name] = el.type === 'checkbox' ? el.checked : el.value); res({ i: isNaN(i) ? -1 : i, vals }); };
        d.returnValue = ''; d.showModal();
      });
    },
    bind(root, onChange) {
      $$('[data-k]', root).forEach(el => {
        const path = el.dataset.k.split('.'); const type = el.dataset.t || (el.type === 'number' ? 'num' : 'text');
        let o = this.project; for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
        const key = path[path.length - 1]; const v = o[key];
        if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : v;
        el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
          let val = el.type === 'checkbox' ? el.checked : el.value;
          if (type === 'num') val = val === '' ? null : Number(val);
          o[key] = val; this.markDirty(); if (el.dataset.k === 'name') $('#proj-name').textContent = val; onChange && onChange(el.dataset.k, val);
        });
      });
    },

    /* =============== Projekte =============== */
    pProjects(main) {
      main.innerHTML = `<div class="page">
        <div class="row between"><div><h1>Projekte</h1><p class="lead">Jedes Projekt führt von der Parzelle über Baurecht, Varianten, Grundriss und 3D bis zur Kosteneinschätzung und zum Baueingabe-Paket – alles auf derselben Geometrie, gespeichert auf diesem Gerät.</p></div>
        <div class="row"><button class="btn" id="imp">Projekt importieren…</button><button class="btn primary" id="new">+ Neues Projekt</button></div></div>
        ${this.projects.length ? `<div class="projects">${this.projects.map(p => `
          <div class="pcard" data-id="${p.id}"><h4>${esc(p.name)}</h4>
          <div class="small muted">${esc(p.meta.projNr || '')} ${p.parcel.number ? '· Parz. ' + esc(p.parcel.number) : ''} ${p.parcel.gemeinde ? '· ' + esc(p.parcel.gemeinde) : ''}</div>
          <div class="small muted">${esc(p.meta.client || '')}</div>
          <div class="row between" style="margin-top:10px"><span class="small muted">geändert ${new Date(p.updated).toLocaleString('de-CH')}</span>
          <span class="row"><button class="btn sm ghost" data-dup="${p.id}" title="Duplizieren">⧉</button><button class="btn sm ghost" data-del="${p.id}" title="Löschen">✕</button></span></div></div>`).join('')}</div>`
          : `<div class="empty">Noch keine Projekte. <br><br><button class="btn primary" id="new2">+ Erstes Projekt anlegen</button> &nbsp; <button class="btn" id="demo">Demo-Projekt laden</button></div>`}
      </div>`;
      const nb = () => this.create();
      $('#new').onclick = nb; $('#new2') && ($('#new2').onclick = nb);
      $('#demo') && ($('#demo').onclick = () => this.createDemo());
      $('#imp').onclick = () => this.importProjectFile();
      $$('.pcard').forEach(c => c.onclick = e => { if (e.target.closest('button')) return; this.open(c.dataset.id); });
      $$('[data-del]').forEach(b => b.onclick = async () => {
        const r = await this.dialog('Projekt löschen?', '<p>Das Projekt wird aus dem Speicher dieses Geräts entfernt. Exportierte Dateien bleiben erhalten.</p>', [{ label: 'Abbrechen' }, { label: 'Löschen', primary: true }]);
        if (r.i !== 1) return; await Store.del('projects', b.dataset.del); this.projects = this.projects.filter(p => p.id !== b.dataset.del);
        if (this.project && this.project.id === b.dataset.del) { this.project = null; $('#proj-name').textContent = '–'; } this.go('projects');
      });
      $$('[data-dup]').forEach(b => b.onclick = async () => { const p = JSON.parse(JSON.stringify(this.projects.find(x => x.id === b.dataset.dup))); p.id = uid('p'); p.name += ' (Kopie)'; p.updated = new Date().toISOString(); await Store.put('projects', p); this.projects.unshift(p); this.go('projects'); });
    },
    importProjectFile() {
      const i = document.createElement('input'); i.type = 'file'; i.accept = '.json'; i.onchange = async () => {
        try {
          const data = JSON.parse(await i.files[0].text());
          if (data.format === 'baucockpit-backup') { await Store.importAll(data); location.reload(); return; }
          if (!data.parcel || !data.id) throw new Error('Keine Baucockpit-Projektdatei');
          if (this.projects.find(p => p.id === data.id)) data.id = uid('p');
          await Store.put('projects', data); this.projects.unshift(data); await this.open(data.id);
          this.toast('Projekt importiert');
        } catch (e) { this.toast('Import fehlgeschlagen: ' + e.message); }
      }; i.click();
    },
    async createDemo() {
      const p = newProject(this.settings); p.name = 'Demo EFH Hanglage'; p.meta.projNr = '000.00'; p.meta.client = 'Familie Muster';
      const E0 = 2742860, N0 = 1258420;
      p.parcel = { polygon: G.ensureCCW([[E0, N0], [E0 + 34, N0 + 4], [E0 + 31, N0 + 30], [E0 - 3, N0 + 25]]), number: '9999', egrid: 'CH000000000000', gemeinde: 'Demo (synthetisch)', canton: 'SG', source: 'Demo – synthetische Parzelle, keine amtlichen Daten' };
      p.parcel.area = G.absArea(p.parcel.polygon);
      const n = 25, dx = 3.5, o = [E0 - 22, N0 - 22]; const hs = [];
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) hs.push(640 + j * dx * 0.14 + Math.sin(i * 0.3) * 0.4);
      p.terrain = { origin: o, dx, n, heights: hs, min: Math.min(...hs), max: Math.max(...hs), source: 'synthetisch' };
      this.project = p; await this.saveNow(); await this.open(p.id);
    },

    /* =============== 1 Parzelle =============== */
    pParcel(main) {
      const p = this.project;
      main.innerHTML = `<div class="page">
        <h1>1 · Parzelle</h1><p class="lead">Adresse oder Parzellennummer suchen (z. B. «Engelburg 1234» oder «Dorfstrasse 5 Uzwil») oder direkt in der Karte auf die Parzelle klicken. Grundstück, Zone und Gelände werden aus den amtlichen Geodaten des Bundes geladen.</p>
        <div class="grid g-side">
          <div class="stack">
            <div class="card stack">
              <h3>Projekt</h3>
              <div class="fields">
                <label class="f" style="grid-column:1/-1"><span>Projektname</span><input type="text" data-k="name"></label>
                <label class="f"><span>Projekt-Nr.</span><input type="text" data-k="meta.projNr" placeholder="691.01"></label>
                <label class="f"><span>Bauherrschaft</span><input type="text" data-k="meta.client"></label>
                <label class="f" style="grid-column:1/-1"><span>Adresse</span><input type="text" data-k="meta.address"></label>
              </div>
            </div>
            <div class="card stack">
              <h3>Parzelle suchen</h3>
              <div class="row"><input type="search" id="q" placeholder="Gemeinde + Parzellennr. oder Adresse" style="flex:1"><button class="btn primary" id="qs">Suchen</button></div>
              <div class="results" id="res" hidden></div>
              <div class="progress" id="prog" hidden><i></i></div>
              <div id="pinfo"></div>
              <details><summary class="small muted" style="cursor:pointer">Parzelle manuell erfassen (LV95-Koordinaten)</summary>
                <div class="stack" style="margin-top:8px"><textarea id="manual" placeholder="2742860.0, 1258420.0&#10;2742894.0, 1258424.0&#10;…"></textarea>
                <div class="row"><input type="number" id="manualH" placeholder="Terrainhöhe m ü.M. (falls offline)" style="flex:1"><button class="btn" id="manualOk">Übernehmen</button></div></div>
              </details>
            </div>
          </div>
          <div class="card" style="padding:8px"><div id="map"></div>
            <div class="row" style="padding:8px 4px 0"><span class="small muted">Hintergrund:</span>
            <button class="btn sm on" data-bg="pk">Landeskarte</button><button class="btn sm" data-bg="si">Luftbild</button>
            <label class="small"><input type="checkbox" id="lyZ" checked> Bauzonen</label><label class="small"><input type="checkbox" id="lyC" checked> Amtl. Vermessung</label></div></div>
        </div></div>`;
      this.bind(main);
      this.renderParcelInfo();
      // Karte
      const center = p.parcel.polygon.length ? lv95ToWgs(...G.centroid(p.parcel.polygon)) : [47.441, 9.341];
      const map = L.map('map', { zoomControl: true, maxZoom: 21 }).setView(center, p.parcel.polygon.length ? 19 : 14);
      const wmts = (layer, ext, opt = {}) => L.tileLayer(`https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/3857/{z}/{x}/{y}.${ext}`, Object.assign({ maxNativeZoom: 19, maxZoom: 21, attribution: '© swisstopo / geo.admin.ch' }, opt));
      const bgPk = wmts('ch.swisstopo.pixelkarte-farbe', 'jpeg', { maxNativeZoom: 18 }).addTo(map);
      const bgSi = wmts('ch.swisstopo.swissimage', 'jpeg', { maxNativeZoom: 20 });
      const lyZ = wmts('ch.are.bauzonen', 'png', { opacity: 0.45, maxNativeZoom: 18 }).addTo(map);
      const lyC = wmts('ch.kantone.cadastralwebmap-farbe', 'png', { maxNativeZoom: 20 }).addTo(map);
      $$('[data-bg]').forEach(b => b.onclick = () => { $$('[data-bg]').forEach(x => x.classList.toggle('on', x === b)); if (b.dataset.bg === 'si') { map.removeLayer(bgPk); bgSi.addTo(map).bringToBack(); } else { map.removeLayer(bgSi); bgPk.addTo(map).bringToBack(); } });
      $('#lyZ').onchange = e => e.target.checked ? lyZ.addTo(map) : map.removeLayer(lyZ);
      $('#lyC').onchange = e => e.target.checked ? lyC.addTo(map) : map.removeLayer(lyC);
      this._map = map; this.drawParcelOnMap();
      map.on('click', e => { const [E, N] = wgsToLv95(e.latlng.lat, e.latlng.lng); this.loadParcel(E, N); });
      setTimeout(() => map.invalidateSize(), 50);
      const doSearch = async () => {
        const q = $('#q').value.trim(); if (!q) return; const res = $('#res'); res.hidden = false; res.innerHTML = '<div class="small muted" style="padding:8px">Suche…</div>';
        try {
          const r = await GeoAdmin.search(q);
          res.innerHTML = r.length ? r.map((x, i) => `<button data-i="${i}">${esc(x.label)} <small>${x.origin === 'parcel' ? 'Parzelle' : x.origin === 'address' ? 'Adresse' : 'Gemeinde'}</small></button>`).join('') : '<div class="small muted" style="padding:8px">Keine Treffer</div>';
          $$('#res button').forEach(b => b.onclick = () => { const x = r[b.dataset.i]; res.hidden = true; map.setView([x.lat, x.lon], x.origin === 'gg25' ? 15 : 19); if (x.origin !== 'gg25') this.loadParcel(x.E, x.N); });
        } catch (e) { res.innerHTML = `<div class="note warn">Geodienst nicht erreichbar (${esc(e.message)}). Internetverbindung prüfen oder Parzelle manuell erfassen.</div>`; }
      };
      $('#qs').onclick = doSearch; $('#q').onkeydown = e => { if (e.key === 'Enter') doSearch(); };
      $('#manualOk').onclick = async () => {
        const pts = $('#manual').value.split(/\n/).map(l => l.split(/[,;\s]+/).filter(Boolean).map(Number)).filter(a => a.length >= 2 && !isNaN(a[0]) && !isNaN(a[1])).map(a => a[0] < a[1] ? [a[1], a[0]] : [a[0], a[1]]);
        if (pts.length < 3) return this.toast('Mindestens 3 Punkte (E, N) erfassen');
        p.parcel = { polygon: G.ensureCCW(pts), number: p.parcel.number || '', egrid: '', gemeinde: p.parcel.gemeinde || '', canton: 'SG', area: 0, source: 'Manuelle Erfassung' };
        p.parcel.area = G.absArea(p.parcel.polygon);
        const h = Number($('#manualH').value);
        if (h) { const bb = G.bbox(p.parcel.polygon); const n = 11; const dx = (Math.max(bb[2] - bb[0], bb[3] - bb[1]) + 40) / (n - 1); p.terrain = { origin: [bb[0] - 20, bb[1] - 20], dx, n, heights: Array(n * n).fill(h), min: h, max: h, source: 'manuell (eben)' }; }
        else await this.loadTerrain();
        this.afterParcel(); this.drawParcelOnMap(true);
      };
    },
    async loadParcel(E, N) {
      const p = this.project; const prog = $('#prog'); prog.hidden = false; prog.firstElementChild.style.width = '10%';
      try {
        const par = await GeoAdmin.parcelAt(E, N);
        prog.firstElementChild.style.width = '30%';
        const [zone, gem] = await Promise.all([GeoAdmin.zoneAt(...G.centroid(par.polygon)), GeoAdmin.gemeindeAt(E, N)]);
        p.parcel = { polygon: par.polygon, number: par.number, egrid: par.egrid, gemeinde: (gem && gem.name) || (zone && zone.gemeinde) || '', bfs: gem && gem.bfs, canton: par.canton || 'SG', area: G.absArea(par.polygon), zone, raw: par.raw, source: 'Amtliche Vermessung via geo.admin.ch', loaded: new Date().toISOString() };
        prog.firstElementChild.style.width = '40%';
        await this.loadPlanning(true);
        if (p.name === 'Neues Projekt') { p.name = `Parzelle ${par.number}${p.parcel.gemeinde ? ' ' + p.parcel.gemeinde : ''}`; $('#proj-name').textContent = p.name; const ni = $('[data-k="name"]'); if (ni) ni.value = p.name; }
        this.drawParcelOnMap(true); this.renderParcelInfo();
        await this.loadTerrain(f => prog.firstElementChild.style.width = (30 + f * 70) + '%');
        this.afterParcel();
      } catch (e) { this.toast('Parzelle konnte nicht geladen werden: ' + e.message, 4000); }
      prog.hidden = true;
    },
    /** Nutzungsplanung (Zone, Sondernutzungspläne, Baulinien) laden und Regeln ableiten */
    async loadPlanning(silent) {
      const p = this.project;
      try { p.planning = await GeoAdmin.planning(p.parcel.polygon); }
      catch (e) { p.planning = null; if (!silent) this.toast('Nutzungsplanung nicht erreichbar: ' + e.message, 4000); }
      if (!p.rulesConfirmed) { const keep = p.rules ? { floorHeight: p.rules.floorHeight, roofBuildup: p.rules.roofBuildup, hardscape: p.rules.hardscape } : {}; p.rules = Object.assign(Engine.rulesFromPlanning(p), keep); const own = this.matchOwnZone(); if (own) Object.assign(p.rules, own); }
      this.markDirty(); return p.planning;
    },
    /** eigene Zonenvorlage der Gemeinde (gleiche BFS-Nr. und Zonenbezeichnung) */
    matchOwnZone() {
      const p = this.project; const lab = (p.planning && p.planning.zone && p.planning.zone.label) || '';
      const z = (this.settings.zones || []).find(z => z.bfs && String(z.bfs) === String(p.parcel.bfs) && z.zoneLabel && z.zoneLabel === lab);
      if (!z) return null; const { key, name, bfs, zoneLabel, note, ...vals } = z; return Object.assign(vals, { zoneKey: key, zoneName: name, source: 'eigene Zonenvorlage (' + (z.note || 'gespeichert') + ')' });
    },
    planningHtml(compact) {
      const pl = this.project.planning;
      if (!pl) return `<div class="note warn small">Nutzungsplanung noch nicht geladen. <button class="btn sm" id="plLoad">Jetzt laden</button></div>`;
      const link = d => d.link ? `<a href="${esc(d.link)}" target="_blank">${esc(d.titel || 'Dokument')}</a>` : esc(d.titel || '');
      const z = pl.zone;
      const snp = pl.overlays.filter(o => o.snp), ov = pl.overlays.filter(o => !o.snp), bl = pl.lines;
      return `<table class="t">
        <tr><td class="muted">Zone (kommunal)</td><td><b>${esc(z ? z.label : '–')}</b> ${pl.system ? `<span class="chip ${pl.system === 'BauG' ? 'warn' : 'info'}">${pl.system === 'BauG' ? 'altes BauG' : 'PBG'}</span>` : ''}${z && z.share < 0.95 ? `<div class="small muted">Anteil ${fN(z.share * 100, 0)} % · weitere: ${esc(z.others.join(', '))}</div>` : ''}${!compact && z ? `<div class="small">${z.docs.map(link).join(' · ')}</div>` : ''}</td></tr>
        <tr><td class="muted">Sondernutzungsplan</td><td>${snp.length ? snp.map(o => `<span class="chip warn">${esc(o.label)}</span> ${compact ? '' : o.docs.map(link).join(' · ')}`).join('<br>') : '<span class="chip ok">keiner</span>'}</td></tr>
        <tr><td class="muted">Baulinien / Abstandslinien</td><td>${bl.length ? bl.map(l => `<span class="chip warn">${esc(l.typ || l.label || 'Linie')}</span>${!compact && l.note ? ` <span class="small muted">${esc(l.note)}</span>` : ''}`).join('<br>') : '<span class="chip ok">keine im Bereich</span>'}</td></tr>
        <tr><td class="muted">Überlagerungen</td><td>${ov.length ? ov.map(o => `<span class="chip info">${esc(o.label)}</span>${!compact ? ' ' + o.docs.map(link).join(' · ') : ''}`).join('<br>') : '–'}</td></tr>
      </table><div class="small muted" style="margin-top:4px">${esc(pl.source)}, geladen ${new Date(pl.loaded).toLocaleDateString('de-CH')}. Rechtsverbindlich ist der ÖREB-Auszug.</div>`;
    },
    async loadContext(onP) {
      const p = this.project; const c = G.centroid(p.parcel.polygon);
      const terrP = GeoAdmin.terrainGrid(p.parcel.polygon, 85, 41, f => onP && onP(f * 0.8)).catch(() => null);
      let sur = await GeoAdmin.surroundings(c, 120).catch(() => null); let src = 'Amtliche Vermessung + GWR (geodienste.ch, geo.admin.ch)';
      let buildings = [];
      if (sur && sur.buildings.length) buildings = sur.buildings.map(b => { const A = G.absArea(b.poly); const lv = b.floors || (A < 25 ? 1 : 2); const res = !b.kat || (b.kat >= 1020 && b.kat <= 1040); return { poly: b.poly, levels: lv, h: lv * 2.9 + (A < 25 ? 0.2 : 0.5), roof: res && A < 400 && A > 25 ? 'gable' : 'flat', year: b.year }; });
      else { const ox = await GeoAdmin.context(c, 120).catch(() => null); if (ox) { buildings = ox.buildings.map(b => ({ ...b, roof: b.roof === 'flat' ? 'flat' : (G.absArea(b.poly) < 400 ? 'gable' : 'flat') })); src = ox.buildings[0] ? ox.buildings[0].src : 'OSM'; } }
      const terrain = await terrP; onP && onP(1);
      if (!terrain && !buildings.length) throw new Error('keine Daten erhalten');
      p.context = { terrain, buildings, ground: sur ? sur.ground : [], box: sur ? sur.box : null, src, loaded: new Date().toISOString() };
      this.markDirty();
    },
    async loadTerrain(onP) {
      const p = this.project;
      try { p.terrain = await GeoAdmin.terrainGrid(p.parcel.polygon, 22, 25, onP); }
      catch (e) { this.toast('Geländedaten nicht verfügbar – ebenes Gelände angenommen'); const bb = G.bbox(p.parcel.polygon); p.terrain = { origin: [bb[0] - 22, bb[1] - 22], dx: (Math.max(bb[2] - bb[0], bb[3] - bb[1]) + 44) / 10, n: 11, heights: Array(121).fill(500), min: 500, max: 500, source: 'Annahme eben' }; }
    },
    afterParcel() {
      const p = this.project; p.variants = []; p.activeVariant = null; p.buildable = null; p.planFromVariant = null;
      this.markDirty(); this.renderParcelInfo(); this.renderNav(); this.toast('Parzelle übernommen');
    },
    drawParcelOnMap(fit) {
      const map = this._map; const p = this.project; if (!map) return;
      if (this._pl) map.removeLayer(this._pl);
      if (!p.parcel.polygon.length) return;
      this._pl = L.polygon(p.parcel.polygon.map(q => lv95ToWgs(q[0], q[1])), { color: '#b4532a', weight: 3, fillOpacity: 0.15 }).addTo(map);
      if (fit) map.fitBounds(this._pl.getBounds(), { maxZoom: 19, padding: [40, 40] });
    },
    renderParcelInfo() {
      const el = $('#pinfo'); if (!el) return; const p = this.project; const pa = p.parcel;
      if (!pa.polygon.length) { el.innerHTML = `<div class="empty small">Noch keine Parzelle gewählt.</div>`; return; }
      const sl = Geo.slopeOf(p.terrain, pa.polygon); const c = G.centroid(pa.polygon);
      el.innerHTML = `<div class="kpis">
          <div class="kpi"><b>${esc(pa.number || '–')}</b><span>Parzelle</span></div>
          <div class="kpi"><b>${fN(pa.area, 0)} m²</b><span>Fläche (aus Geometrie)</span></div>
          <div class="kpi"><b>${p.terrain ? fN(sl.pct, 1) + ' %' : '–'}</b><span>Gefälle (Mittel)</span></div>
          <div class="kpi"><b>${p.terrain ? fN(p.terrain.min, 0) + '–' + fN(p.terrain.max, 0) : '–'}</b><span>Höhe m ü.M. (Umgebung)</span></div>
        </div>
        <table class="t" style="margin-top:10px">
          <tr><td class="muted">Gemeinde</td><td>${esc(pa.gemeinde || '–')} ${pa.canton ? '(' + esc(pa.canton) + ')' : ''}</td></tr>
          <tr><td class="muted">EGRID</td><td class="mono">${esc(pa.egrid || '–')}</td></tr>
          <tr><td class="muted">Bauzone (Bund, harmonisiert)</td><td>${esc((pa.zone && pa.zone.label) || '–')}</td></tr>
          <tr><td class="muted">Schwerpunkt LV95</td><td class="mono">${fN(c[0], 1)} / ${fN(c[1], 1)}</td></tr>
          <tr><td class="muted">Quelle</td><td class="small">${esc(pa.source || '')}${p.terrain ? '<br>Gelände: ' + esc(p.terrain.source) : ''}</td></tr>
        </table>
        <h3 style="margin-top:12px">Nutzungsplanung</h3>${this.planningHtml(true)}
        <div class="row" style="margin-top:10px">
          ${pa.egrid ? `<a class="btn sm" target="_blank" href="${GeoAdmin.oerebUrl(pa.egrid)}">ÖREB-Kataster SG ↗</a>` : ''}
          <a class="btn sm" target="_blank" href="${GeoAdmin.mapUrl(c[0], c[1])}">map.geo.admin ↗</a>
          <button class="btn sm primary" id="toRules">Weiter: Baurecht →</button></div>`;
      $('#toRules').onclick = () => this.go('rules');
      $('#plLoad') && ($('#plLoad').onclick = async () => { await this.loadPlanning(); this.renderParcelInfo(); });
    },

    /* =============== 2 Baurecht =============== */
    pRules(main) {
      const p = this.project; const r = p.rules;
      if (!p.parcel.polygon.length) { main.innerHTML = `<div class="page"><div class="empty">Zuerst eine Parzelle wählen. <br><br><button class="btn primary" onclick="App.go('parcel')">Zur Parzelle</button></div></div>`; return; }
      const lib = Engine.MUNI[Number(p.parcel.bfs)];
      const opts = [
        ...(lib ? Object.entries(lib.zones).map(([k, z]) => ({ key: `${p.parcel.bfs}-${k}`, name: `${lib.name}: ${z.name}`, grp: `Baureglement ${lib.name}` })) : []),
        ...(this.settings.zones || []).map(z => ({ key: z.key, name: z.name, grp: 'Eigene Vorlagen' })),
        ...Engine.ZONES_BAUG.map(z => ({ key: z.key, name: z.name, grp: 'Muster altes BauG SG' })),
        ...Engine.ZONES_SG.map(z => ({ key: z.key, name: z.name, grp: 'Muster PBG SG' }))];
      const grps = [...new Set(opts.map(o => o.grp))];
      const bauG = r.system === 'BauG';
      const f = (k, l, st = 0.1, ph = '') => `<label class="f"><span>${l}</span><input type="number" step="${st}" data-k="rules.${k}" placeholder="${ph}"></label>`;
      main.innerHTML = `<div class="page">
        <h1>2 · Baurecht prüfen</h1><p class="lead">Zone und Rechtsgrundlage werden aus der kantonalen Nutzungsplanung gelesen. Sind die Werte des Baureglements der Gemeinde hinterlegt, werden sie übernommen, sonst gelten typische Werte (gekennzeichnet). Baulinien, Gewässerraum und Sondernutzungspläne fliessen in Baufeld und Prüfung ein.</p>
        <div class="grid g-side">
          <div class="card stack">
            <h3>Zone & Masse</h3>
            <label class="f"><span>Vorlage</span><select id="zsel"><option value="">– Vorlage wählen –</option>${grps.map(g => `<optgroup label="${esc(g)}">${opts.filter(o => o.grp === g).map(o => `<option value="${esc(o.key)}" ${o.key === r.zoneKey ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>
            <div class="note small ${/Muster|Annahme/.test(r.source || '') ? 'warn' : ''}"><b>Quelle:</b> ${esc(r.source || '–')}${r.sourceUrl ? ` · <a href="${esc(r.sourceUrl)}" target="_blank">Baureglement ↗</a>` : ''}</div>
            <div class="row"><span class="small muted">Rechtsgrundlage</span><button class="btn sm ${bauG ? '' : 'on'}" data-sys="PBG">PBG (neu)</button><button class="btn sm ${bauG ? 'on' : ''}" data-sys="BauG">BauG (alt)</button></div>
            <div class="fields">
              <label class="f" style="grid-column:1/-1"><span>Bezeichnung</span><input type="text" data-k="rules.zoneName"></label>
              ${f('vg', 'Vollgeschosse max.', 1)}
              ${bauG ? f('gaKlein', 'Grenzabstand klein [m]') + f('gaGross', 'Grenzabstand gross [m]') + f('gbh', 'Gebäudehöhe [m]') + f('firsth', 'Firsthöhe [m]') + f('gl', 'Gebäudelänge [m]', 0.5) + f('az', 'Ausnützungsziffer', 0.01, 'keine')
                : f('ga', 'Grenzabstand [m]') + f('gh', 'Gesamthöhe [m]') + f('fh', 'Fassadenhöhe [m]') + f('gl', 'Gebäudelänge [m]', 0.5) + f('uez', 'Überbauungsziffer', 0.01, 'keine') + f('bmz', 'Baumassenziffer', 0.1, 'keine') + f('gfz', 'Grünflächenziffer min.', 0.01, 'keine')}
            </div>
            ${bauG ? `<div class="small muted">Mehrlängenzuschlag: ab ${r.mlz ? r.mlz.from : 20} m je ${r.mlz ? r.mlz.f : 0.25} m, max. ${r.mlz ? r.mlz.max : 6} m auf den Grenzabstand. Grosser Grenzabstand auf der Hauptwohnseite (Garten-/Talseite).</div>` : ''}
            <details><summary class="small muted" style="cursor:pointer">Annahmen Volumen & Terrain</summary>
              <div class="fields" style="margin-top:8px">
                ${f('floorHeight', 'Geschosshöhe [m]', 0.05)}${f('sockel', 'Sockel über Terrain [m]', 0.05)}${f('roofBuildup', 'Dachaufbau [m]', 0.05)}
                ${f('abgrabMax', 'Abgrabung max. [m]')}${f('aufschMax', 'Aufschüttung max. [m]')}
                <label class="f"><span>Hartflächen [m²]</span><input type="number" step="1" data-k="rules.hardscape" placeholder="auto"></label>
              </div></details>
            <label class="small row"><input type="checkbox" data-k="rulesConfirmed"> Werte mit Baureglement der Gemeinde abgeglichen (nicht mehr automatisch überschreiben)</label>
            <div class="row"><button class="btn sm" id="saveZone">Als Vorlage für ${esc(p.parcel.gemeinde || 'Gemeinde')} speichern</button>${p.parcel.egrid ? `<a class="btn sm" target="_blank" href="${GeoAdmin.oerebUrl(p.parcel.egrid)}">ÖREB-Auszug ↗</a>` : ''}</div>
          </div>
          <div class="stack">
            <div class="card"><div class="row between"><h3 style="margin:0">Planungsinhalte auf der Parzelle</h3><button class="btn sm" id="plReload">Neu laden</button></div><div style="margin-top:8px">${this.planningHtml(false)}</div></div>
            <div class="card"><h3>Was ist auf dieser Parzelle möglich?</h3><div id="pot"></div></div>
            <div class="card"><h3>Baufeld</h3><canvas class="sitecv" id="bf" style="height:340px;cursor:default"></canvas>
              <div class="row small muted" style="margin-top:6px"><span style="color:#d0462f">━</span> Parzelle <span style="color:#2d6a8f">┅</span> Baufeld <span style="color:#b3261e">─ · ─</span> Baulinie <span style="color:#7a3fb0">┅</span> Sondernutzungsplan <span style="color:#2f7fb8">▒</span> Gewässerraum</div></div>
          </div>
        </div></div>`;
      const upd = () => { this.renderPotential(); this.drawSite($('#bf'), { buildableOnly: true }); this.renderNav(); };
      this.bind(main, upd);
      $('#zsel').onchange = e => {
        const k = e.target.value; if (!k) return; let z;
        if (lib && k.startsWith(p.parcel.bfs + '-')) { const zk = k.split('-').slice(1).join('-'); const lz = lib.zones[zk]; z = Object.assign(Engine.defaultRules('B-W2'), lz, { system: lib.system, zoneKey: k, zoneName: `${lib.name}: ${lz.name}`, ga: lz.gaKlein ?? lz.ga, gh: lz.firsth ?? lz.gh, fh: lz.gbh ?? lz.fh, mlz: lib.mlz || null, source: lib.source, sourceUrl: lib.url }); }
        else if ((this.settings.zones || []).some(x => x.key === k)) { const own = (this.settings.zones || []).find(x => x.key === k); const { key, name, bfs, zoneLabel, note, ...vals } = own; z = Object.assign({}, r, vals, { zoneKey: key, zoneName: name, source: 'eigene Vorlage' }); }
        else z = Engine.defaultRules(k);
        p.rules = Object.assign(z, { floorHeight: r.floorHeight, roofBuildup: r.roofBuildup, hardscape: r.hardscape }); p.variants = []; this.markDirty(); this.go('rules');
      };
      $$('[data-sys]').forEach(b => b.onclick = () => { const sys = b.dataset.sys; if (sys === r.system) return; const d = Engine.defaultRules(sys === 'BauG' ? 'B-W2' : 'W2'); p.rules = Object.assign(d, { zoneName: r.zoneName, vg: r.vg, gl: r.gl, floorHeight: r.floorHeight, roofBuildup: r.roofBuildup }); p.variants = []; this.markDirty(); this.go('rules'); });
      $('#plReload').onclick = async () => { await this.loadPlanning(); p.variants = []; this.go('rules'); };
      $('#plLoad') && ($('#plLoad').onclick = async () => { await this.loadPlanning(); this.go('rules'); });
      $('#saveZone').onclick = async () => {
        const res = await this.dialog('Zonenvorlage speichern', `<p class="small">Die Vorlage wird bei Parzellen in ${esc(p.parcel.gemeinde || 'dieser Gemeinde')} mit gleicher Zonenbezeichnung automatisch angewendet.</p><label class="f"><span>Name</span><input type="text" name="n" value="${esc((p.parcel.gemeinde ? p.parcel.gemeinde + ': ' : '') + r.zoneName)}"></label><label class="f" style="margin-top:8px"><span>Quelle / Bemerkung</span><input type="text" name="q" value="Baureglement ${esc(p.parcel.gemeinde || '')}"></label>`, [{ label: 'Abbrechen' }, { label: 'Speichern', primary: true }]);
        if (res.i !== 1) return;
        const keys = ['system', 'vg', 'gl', 'ga', 'gh', 'fh', 'uez', 'bmz', 'gfz', 'gaKlein', 'gaGross', 'gbh', 'firsth', 'az', 'mlz', 'abgrabMax', 'aufschMax'];
        const z = { key: 'u' + Date.now().toString(36), name: res.vals.n, note: res.vals.q, bfs: p.parcel.bfs, zoneLabel: (p.planning && p.planning.zone && p.planning.zone.label) || '' }; keys.forEach(k => z[k] = r[k]);
        this.settings.zones = (this.settings.zones || []).concat(z); await Store.setSetting('office', this.settings); r.zoneKey = z.key; r.source = 'eigene Vorlage (' + res.vals.q + ')'; this.markDirty(); this.toast('Vorlage gespeichert'); this.go('rules');
      };
      requestAnimationFrame(upd);
    },
    renderPotential() {
      const p = this.project, r = p.rules; const A = p.parcel.area || G.absArea(p.parcel.polygon);
      const bf = Engine.buildableArea(p, 0); p.buildable = bf || null;
      const bfA = bf ? G.absArea(bf) : 0; const sl = Geo.slopeOf(p.terrain, p.parcel.polygon);
      const hLim = r.system === 'BauG' ? r.gbh : r.gh;
      const floorsH = Math.max(1, Math.floor((hLim - r.sockel - r.roofBuildup) / r.floorHeight + 1e-6)); const floors = Math.min(r.vg || 9, floorsH);
      const maxFpU = r.uez != null ? r.uez * A : bfA; const maxV = r.bmz != null ? r.bmz * A : null;
      const maxFpAZ = r.system === 'BauG' && r.az ? r.az * A / (floors * 0.9) : Infinity;
      const maxFp = Math.min(bfA, maxFpU, maxFpAZ, maxV ? maxV / (floors * r.floorHeight + r.roofBuildup + r.sockel) : Infinity);
      const gfMax = maxFp * floors;
      const npH = p.terrain ? Geo.terrainAt(p.terrain, ...G.centroid(p.parcel.polygon)) : null;
      $('#pot').innerHTML = `<div class="kpis">
        <div class="kpi"><b>${fN(bfA, 0)} m²</b><span>Baufeld nach Grenzabständen${p.planning && p.planning.lines.length ? ' und Baulinien' : ''}</span></div>
        ${r.system === 'BauG' && r.az ? `<div class="kpi"><b>${fN(r.az * A, 0)} m²</b><span>anrechenbare Geschossfläche max. (AZ ${fN(r.az, 2)})</span></div>` : ''}
        <div class="kpi"><b>${fN(maxFp, 0)} m²</b><span>max. Gebäudegrundfläche${r.uez != null ? ' (ÜZ ' + fN(r.uez * 100, 0) + ' %)' : ''}</span></div>
        <div class="kpi"><b>${floors}</b><span>Geschosse (Höhe / Zone)</span></div>
        <div class="kpi"><b>≈ ${fN(gfMax, 0)} m²</b><span>Geschossfläche theoretisch</span></div>
        ${maxV ? `<div class="kpi"><b>${fN(maxV, 0)} m³</b><span>Baumasse max. (BMZ)</span></div>` : ''}
        <div class="kpi"><b>${npH ? fN(npH + r.gh, 1) : '–'}</b><span>höchster Punkt m ü.M. (bei NP im Schwerpunkt)</span></div>
      </div>
      <p class="small" style="margin:10px 0 0">${sl.pct > 10 ? `<span class="chip warn">Hanglage ${fN(sl.pct, 1)} %</span> Fassadenhöhe talseits wird massgebend; Staffel- oder Terrassenhaus prüfen. ` : sl.pct > 4 ? `<span class="chip info">leichte Neigung ${fN(sl.pct, 1)} %</span> ` : `<span class="chip ok">eben</span> `}
      ${!bf ? '<span class="chip fail">Kein Baufeld – Grenzabstand zu gross für Parzelle</span>' : ''}</p>`;
    },
    /** 2D-Situation (Parzelle, Baufeld, Variante) */
    drawSite(cv, { buildableOnly, variant, interactive } = {}) {
      if (!cv) return; const p = this.project; const dpr = window.devicePixelRatio || 1;
      const W = cv.clientWidth, H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr; const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
      const poly = p.parcel.polygon; const bb = G.bbox(poly); const pad = 30;
      const s = Math.min((W - 2 * pad) / (bb[2] - bb[0]), (H - 2 * pad) / (bb[3] - bb[1]));
      const ox = W / 2 - (bb[0] + bb[2]) / 2 * s, oy = H / 2 + (bb[1] + bb[3]) / 2 * s;
      const T = q => [ox + q[0] * s, oy - q[1] * s]; cv._T = { s, ox, oy };
      const path = pl => { ctx.beginPath(); pl.forEach((q, i) => { const t = T(q); i ? ctx.lineTo(t[0], t[1]) : ctx.moveTo(t[0], t[1]); }); ctx.closePath(); };
      ctx.fillStyle = '#fbfaf7'; ctx.fillRect(0, 0, W, H);
      // Höhenlinien
      if (p.terrain && p.terrain.max - p.terrain.min > 0.5) {
        const t = p.terrain; ctx.strokeStyle = 'rgba(120,140,90,.35)'; ctx.lineWidth = 1;
        const step = (t.max - t.min) > 15 ? 2 : (t.max - t.min) > 6 ? 1 : 0.5;
        for (let h = Math.ceil(t.min / step) * step; h < t.max; h += step) {
          for (let j = 0; j < t.n - 1; j++) for (let i = 0; i < t.n - 1; i++) {
            const pts = []; const cs = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
            for (let k = 0; k < 4; k++) { const [a1, b1] = cs[k], [a2, b2] = cs[(k + 1) % 4]; const h1 = t.heights[b1 * t.n + a1], h2 = t.heights[b2 * t.n + a2]; if ((h1 - h) * (h2 - h) < 0) { const f = (h - h1) / (h2 - h1); pts.push([t.origin[0] + (a1 + (a2 - a1) * f) * t.dx, t.origin[1] + (b1 + (b2 - b1) * f) * t.dx]); } }
            if (pts.length >= 2) { const A = T(pts[0]), B = T(pts[1]); ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke(); }
          }
        }
      }
      path(poly); ctx.fillStyle = 'rgba(180,83,42,.05)'; ctx.fill(); ctx.strokeStyle = '#d0462f'; ctx.lineWidth = 2.2; ctx.stroke();
      const bf = p.buildable || Engine.buildableArea(p, 0);
      // Planungsinhalte: Sondernutzungspläne, Gewässerraum, Baulinien
      const pln = p.planning;
      if (pln) {
        for (const o of pln.overlays || []) for (const rg of o.rings || []) { path(rg.map(q => [q[0], q[1]])); if (o.snp) { ctx.setLineDash([3, 3]); ctx.strokeStyle = '#7a3fb0'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]); } else if (/gewässer|gewaesser/i.test(o.label + o.typ)) { ctx.fillStyle = 'rgba(47,127,184,.18)'; ctx.fill(); } }
        ctx.strokeStyle = '#b3261e'; ctx.lineWidth = 1.6;
        for (const l of pln.lines || []) { ctx.setLineDash([10, 3, 2, 3]); ctx.beginPath(); l.coords.forEach((q, i) => { const t = T(q); i ? ctx.lineTo(t[0], t[1]) : ctx.moveTo(t[0], t[1]); }); ctx.stroke(); ctx.setLineDash([]); }
      }
      if (bf) { path(bf); ctx.setLineDash([6, 4]); ctx.strokeStyle = '#2d6a8f'; ctx.lineWidth = 1.4; ctx.stroke(); ctx.setLineDash([]); }
      // Parzellenmasse
      ctx.font = '11px Segoe UI, system-ui'; ctx.fillStyle = '#6e6a62'; ctx.textAlign = 'center';
      for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; const m = T([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); ctx.fillText(fN(G.dist(a, b), 2), m[0], m[1] - 4); }
      if (variant) {
        const ai = Engine.accessEdge(p); { const a = T(poly[ai]), b = T(poly[(ai + 1) % poly.length]); ctx.strokeStyle = '#1f2321'; ctx.lineWidth = 5; ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.globalAlpha = 1; }
        for (const e of (p.site && p.site.extras) || []) { path(e.poly); ctx.fillStyle = e.type === 'zufahrt' || e.type === 'pp2' ? 'rgba(120,115,105,.35)' : 'rgba(80,80,80,.45)'; ctx.fill(); ctx.strokeStyle = '#555'; ctx.lineWidth = 1; ctx.stroke(); if (e.type !== 'zufahrt') { const c = T(G.centroid(e.poly)); ctx.fillStyle = '#1f2321'; ctx.font = '600 10px Segoe UI'; ctx.fillText(e.name, c[0], c[1] + 3); } }
        for (const part of variant.parts) { path(part.poly); ctx.fillStyle = variant.ok ? 'rgba(47,125,79,.28)' : 'rgba(179,38,30,.25)'; ctx.fill(); ctx.strokeStyle = '#1f2321'; ctx.lineWidth = 1.6; ctx.stroke(); }
        const m = variant.metrics;
        if (m) for (const e of m.edges) if (e.p) {
          const A = T(e.p), B = T(e.q); ctx.strokeStyle = e.d < p.rules.ga - 0.05 ? '#b3261e' : '#2d6a8f'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
          ctx.fillStyle = ctx.strokeStyle; ctx.font = '600 11px Segoe UI'; ctx.fillText(fN(e.d, 2), (A[0] + B[0]) / 2, (A[1] + B[1]) / 2 - 3);
        }
      }
      // Nordpfeil
      ctx.fillStyle = '#1f2321'; ctx.beginPath(); ctx.moveTo(W - 24, 14); ctx.lineTo(W - 18, 32); ctx.lineTo(W - 24, 28); ctx.lineTo(W - 30, 32); ctx.closePath(); ctx.fill(); ctx.font = '700 10px Segoe UI'; ctx.fillText('N', W - 24, 46);
      // Massstab
      const m10 = 10 * s; ctx.fillRect(14, H - 18, m10, 3); ctx.font = '10px Segoe UI'; ctx.textAlign = 'left'; ctx.fillText('10 m', 14, H - 22);
    },

    /* =============== 3 Varianten =============== */
    pVariants(main) {
      const p = this.project;
      if (!p.parcel.polygon.length) { main.innerHTML = `<div class="page"><div class="empty">Zuerst eine Parzelle wählen.</div></div>`; return; }
      main.innerHTML = `<div class="page">
        <div class="row between"><div><h1>3 · Varianten im Gelände</h1><p class="lead">Regelkonforme Baukörper werden automatisch ins Baufeld gesetzt und gegen die Zonenvorschriften geprüft. Die aktive Variante lässt sich im Lageplan verschieben und drehen – die Prüfung läuft live mit.</p></div>
        <div class="row"><label class="f" style="width:130px"><span>Geschosse max.</span><input type="number" min="1" max="8" id="mf" value="${p.genOpts.maxFloors || ''}" placeholder="auto"></label><button class="btn primary" id="gen">${p.variants.length ? 'Neu generieren' : 'Varianten generieren'}</button></div></div>
        <div class="card" id="typo" style="margin-bottom:14px"></div>
        <div id="vlist"></div>
        <div class="grid g2" style="margin-top:16px" id="vdetail"></div></div>`;
      this.renderTypology();
      $('#gen').onclick = () => {
        p.genOpts.maxFloors = Number($('#mf').value) || null;
        const res = Engine.generateVariants(p, { maxFloors: p.genOpts.maxFloors });
        p.buildable = res.buildable; p.variants = res.variants; p.activeVariant = res.variants.find(v => v.ok)?.id || (res.variants[0] && res.variants[0].id) || null;
        const av = p.variants.find(x => x.id === p.activeVariant); if (av) { Engine.computeExtras(p, av); Engine.evaluate(av, p); } p.planFromVariant = null;
        if (!res.variants.length) this.toast(res.msg || 'Keine Variante passt ins Baufeld');
        this.markDirty(); this.renderVariants(); this.renderNav();
      };
      if (!p.variants.length) $('#gen').click(); else this.renderVariants();
    },
    edgeLabel(i) {
      const pc = this.project.parcel.polygon; const a = pc[i], b = pc[(i + 1) % pc.length];
      const ang = Math.atan2(-(b[0] - a[0]), (b[1] - a[1])); // Aussennormale (CCW)
      const dirs = ['O', 'NO', 'N', 'NW', 'W', 'SW', 'S', 'SO']; const k = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
      return `Seite ${i + 1} · ${dirs[k]} · ${fN(G.dist(a, b), 1)} m`;
    },
    renderTypology() {
      const p = this.project; const t = Object.assign({ ug: false, roof: 'flach', pitch: 30, kn: 1.0 }, p.typology || {}); p.site = p.site || { parking: 'none' };
      const ae = Engine.accessEdge(p);
      $('#typo').innerHTML = `<div class="row between"><h3 style="margin:0">Typologie & Parkierung <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">– gilt für alle Varianten</span></h3>
        <label class="small">Grösse <select id="ty_size" style="width:auto">${[['programm', 'nach Raumprogramm'], ['max', 'maximal ausnützen']].map(([k, n]) => `<option value="${k}" ${(p.sizeMode || 'programm') === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>
        <div class="fields" style="margin-top:10px">
          <label class="f"><span>Nutzung / Gebäudetyp</span><select id="ty_use">${[['efh', 'Einfamilienhaus (EFH)'], ['mfh', 'Mehrfamilienhaus (MFH)'], ['gewerbe', 'Gewerbe / Industrie']].map(([k, n]) => `<option value="${k}" ${(t.use || 'efh') === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="f"><span>Untergeschoss</span><select id="ty_ug"><option value="0">ohne UG</option><option value="1" ${t.ug ? 'selected' : ''}>mit UG (im Terrain)</option></select></label>
          <label class="f"><span>Dachform</span><select id="ty_roof">${Object.entries(Engine.ROOFS).map(([k, n]) => `<option value="${k}" ${t.roof === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          ${t.roof === 'sattel' || t.roof === 'pult' ? `<label class="f"><span>Neigung [°]</span><input type="number" id="ty_pitch" value="${t.pitch}" step="1" min="5" max="50"></label><label class="f"><span>Kniestock [m]</span><input type="number" id="ty_kn" value="${t.kn}" step="0.1" min="0" max="2"></label>` : ''}
          <label class="f"><span>Parkierung</span><select id="ty_park">${Object.entries(Engine.PARKING).map(([k, n]) => `<option value="${k}" ${p.site.parking === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="f"><span>Erschliessung (Strasse)</span><select id="ty_edge">${p.parcel.polygon.map((_, i) => `<option value="${i}" ${i === ae ? 'selected' : ''}>${this.edgeLabel(i)}</option>`).join('')}</select></label>
        </div>`;
      const apply = (regen) => {
        p.typology = { use: $('#ty_use').value, ug: $('#ty_ug').value === '1', roof: $('#ty_roof').value, pitch: Number(($('#ty_pitch') || {}).value) || (($('#ty_roof').value === 'pult') ? 12 : 30), kn: Number(($('#ty_kn') || {}).value) || 1.0 };
        p.site.parking = $('#ty_park').value; p.site.accessEdge = Number($('#ty_edge').value); p.sizeMode = $('#ty_size').value;
        if (regen) { $('#gen').click(); }
        else { for (const v of p.variants) Engine.applyTypology(v, p, p.typology); const av = p.variants.find(x => x.id === p.activeVariant); if (av) { Engine.computeExtras(p, av); Engine.evaluate(av, p); } this.renderVariants(); }
        p.planFromVariant = null; this.markDirty(); this.renderTypology();
      };
      ['#ty_use', '#ty_ug', '#ty_roof', '#ty_pitch', '#ty_kn', '#ty_park', '#ty_edge'].forEach(id => { const el = $(id); if (el) el.onchange = () => apply(['#ty_park', '#ty_ug', '#ty_use', '#ty_edge'].includes(id)); });
      $('#ty_size').onchange = () => apply(true);
    },
    variantSvg(v) {
      const p = this.project; const bb = G.bbox(p.parcel.polygon); const pad = 2; const w = bb[2] - bb[0] + 2 * pad, h = bb[3] - bb[1] + 2 * pad;
      const P = poly => poly.map(q => `${(q[0] - bb[0] + pad).toFixed(2)},${(bb[3] - q[1] + pad).toFixed(2)}`).join(' ');
      const sw = Math.max(w, h) / 160;
      return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet"><polygon points="${P(p.parcel.polygon)}" fill="rgba(180,83,42,.06)" stroke="#d0462f" stroke-width="${sw * 1.6}"/>
        ${p.buildable ? `<polygon points="${P(p.buildable)}" fill="none" stroke="#2d6a8f" stroke-width="${sw}" stroke-dasharray="${sw * 4} ${sw * 3}"/>` : ''}
        ${v.parts.map((pt, i) => `<polygon points="${P(pt.poly)}" fill="${v.ok ? 'rgba(47,125,79,' : 'rgba(179,38,30,'}${0.25 + i * 0.12})" stroke="#1f2321" stroke-width="${sw * 1.2}"/>`).join('')}</svg>`;
    },
    renderVariants() {
      const p = this.project;
      $('#vlist').innerHTML = p.variants.length ? `<div class="variants">${p.variants.map(v => {
        const m = v.metrics; const fails = v.checks.filter(c => c.status === 'fail').length;
        return `<div class="vcard ${v.id === p.activeVariant ? 'on' : ''}" data-id="${v.id}">${this.variantSvg(v)}
          <div class="vh"><span>${esc(v.name)}</span>${v.ok ? '<span class="chip ok">konform</span>' : `<span class="chip fail">${fails} Abweichung${fails > 1 ? 'en' : ''}</span>`}</div>
          <div class="small muted">${esc(v.desc)}</div>
          <dl><dt>Geschosse</dt><dd>${m.floors}</dd><dt>Grundfläche</dt><dd>${fN(m.footprintArea, 0)} m²</dd><dt>Geschossfläche</dt><dd>${fN(m.gf, 0)} m²</dd><dt>Gebäudevolumen</dt><dd>${fN(m.gv, 0)} m³</dd><dt>Gesamthöhe</dt><dd>${fN(m.gh, 2)} m</dd></dl></div>`;
      }).join('')}</div>` : `<div class="empty">Keine Varianten. Zonenwerte oder Geschosszahl prüfen.</div>`;
      $$('.vcard').forEach(c => c.onclick = () => { p.activeVariant = c.dataset.id; const av = p.variants.find(x => x.id === p.activeVariant); Engine.computeExtras(p, av); Engine.evaluate(av, p); this.markDirty(); this.renderVariants(); });
      const v = p.variants.find(x => x.id === p.activeVariant);
      const det = $('#vdetail'); if (!v) { det.innerHTML = ''; return; }
      det.innerHTML = `<div class="card"><div class="row between"><h3 style="margin:0">Lageplan – ${esc(v.name)}</h3>
          <div class="row"><button class="btn sm" data-rot="-15">⟲ 15°</button><button class="btn sm" data-rot="-1">⟲ 1°</button><button class="btn sm" data-rot="1">1° ⟳</button><button class="btn sm" data-rot="15">15° ⟳</button><button class="btn sm" data-rot="90">90°</button></div></div>
          <canvas class="sitecv" id="site" style="margin-top:8px"></canvas><div class="small muted" style="margin-top:6px">Ziehen zum Verschieben · Masse = Grenzabstände je Parzellenseite</div></div>
        <div class="card"><div class="row between"><h3 style="margin:0">Baurechtsprüfung</h3>
          <div class="row"><label class="small">Vollgeschosse <input type="number" id="nf" min="1" max="8" value="${Math.max(...v.parts.filter(x => !x.attika).map(x => x.nf))}" style="width:56px"></label></div></div>
          <table class="t" style="margin-top:8px"><tr><th>Kriterium</th><th class="r">Projekt</th><th class="r">zulässig</th><th></th></tr>
          ${v.checks.map(c => `<tr><td>${esc(c.label)}${c.info ? `<div class="small muted">${esc(c.info)}</div>` : ''}</td><td class="r">${fV(c.ist, c.fmt)}</td><td class="r">${c.soll == null ? '–' : fV(c.soll, c.fmt)}</td><td><span class="chip ${c.status}">${{ ok: 'erfüllt', fail: 'verletzt', warn: 'prüfen', info: 'info' }[c.status]}</span></td></tr>`).join('')}</table>
          <div class="kpis" style="margin-top:12px"><div class="kpi"><b>${fN(v.metrics.gf, 0)} m²</b><span>Geschossfläche GF</span></div><div class="kpi"><b>≈ ${fN(v.metrics.hnfEst, 0)} m²</b><span>Hauptnutzfläche (Schätzung)</span></div><div class="kpi"><b>${fN(v.parts[0].base, 2)}</b><span>OK EG m ü.M.</span></div></div>
          <div class="row" style="margin-top:12px"><button class="btn" id="to3d">Im 3D-Gelände ansehen</button><button class="btn primary" id="toPlan">Grundriss aus dieser Variante →</button></div></div>`;
      const cv = $('#site'); this.drawSite(cv, { variant: v });
      const re = () => { this.markDirty(); this.drawSite(cv, { variant: v }); this.renderVariantsLight(); };
      $$('[data-rot]').forEach(b => b.onclick = () => { Engine.transformVariant(v, p, 0, 0, Number(b.dataset.rot) * Math.PI / 180); this.renderVariants(); this.markDirty(); });
      let drag = null;
      cv.onmousedown = e => { drag = { x: e.offsetX, y: e.offsetY }; cv.style.cursor = 'grabbing'; };
      cv.onmousemove = e => { if (!drag) return; const s = cv._T.s; const dx = (e.offsetX - drag.x) / s, dy = -(e.offsetY - drag.y) / s; if (Math.hypot(dx, dy) < 0.1) return; Engine.transformVariant(v, p, dx, dy, 0); drag = { x: e.offsetX, y: e.offsetY }; re(); };
      cv.onmouseup = cv.onmouseleave = () => { if (drag) { drag = null; cv.style.cursor = 'grab'; this.renderVariants(); } };
      $('#nf').onchange = e => { const n = Math.max(1, Number(e.target.value)); if (v.type === 'terrasse') { this.toast('Terrassenhaus: Stufen über «Neu generieren» anpassen'); return; } v.parts.filter(x => !x.attika).forEach(x => x.nf = n); Engine.applyTypology(v, p, p.typology); p.planFromVariant = null; this.markDirty(); this.renderVariants(); };
      $('#to3d').onclick = () => this.go('v3d');
      $('#toPlan').onclick = async () => {
        if (p.plan.rooms.length && p.planFromVariant === v.id) { const r = await this.dialog('Grundriss ersetzen?', '<p>Für diese Variante existiert bereits ein Grundriss. Soll ein neuer Vorschlag erzeugt werden? Manuelle Änderungen gehen verloren.</p>', [{ label: 'Bestehenden öffnen' }, { label: 'Neuer Vorschlag', primary: true }]); if (r.i === 1) Layout.generate(p, { furnish: p.furnishMode || 'basis' }); }
        else Layout.generate(p, { furnish: p.furnishMode || 'basis' });
        this.markDirty(); this.go('plan');
      };
    },
    renderVariantsLight() { /* Live-Werte während Ziehen */ const v = this.project.variants.find(x => x.id === this.project.activeVariant); const card = $(`.vcard[data-id="${v.id}"] svg`); if (card) card.outerHTML = this.variantSvg(v); },

    /* =============== 4 Raumprogramm & Grundriss =============== */
    pPlan(main) {
      const p = this.project; const v = p.variants.find(x => x.id === p.activeVariant);
      if (v && p.planFromVariant !== v.id) { try { Layout.generate(p, { furnish: p.furnishMode || 'basis' }); } catch (e) { console.error(e); Plan.planFromVariant(p, v); } this.markDirty(); }
      main.innerHTML = `<div class="page full"><div class="editor">
        <aside><h2>Raumprogramm</h2><p class="small muted" style="margin-top:-4px">Soll-Flächen erfassen; Ist-Flächen kommen aus den gezeichneten Räumen (Abgleich über den Namen).</p>
          <table class="t prog" id="prog"></table>
          <div class="row" style="margin-top:8px"><button class="btn sm" id="addR">+ Raum</button><button class="btn sm" id="place" title="Räume als Rechtecke neben dem Gebäude ablegen, danach hineinschieben">Räume platzieren</button></div>
          <div id="psum" style="margin-top:14px"></div>
        </aside>
        <div class="canvas-wrap">
          <div class="toolbar" id="tb">
            ${[['select', 'Auswahl', 'V'], ['wall', 'Aussenwand', 'W'], ['iwall', 'Innenwand', 'I'], ['roomrect', 'Raum ▭', ''], ['room', 'Raum ⬠', 'M'], ['door', 'Tür', 'T'], ['window', 'Fenster', 'F'], ['furn', 'Möbel', 'P']].map(([k, n, s]) => `<button class="btn" data-tool="${k}" title="${n}${s ? ' (' + s + ')' : ''}">${n}</button>`).join('')}
            <span class="sep"></span><label class="small">Raster <select id="snap" style="width:auto;padding:3px 6px">${[0.01, 0.05, 0.1, 0.25, 0.5].map(s => `<option ${s === 0.05 ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
            <span class="sep"></span><button class="btn" id="fit">Einpassen</button>
            <span class="sep"></span><button class="btn" id="propose" ${v ? '' : 'disabled'} title="Räume, Wände, Türen, Fenster und Treppe neu vorschlagen">Grundrissvorschlag</button>
            <label class="small">Möblierung <select id="furn" style="width:auto;padding:3px 6px">${[['keine', 'keine'], ['basis', 'Basis'], ['komplett', 'Komplett']].map(([k, n]) => `<option value="${k}" ${(p.furnishMode || 'basis') === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          </div>
          <div class="tabs" id="ltabs"></div>
          <div class="cv-host"><canvas id="pcv"></canvas><div id="plan-status"></div></div>
        </div>
        <aside class="right" id="props"></aside>
      </div></div>`;
      if (this.ed) this.ed.destroy(); const ed = new Plan.PlanEditor($('#pcv'), this); this.ed = ed; ed.levelId = (p.plan.levels.find(l => Math.abs(l.z) < 0.01) || p.plan.levels[0]).id;
      this.setPlanTool = t => { ed.tool = t; ed.draft = null; $$('#tb [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); this.onPlanSelect(ed.sel); ed.draw(); };
      $$('#tb [data-tool]').forEach(b => b.onclick = () => this.setPlanTool(b.dataset.tool));
      $('#snap').onchange = e => { ed.snap = Number(e.target.value); };
      $('#fit').onclick = () => ed.fit();
      $('#propose').onclick = async () => { const r = await this.dialog('Neuen Grundrissvorschlag erzeugen?', '<p>Räume, Innenwände, Türen, Fenster, Treppen und Möblierung werden aus Variante, Typologie und Raumprogramm neu vorgeschlagen. Manuelle Änderungen gehen verloren.</p>', [{ label: 'Abbrechen' }, { label: 'Vorschlag erzeugen', primary: true }]); if (r.i !== 1) return; Layout.generate(p, { furnish: p.furnishMode || 'basis' }); this.markDirty(); this.go('plan'); };
      $('#furn').onchange = e => { p.furnishMode = e.target.value; Layout.furnish(p, p.furnishMode); this.markDirty(); ed.draw(); this.toast(p.furnishMode === 'keine' ? 'Möblierung entfernt (eigene Möbel bleiben)' : `Möblierung «${e.target.selectedOptions[0].text}» gesetzt`); };
      $('#addR').onclick = () => { p.program.push({ id: uid('r'), name: 'Neuer Raum', area: 10, level: ed.level.name, use: 'HNF' }); this.markDirty(); this.refreshPlanSide(); };
      $('#place').onclick = () => this.placeProgramRooms();
      this.renderLevelTabs(); this.setPlanTool('select'); this.refreshPlanSide(); this.onPlanSelect(null);
      requestAnimationFrame(() => { ed.resize(); ed.fit(); });
    },
    nextRoomName() {
      const p = this.project; const lv = this.ed.level.name; const used = new Set(p.plan.rooms.map(r => r.name));
      const cand = p.program.find(r => r.level === lv && !used.has(r.name)) || p.program.find(r => !used.has(r.name));
      return cand ? cand.name : 'Raum';
    },
    renderLevelTabs() {
      const p = this.project, ed = this.ed;
      $('#ltabs').innerHTML = p.plan.levels.slice().sort((a, b) => a.z - b.z).map(l => `<button class="tab ${l.id === ed.levelId ? 'on' : ''}" data-l="${l.id}">${esc(l.name)} <span class="muted small">${l.z >= 0 ? '+' : ''}${fN(l.z, 2)}</span></button>`).join('') + `<button class="tab" id="addL" title="Geschoss hinzufügen">+</button>`;
      $$('#ltabs [data-l]').forEach(b => b.onclick = () => { ed.levelId = b.dataset.l; ed.sel = null; this.onPlanSelect(null); this.renderLevelTabs(); ed.draw(); this.refreshPlanSide(); });
      $('#addL').onclick = () => { const top = p.plan.levels.reduce((a, b) => a.z > b.z ? a : b); const n = { id: uid('L'), name: top.z < 0 ? 'EG' : `${p.plan.levels.filter(l => l.z > 0).length + 1}. OG`, z: top.z + top.h, h: top.h, outline: top.outline }; p.plan.levels.push(n); ed.levelId = n.id; this.markDirty(); this.renderLevelTabs(); ed.draw(); };
    },
    refreshPlanSide() {
      const p = this.project; const rooms = p.plan.rooms; const levelOpts = [...new Set(p.plan.levels.map(l => l.name).concat(p.program.map(r => r.level)))];
      const act = name => rooms.filter(r => r.name === name).reduce((s, r) => s + G.absArea(r.poly), 0);
      $('#prog').innerHTML = `<tr><th>Raum</th><th class="r">Soll</th><th class="r">Ist</th><th>Geschoss</th><th></th></tr>` + p.program.map(r => {
        const a = act(r.name); const pct = r.area ? a / r.area : 0;
        return `<tr data-id="${r.id}"><td><input type="text" data-f="name" value="${esc(r.name)}"><div class="bar" style="margin-top:3px"><i class="${pct > 1.15 ? 'over' : ''}" style="width:${Math.min(100, pct * 100)}%"></i></div></td>
        <td class="r"><input type="number" data-f="area" value="${r.area}" step="0.5" style="width:58px"></td><td class="r small">${a ? fN(a, 1) : '–'}</td>
        <td><select data-f="level" style="width:74px">${levelOpts.map(o => `<option ${o === r.level ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></td><td><button class="btn sm ghost" data-x>✕</button></td></tr>`;
      }).join('');
      $$('#prog tr[data-id]').forEach(tr => {
        const r = p.program.find(x => x.id === tr.dataset.id);
        $$('[data-f]', tr).forEach(el => el.onchange = () => { const old = r.name; r[el.dataset.f] = el.type === 'number' ? Number(el.value) : el.value; if (el.dataset.f === 'name') p.plan.rooms.filter(x => x.name === old).forEach(x => x.name = el.value); this.markDirty(); this.refreshPlanSide(); this.ed.draw(); });
        $('[data-x]', tr).onclick = () => { p.program = p.program.filter(x => x !== r); this.markDirty(); this.refreshPlanSide(); };
      });
      const ar = Plan.areas(p); const soll = p.program.reduce((s, r) => s + r.area, 0);
      $('#psum').innerHTML = `<h3>Flächen SIA 416</h3><table class="t"><tr><th>Geschoss</th><th class="r">GF</th><th class="r">NGF</th><th class="r">HNF</th></tr>
        ${ar.map(a => `<tr><td>${esc(a.level.name)}</td><td class="r">${fN(a.gf, 1)}</td><td class="r">${fN(a.ngf, 1)}</td><td class="r">${fN(a.hnf, 1)}</td></tr>`).join('')}
        <tr class="sum"><td>Total</td><td class="r">${fN(ar.reduce((s, a) => s + a.gf, 0), 1)}</td><td class="r">${fN(ar.reduce((s, a) => s + a.ngf, 0), 1)}</td><td class="r">${fN(ar.reduce((s, a) => s + a.hnf, 0), 1)}</td></tr></table>
        <p class="small muted">Raumprogramm Soll: ${fN(soll, 1)} m²</p>`;
      this.renderNav();
    },
    placeProgramRooms() {
      const p = this.project, ed = this.ed; const lv = ed.level; const used = new Set(p.plan.rooms.map(r => r.name));
      const todo = p.program.filter(r => r.level === lv.name && !used.has(r.name)); if (!todo.length) return this.toast(`Alle Räume für ${lv.name} sind bereits gezeichnet`);
      const pts = (lv.outline || []).flat(); const bb = pts.length ? G.bbox(pts) : [0, 0, 10, 10];
      let x = bb[2] + 2, y = bb[3];
      for (const r of todo) { const w = Math.max(2, Math.round(Math.sqrt(r.area * 1.3) * 10) / 10), d = Math.round(r.area / w * 100) / 100; if (y - d < bb[1] - 12) { y = bb[3]; x += 8; } p.plan.rooms.push({ id: uid('rm'), level: lv.id, name: r.name, poly: G.ensureCCW([[x, y - d], [x + w, y - d], [x + w, y], [x, y]]), use: r.use }); y -= d + 0.6; }
      this.markDirty(); ed.fit(); this.refreshPlanSide(); this.toast(`${todo.length} Räume abgelegt – mit «Auswahl» ins Gebäude ziehen, Eckpunkte über die Eigenschaften anpassen`, 4500);
    },
    onPlanSelect(sel) {
      const el = $('#props'); if (!el) return; const ed = this.ed;
      const furnPal = `<h3>Möbel & Ausstattung</h3><div class="palette">${Object.entries(Plan.FURN).map(([k, f]) => `<button data-fu="${k}" class="${ed.furnType === k && ed.tool === 'furn' ? 'on' : ''}">${f.name}</button>`).join('')}</div>`;
      const help = `<div class="small muted" style="margin-top:14px;line-height:1.6"><b>Bedienung</b><br>Mausrad: Zoom · Rechte Maus/Alt: Verschieben<br>Shift: 45°-Fang beim Zeichnen<br>Wand: Klick-Klick-…, Esc beendet<br>Raum ⬠: Punkte klicken, Doppelklick schliesst<br>R: Möbel drehen · Entf: Löschen</div>`;
      if (!sel) { el.innerHTML = `<h2>Eigenschaften</h2><p class="small muted">Nichts ausgewählt.</p>${furnPal}${help}`; }
      else {
        const o = sel.obj; let f = '';
        if (sel.kind === 'wall') f = `<label class="f"><span>Stärke [m]</span><input type="number" step="0.01" data-p="t" value="${o.t}"></label><label class="small row"><input type="checkbox" data-p="ext" ${o.ext ? 'checked' : ''}> Aussenwand</label><div class="small muted">Länge ${fN(G.dist(o.a, o.b), 2)} m</div>`;
        if (sel.kind === 'room') f = `<label class="f"><span>Name</span><input type="text" data-p="name" value="${esc(o.name)}" list="rnames"></label><datalist id="rnames">${this.project.program.map(r => `<option value="${esc(r.name)}">`).join('')}</datalist>
          <label class="f"><span>Nutzung SIA 416</span><select data-p="use">${[['HNF', 'Hauptnutzfläche'], ['NNF', 'Nebennutzfläche'], ['VF', 'Verkehrsfläche'], ['FF', 'Funktionsfläche']].map(([k, n]) => `<option value="${k}" ${o.use === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <div class="kpi"><b>${fN(G.absArea(o.poly), 2)} m²</b><span>Fläche · Umfang ${fN(G.perimeter(o.poly), 2)} m</span></div>
          <h3 style="margin-top:8px">Eckpunkte</h3><textarea data-p="poly" style="min-height:90px">${o.poly.map(q => q.map(v => v.toFixed(2)).join(', ')).join('\n')}</textarea>`;
        if (sel.kind === 'opening') f = `<label class="f"><span>Typ</span><select data-p="type"><option value="door" ${o.type === 'door' ? 'selected' : ''}>Tür</option><option value="window" ${o.type === 'window' ? 'selected' : ''}>Fenster</option></select></label>
          <div class="fields"><label class="f"><span>Breite</span><input type="number" step="0.05" data-p="w" value="${o.w}"></label><label class="f"><span>Höhe</span><input type="number" step="0.05" data-p="h" value="${o.h}"></label><label class="f"><span>Brüstung</span><input type="number" step="0.05" data-p="sill" value="${o.sill}"></label></div>
          ${o.type === 'door' ? `<div class="row"><button class="btn sm" data-tg="flip">Aufschlag Seite</button><button class="btn sm" data-tg="hinge">Anschlag links/rechts</button></div>` : ''}`;
        if (sel.kind === 'furn') f = `<div class="kpi"><b>${esc(Plan.FURN[o.type].name)}</b><span>${Plan.FURN[o.type].w} × ${Plan.FURN[o.type].d} m</span></div><label class="f"><span>Drehung [°]</span><input type="number" step="15" data-p="rot" value="${o.rot || 0}"></label>`;
        el.innerHTML = `<h2>${{ wall: 'Wand', room: 'Raum', opening: o.type === 'door' ? 'Tür' : 'Fenster', furn: 'Möbel' }[sel.kind]}</h2><div class="stack">${f}<button class="btn sm" id="delSel">Löschen</button></div><hr style="border:0;border-top:1px solid var(--line);margin:14px 0">${furnPal}${help}`;
        $$('[data-p]', el).forEach(inp => inp.onchange = () => {
          const k = inp.dataset.p; let val = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value) : inp.value;
          if (k === 'poly') { const pts = val.split('\n').map(l => l.split(/[,;\s]+/).filter(Boolean).map(Number)).filter(a => a.length >= 2 && !a.some(isNaN)); if (pts.length < 3) return; val = G.ensureCCW(pts); }
          o[k] = val; ed.changed(); this.onPlanSelect(sel);
        });
        $$('[data-tg]', el).forEach(b => b.onclick = () => { o[b.dataset.tg] = !o[b.dataset.tg]; ed.changed(); });
        $('#delSel').onclick = () => ed.deleteSel();
      }
      $$('[data-fu]', el).forEach(b => b.onclick = () => { ed.furnType = b.dataset.fu; this.setPlanTool('furn'); });
    },

    /* =============== 5 3D =============== */
    ensure3D(container) {
      if (!this.v3) { this.v3 = new View3D(container, this); }
      else { container.appendChild(this.v3.renderer.domElement); this.v3.el = container; this.v3.ro.disconnect(); this.v3.ro.observe(container); this.v3.resize(); }
      this.v3.opts.styleKey = this.project.style || 'putz_holz'; return this.v3;
    },
    facadeColor() { const s = (this.project.selections || []).find(s => { const c = this.catalogMap[s.catalogId]; return c && c.category === 'Fassade' && c.color && s.status !== 'verworfen'; }); return s ? this.catalogMap[s.catalogId].color : null; },
    p3D(main) {
      const p = this.project;
      if (!p.parcel.polygon.length) { main.innerHTML = `<div class="page"><div class="empty">Zuerst eine Parzelle wählen.</div></div>`; return; }
      const levels = p.plan.levels.slice().sort((a, b) => a.z - b.z);
      main.innerHTML = `<div class="page full"><div class="v3d"><div class="vp" id="vp"><div class="hud" id="hud">Orbit: Linke Maus drehen · Rechte Maus verschieben · Rad zoomen</div></div>
        <aside>
          <div><h3>Ansicht</h3><div class="row"><button class="btn on" id="mOrbit">Umschauen</button><button class="btn" id="mWalk">Begehen</button></div>
            <p class="small muted">Begehen: WASD/Pfeile gehen, Maus schauen, Shift rennen, Bild↑/↓ Geschoss, Esc beendet.</p></div>
          <div><h3>Variante</h3><select id="vsel">${p.variants.map(v => `<option value="${v.id}" ${v.id === p.activeVariant ? 'selected' : ''}>${esc(v.name)}${v.ok ? '' : ' (nicht konform)'}</option>`).join('')}</select></div>
          <div><h3>Ebenen</h3><div class="stack small">
            <label><input type="checkbox" data-o="showTerrain" checked> Gelände</label><label><input type="checkbox" data-o="showOrtho" checked> Luftbild auf Gelände</label>
            <label><input type="checkbox" data-o="showMassing" checked> Volumen</label><label><input type="checkbox" data-o="showBuilding" checked> Gebäude aus Grundriss</label><label><input type="checkbox" data-o="showFurniture" checked> Möblierung</label></div>
            ${levels.length > 1 ? `<label class="f" style="margin-top:8px"><span>Geschosse bis</span><select id="cut">${levels.map((l, i) => `<option value="${i}" ${i === levels.length - 1 ? 'selected' : ''}>${esc(l.name)}${i < levels.length - 1 ? ' (aufgeschnitten)' : ''}</option>`).join('')}</select></label>` : ''}</div>
          <div><h3>Fassadenstil</h3><div class="swatches" style="margin-bottom:18px">${Object.entries(STYLES).map(([k, s]) => `<button data-st="${k}" class="${k === p.style ? 'on' : ''}" title="${s.name}" style="background:linear-gradient(135deg, ${s.wall} 55%, ${s.wall2} 55%)"><span>${s.name}</span></button>`).join('')}</div>${this.facadeColor() ? '<p class="small muted">Fassadenfarbe aus Katalogauswahl aktiv.</p>' : ''}</div>
          <div><h3>Sonnenstand</h3><label class="f"><span>Monat <b id="smv">${['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'][5]}</b></span><input type="range" min="1" max="12" value="6" id="sm"></label>
            <label class="f"><span>Uhrzeit <b id="shv">14:00</b></span><input type="range" min="6" max="20" step="0.25" value="14" id="sh"></label></div>
          <div><h3>Umgebung</h3><div class="stack small">
            <button class="btn" id="ctxLoad">${p.context ? 'Umgebung neu laden' : 'Umgebung laden (Gelände & Nachbargebäude)'}</button>
            ${p.context ? `<label><input type="checkbox" data-o="showContext" checked> Umgebung anzeigen</label><span class="muted">${(p.context.buildings || []).length} Gebäude · Gelände ${fN((p.context.terrain ? p.context.terrain.dx * (p.context.terrain.n - 1) : 0), 0)} m · ${esc(p.context.src || '')}</span>` : '<span class="muted">Lädt Gelände im Umkreis von ca. 100 m, Gebäude der amtlichen Vermessung mit Geschosszahl aus dem Gebäuderegister, Strassen und Gewässer.</span>'}
            <div class="progress" id="ctxProg" hidden><i></i></div></div></div>
          <div><h3>Bild & Export</h3><div class="stack"><button class="btn primary" id="shot">Bild aufnehmen (Galerie)</button>
            <div class="row"><button class="btn sm" data-ex="dae">DAE (Lumion)</button><button class="btn sm" data-ex="obj">OBJ</button><button class="btn sm" data-ex="glb">GLB</button></div>
            <p class="small muted">Export: Meter, Y oben, Ursprung = Parzellenschwerpunkt (LV95 ${fN(G.centroid(p.parcel.polygon)[0], 1)} / ${fN(G.centroid(p.parcel.polygon)[1], 1)}, Höhe ${p.terrain ? fN(p.terrain.min, 2) : '0'} m ü.M.).</p></div></div>
        </aside></div></div>`;
      const v3 = this.ensure3D($('#vp')); const rebuild = () => v3.build(this.project);
      v3.opts.cutLevel = 99; rebuild();
      this.onWalkChange = on => { $('#mWalk').classList.toggle('on', on); $('#mOrbit').classList.toggle('on', !on); $('#hud').textContent = on ? 'Begehen: WASD · Maus schauen · Shift rennen · Bild↑/↓ Geschoss · Esc beenden' : 'Orbit: Linke Maus drehen · Rechte Maus verschieben · Rad zoomen'; if (on && !$('.crosshair')) $('#vp').insertAdjacentHTML('beforeend', '<div class="crosshair"></div>'); if (!on && $('.crosshair')) $('.crosshair').remove(); };
      $('#ctxLoad').onclick = async () => {
        const btn = $('#ctxLoad'); btn.disabled = true; btn.textContent = 'Lade Umgebung…'; const pr = $('#ctxProg'); pr.hidden = false;
        try { await this.loadContext(f => pr.firstElementChild.style.width = (f * 100) + '%'); v3.resetCamera(); this.go('v3d'); this.toast(`Umgebung geladen: ${(p.context.buildings || []).length} Gebäude`); }
        catch (e) { this.toast('Umgebung nicht verfügbar: ' + e.message, 4000); btn.disabled = false; btn.textContent = 'Umgebung laden'; pr.hidden = true; }
      };
      $('#mWalk').onclick = () => v3.setWalk(true); $('#mOrbit').onclick = () => v3.setWalk(false);
      $('#vsel') && ($('#vsel').onchange = e => { p.activeVariant = e.target.value; this.markDirty(); if (p.planFromVariant && p.planFromVariant !== p.activeVariant) this.toast('Grundriss gehört zu einer anderen Variante – im Schritt 4 neu ableiten'); rebuild(); });
      $$('[data-o]').forEach(c => c.onchange = () => { v3.opts[c.dataset.o] = c.checked; rebuild(); });
      $('#cut') && ($('#cut').onchange = e => { v3.opts.cutLevel = Number(e.target.value); rebuild(); });
      $$('[data-st]').forEach(b => b.onclick = () => { p.style = b.dataset.st; v3.opts.styleKey = p.style; $$('[data-st]').forEach(x => x.classList.toggle('on', x === b)); this.markDirty(); rebuild(); });
      $('#sm').oninput = e => { v3.opts.sunMonth = Number(e.target.value); $('#smv').textContent = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'][v3.opts.sunMonth - 1]; v3._sun(); };
      $('#sh').oninput = e => { v3.opts.sunHour = Number(e.target.value); const h = Math.floor(v3.opts.sunHour), m = Math.round((v3.opts.sunHour - h) * 60); $('#shv').textContent = `${h}:${String(m).padStart(2, '0')}`; v3._sun(); };
      $('#shot').onclick = () => { const url = v3.screenshot(1920, 1080); p.images.push({ id: uid('img'), url, created: new Date().toISOString(), title: `${(p.variants.find(x => x.id === p.activeVariant) || {}).name || 'Ansicht'} – ${STYLES[p.style].name}` }); this.markDirty(); this.renderNav(); this.toast('Bild in Galerie gespeichert (Schritt 6)'); };
      $$('[data-ex]').forEach(b => b.onclick = async () => { const blob = await v3.exportScene(b.dataset.ex); Exporter.download(blob, `${Exporter.safeName(p.name)}_Modell.${b.dataset.ex}`); });
    },

    /* =============== 6 Bilder & Katalog =============== */
    pMedia(main) {
      const p = this.project;
      main.innerHTML = `<div class="page"><h1>6 · Bilder & Katalog</h1><p class="lead">Aufnahmen aus dem Modell, Vorlagen für fotorealistische Visualisierung (Lumion oder KI-Bildgenerator) und Material-/Produktentscheide der Bauherrschaft.</p>
        <div class="card"><div class="row between"><h2 style="margin:0">Galerie</h2><button class="btn sm" onclick="App.go('v3d')">Neue Aufnahme im 3D</button></div>
          <div style="margin-top:12px">${p.images.length ? `<div class="gallery">${p.images.map(im => `<figure><img src="${im.url}" alt=""><figcaption><span>${esc(im.title)}</span><span class="row"><button class="btn sm ghost" data-dl="${im.id}" title="Herunterladen">↓</button><button class="btn sm ghost" data-rm="${im.id}" title="Entfernen">✕</button></span></figcaption></figure>`).join('')}</div>` : '<div class="empty small">Noch keine Bilder. Im 3D eine Ansicht wählen und «Bild aufnehmen».</div>'}</div></div>
        <div class="grid g2" style="margin-top:16px">
          <div class="card stack"><h2 style="margin:0">Fotorealistische Visualisierung</h2>
            <p class="small muted" style="margin:0">Variante A – Lumion: Modell als DAE exportieren, in Lumion importieren (Meter, Y oben). Ursprung = Parzellenschwerpunkt, damit Gelände und Gebäude deckungsgleich sind.</p>
            <div class="row"><button class="btn" id="exDae">Modell für Lumion (DAE)</button></div>
            <p class="small muted" style="margin:6px 0 0">Variante B – KI-Bildgenerator: Aufnahme als Referenzbild verwenden, dazu diesen Prompt:</p>
            <textarea id="prompt" style="min-height:150px;font-family:var(--font);font-size:13px">${esc(this.aiPrompt())}</textarea>
            <div class="row"><button class="btn sm" id="cp">Prompt kopieren</button><select id="season" style="width:auto"><option>Spätsommer, Abendlicht</option><option>Frühling, Morgenlicht</option><option>Winter mit Schnee</option><option>Herbst, bewölkt</option></select></div>
          </div>
          <div class="card stack"><div class="row between"><h2 style="margin:0">Auswahl Bauherrschaft</h2><button class="btn sm" onclick="App.go('catalog')">Katalog verwalten</button></div>
            <div id="sel"></div></div>
        </div>
        <div class="card" style="margin-top:16px"><div class="row between"><h2 style="margin:0">Katalog</h2><div class="pill-filter" id="cf"></div></div><div class="catalog" id="cat" style="margin-top:12px"></div></div></div>`;
      $$('[data-rm]').forEach(b => b.onclick = () => { p.images = p.images.filter(i => i.id !== b.dataset.rm); this.markDirty(); this.go('media'); });
      $$('[data-dl]').forEach(b => b.onclick = async () => { const im = p.images.find(i => i.id === b.dataset.dl); const blob = await (await fetch(im.url)).blob(); Exporter.download(blob, `${Exporter.safeName(p.name)}_${Exporter.safeName(im.title)}.jpg`); });
      $('#exDae').onclick = async () => { const tmp = document.createElement('div'); tmp.style.cssText = 'position:fixed;left:-9999px;width:800px;height:600px'; document.body.appendChild(tmp); const v3 = this.ensure3D(tmp); v3.build(p); const blob = await v3.exportScene('dae'); Exporter.download(blob, `${Exporter.safeName(p.name)}_Lumion.dae`); tmp.remove(); };
      $('#cp').onclick = () => { navigator.clipboard.writeText($('#prompt').value); this.toast('Prompt kopiert'); };
      $('#season').onchange = e => { $('#prompt').value = this.aiPrompt(e.target.value); };
      this._catFilter = this._catFilter || 'Alle'; this.renderCatalogGrid(); this.renderSelections();
    },
    aiPrompt(season = 'Spätsommer, Abendlicht') {
      const p = this.project; const v = p.variants.find(x => x.id === p.activeVariant); const st = STYLES[p.style] || STYLES.putz_holz;
      const sel = (p.selections || []).map(s => this.catalogMap[s.catalogId]).filter(Boolean);
      const fac = sel.filter(c => c.category === 'Fassade').map(c => c.name).join(', ');
      const sl = Geo.slopeOf(p.terrain, p.parcel.polygon).pct;
      return `Fotorealistische Architekturvisualisierung, Augenhöhe, 35 mm Objektiv. ${v ? `${v.name} (${v.metrics.floors} Geschosse, Flachdach)` : 'Einfamilienhaus'} ${sl > 8 ? 'am Hang' : 'in ebenem Gelände'} in einem Ostschweizer Wohnquartier${p.parcel.gemeinde ? ' (Region ' + p.parcel.gemeinde + ')' : ''}. Fassade: ${fac || st.name}. Grosse Holz-Metall-Fenster mit schlanken Rahmen, gepflegter Garten mit einheimischen Gehölzen, Zugangsweg zur Haustür. Stimmung: ${season}, weiches Licht, realistische Materialien, keine Personen im Vordergrund. Geometrie, Proportionen und Fensteranordnung exakt wie im Referenzbild beibehalten.`;
    },
    renderCatalogGrid() {
      const cats = ['Alle', ...Catalog.CATEGORIES]; const f = this._catFilter;
      $('#cf').innerHTML = cats.map(c => `<button class="${c === f ? 'on' : ''}" data-c="${c}">${c}</button>`).join('');
      $$('#cf button').forEach(b => b.onclick = () => { this._catFilter = b.dataset.c; this.renderCatalogGrid(); });
      const items = this.catalog.filter(c => f === 'Alle' || c.category === f);
      const inProj = new Set(this.project.selections.map(s => s.catalogId));
      $('#cat').innerHTML = items.map(c => `<div class="prod"><div class="ph" style="${c.image ? `background-image:url('${c.image}')` : c.color ? `background:${c.color}` : ''}">${c.image || c.color ? '' : esc(c.category)}</div>
        <div class="pb"><span class="small muted">${esc(c.category)}${c.maker ? ' · ' + esc(c.maker) : ''}</span><b>${esc(c.name)}</b><span class="small muted">${esc(c.desc || '')}</span>
        <span class="price">CHF ${fN(c.price, 0)} / ${esc(c.unit)}</span>${c.seed ? '<span class="small muted">Richtpreis, inkl. MWST</span>' : ''}
        <div class="row" style="margin-top:6px">${inProj.has(c.id) ? '<span class="chip ok">im Projekt</span>' : `<button class="btn sm primary" data-add="${c.id}">+ Zum Projekt</button>`}${c.link ? `<a class="btn sm ghost" target="_blank" href="${esc(c.link)}">↗</a>` : ''}</div></div></div>`).join('') || '<div class="empty small">Keine Produkte in dieser Kategorie.</div>';
      $$('[data-add]').forEach(b => b.onclick = () => { const c = this.catalogMap[b.dataset.add]; const q = this.suggestQty(c); this.project.selections.push({ id: uid('s'), catalogId: c.id, qty: q, status: 'offen', allowance: 0, note: '', date: new Date().toISOString() }); this.markDirty(); this.renderCatalogGrid(); this.renderSelections(); this.renderNav(); });
    },
    suggestQty(c) {
      const p = this.project; const v = p.variants.find(x => x.id === p.activeVariant); if (!v) return 1; const m = v.metrics;
      const facade = m.perimeter * (m.floors * v.fh + 0.5) * 0.75;
      if (c.unit === 'm²') { if (c.category === 'Fassade') return Math.round(facade); if (c.category === 'Fenster') return Math.round(m.gf * 0.18); if (c.category === 'Boden') return Math.round(m.ngfEst * 0.7); if (c.category === 'Dach') return Math.round(m.footprintArea); if (c.category === 'Aussenraum') return 25; }
      return 1;
    },
    renderSelections() {
      const p = this.project; const el = $('#sel'); if (!el) return;
      if (!p.selections.length) { el.innerHTML = '<div class="empty small">Noch keine Produkte gewählt. Unten im Katalog «+ Zum Projekt».</div>'; return; }
      let sum = 0;
      el.innerHTML = `<table class="t"><tr><th>Produkt</th><th class="r">Menge</th><th>Status</th><th class="r">CHF</th><th></th></tr>${p.selections.map(s => {
        const c = this.catalogMap[s.catalogId]; if (!c) return ''; const chf = (s.qty || 0) * (c.price || 0); sum += chf;
        return `<tr data-s="${s.id}"><td><b class="small">${esc(c.name)}</b><div class="small muted">${esc(c.category)}</div><input type="text" data-f="note" value="${esc(s.note || '')}" placeholder="Notiz / Variante" style="margin-top:3px"></td>
          <td class="r"><input type="number" data-f="qty" value="${s.qty}" style="width:70px"> <span class="small muted">${esc(c.unit)}</span></td>
          <td><select data-f="status" style="width:110px">${['offen', 'favorit', 'entschieden', 'verworfen'].map(o => `<option ${o === s.status ? 'selected' : ''}>${o}</option>`).join('')}</select></td>
          <td class="r">${fN(chf, 0)}</td><td><button class="btn sm ghost" data-x>✕</button></td></tr>`;
      }).join('')}<tr class="sum"><td colspan="3">Total Auswahl</td><td class="r">${fN(sum, 0)}</td><td></td></tr></table>
      <p class="small muted">Status «entschieden» = Übergabe an Planer. Mehr-/Minderkosten fliessen in die Kosteneinschätzung (Schritt 7).</p>`;
      $$('#sel tr[data-s]').forEach(tr => { const s = p.selections.find(x => x.id === tr.dataset.s); $$('[data-f]', tr).forEach(inp => inp.onchange = () => { s[inp.dataset.f] = inp.type === 'number' ? Number(inp.value) : inp.value; s.date = new Date().toISOString(); this.markDirty(); this.renderSelections(); }); $('[data-x]', tr).onclick = () => { p.selections = p.selections.filter(x => x !== s); this.markDirty(); this.renderSelections(); this.renderCatalogGrid && $('#cat') && this.renderCatalogGrid(); }; });
    },
    pCatalog(main) {
      main.innerHTML = `<div class="page"><div class="row between"><div><h1>Katalog verwalten</h1><p class="lead">Produkte von Herstellern und Händlern erfassen – mit Preis, Einheit, Bild und Farbe (Fassaden-Farbe wird im 3D verwendet). Der Katalog gilt für alle Projekte.</p></div>
        <div class="row"><button class="btn" id="cimp">CSV importieren…</button><button class="btn" id="cexp">CSV exportieren</button><button class="btn primary" id="cadd">+ Produkt</button></div></div>
        <table class="t card" style="padding:0"><tr><th>Kategorie</th><th>Produkt</th><th>Hersteller</th><th class="r">Preis</th><th>Einheit</th><th>Farbe</th><th></th></tr>
        ${this.catalog.map(c => `<tr><td>${esc(c.category)}</td><td><b>${esc(c.name)}</b><div class="small muted">${esc(c.desc || '')}</div></td><td>${esc(c.maker || '')}</td><td class="r">${fN(c.price, 0)}</td><td>${esc(c.unit)}</td><td>${c.color ? `<span style="display:inline-block;width:18px;height:18px;border-radius:4px;background:${c.color};border:1px solid var(--line2)"></span>` : ''}</td><td class="r"><button class="btn sm ghost" data-ed="${c.id}">Bearbeiten</button><button class="btn sm ghost" data-de="${c.id}">✕</button></td></tr>`).join('')}</table>
        <p class="small muted">CSV-Spalten: Kategorie;Produkt;Hersteller;Preis;Einheit;Farbe;Beschreibung;Link</p></div>`;
      $('#cadd').onclick = () => this.editProduct(); $$('[data-ed]').forEach(b => b.onclick = () => this.editProduct(this.catalogMap[b.dataset.ed]));
      $$('[data-de]').forEach(b => b.onclick = async () => { await Store.del('catalog', b.dataset.de); this.catalog = this.catalog.filter(c => c.id !== b.dataset.de); this.go('catalog'); });
      $('#cexp').onclick = () => { const rows = [['Kategorie', 'Produkt', 'Hersteller', 'Preis', 'Einheit', 'Farbe', 'Beschreibung', 'Link'], ...this.catalog.map(c => [c.category, c.name, c.maker, c.price, c.unit, c.color, c.desc, c.link])]; Exporter.download(new Blob(['﻿' + rows.map(r => r.map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n')], { type: 'text/csv' }), 'Baucockpit_Katalog.csv'); };
      $('#cimp').onclick = () => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.csv,.txt'; i.onchange = async () => { const txt = (await i.files[0].text()).replace(/^﻿/, ''); const lines = txt.split(/\r?\n/).filter(Boolean); let n = 0; for (const l of lines.slice(1)) { const c = l.split(';').map(x => x.replace(/^"|"$/g, '').replace(/""/g, '"')); if (c.length < 5) continue; const it = { id: uid('c'), category: c[0], name: c[1], maker: c[2], price: Number(String(c[3]).replace(/[^\d.]/g, '')), unit: c[4], color: c[5] || '', desc: c[6] || '', link: c[7] || '', image: '' }; await Store.put('catalog', it); this.catalog.push(it); n++; } this.toast(`${n} Produkte importiert`); this.go('catalog'); }; i.click(); };
    },
    async editProduct(c) {
      const it = c ? { ...c } : { id: uid('c'), category: 'Küche', name: '', maker: '', price: 0, unit: 'Stk', color: '', desc: '', link: '', image: '' };
      const r = await this.dialog(c ? 'Produkt bearbeiten' : 'Neues Produkt', `<div class="fields">
        <label class="f"><span>Kategorie</span><select name="category">${Catalog.CATEGORIES.map(k => `<option ${k === it.category ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <label class="f"><span>Hersteller / Händler</span><input type="text" name="maker" value="${esc(it.maker)}"></label>
        <label class="f" style="grid-column:1/-1"><span>Produkt</span><input type="text" name="name" value="${esc(it.name)}"></label>
        <label class="f"><span>Preis CHF</span><input type="number" name="price" value="${it.price}"></label>
        <label class="f"><span>Einheit</span><select name="unit">${['Stk', 'm²', 'lfm', 'pauschal'].map(k => `<option ${k === it.unit ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <label class="f"><span>Farbe (Fassade 3D)</span><input type="text" name="color" value="${esc(it.color)}" placeholder="#a7774a"></label>
        <label class="f"><span>Link</span><input type="text" name="link" value="${esc(it.link)}"></label>
        <label class="f" style="grid-column:1/-1"><span>Beschreibung</span><input type="text" name="desc" value="${esc(it.desc)}"></label>
        <label class="f" style="grid-column:1/-1"><span>Bild (optional)</span><input type="file" accept="image/*" id="pimg"></label></div>`, [{ label: 'Abbrechen' }, { label: 'Speichern', primary: true }]);
      if (r.i !== 1) return; Object.assign(it, r.vals); it.price = Number(it.price) || 0; delete it.undefined;
      const f = this._pimg; if (f) it.image = f;
      await Store.put('catalog', it); const i = this.catalog.findIndex(x => x.id === it.id); if (i >= 0) this.catalog[i] = it; else this.catalog.push(it); this._pimg = null; this.go('catalog');
    },

    /* =============== 7 Kosten & Baueingabe =============== */
    pCosts(main) {
      const p = this.project; const v = p.variants.find(x => x.id === p.activeVariant);
      if (!v) { main.innerHTML = `<div class="page"><div class="empty">Zuerst im Schritt 3 eine Variante wählen.</div></div>`; return; }
      main.innerHTML = `<div class="page"><h1>7 · Kosten & Baueingabe</h1><p class="lead">Grobkostenschätzung nach BKP auf Basis des Gebäudevolumens (SIA 416) und der Produktentscheide. Das Baueingabe-Paket wird aus demselben Modell abgeleitet: Situation, Grundrisse, Geländeschnitt, Flächen- und Ziffernnachweis.</p>
        <div class="grid g-side">
          <div class="card stack"><h3>Parameter</h3>
            <label class="f"><span>Ausbaustandard</span><select data-k="costs.standard">${Object.entries(Engine.COST_STANDARDS).map(([k, s]) => `<option value="${k}">${s.name} – CHF ${s.chfm3}/m³</option>`).join('')}</select></label>
            <div class="fields">
              <label class="f"><span>Kennwert CHF/m³ (überschreibt)</span><input type="number" data-k="costs.chfm3" placeholder="Standard"></label>
              <label class="f"><span>UG CHF/m³</span><input type="number" data-k="costs.ugChfm3"></label>
              <label class="f"><span>Umgebung CHF/m²</span><input type="number" data-k="costs.umgebungChfm2"></label>
              <label class="f"><span>Garage/Carport Stk</span><input type="number" data-k="costs.garage"></label>
              <label class="f"><span>BKP 1 %</span><input type="number" step="0.5" data-k="costs.bkp1pct"></label>
              <label class="f"><span>Hangzuschlag %</span><input type="number" step="0.5" data-k="costs.hangZuschlagPct"></label>
              <label class="f"><span>BKP 5 %</span><input type="number" step="0.5" data-k="costs.bkp5pct"></label>
              <label class="f"><span>Reserve %</span><input type="number" step="1" data-k="costs.reservePct"></label>
              <label class="f"><span>Landpreis CHF/m²</span><input type="number" data-k="costs.landPrice"></label>
            </div>
            <p class="small muted">Kennwerte sind Richtwerte (Ostschweiz, inkl. MWST, inkl. Honorare). Mit eigenen Abrechnungswerten überschreiben.</p></div>
          <div class="card"><h3>Kosteneinschätzung – ${esc(v.name)}</h3><div id="ctab"></div></div>
        </div>
        <div class="grid g2" style="margin-top:16px">
          <div class="card"><h3>Vollständigkeit Baueingabe</h3><ul class="checklist" id="chk"></ul></div>
          <div class="card stack"><h3>Ausgabe</h3>
            <button class="btn primary" id="pdf">Baueingabe-Paket (PDF)</button>
            <div class="row"><button class="btn" id="dxf">Pläne DXF (LV95)</button><button class="btn" id="json">Projektdatei (JSON)</button></div>
            <button class="btn" id="zip">Übergabe-Paket an Planer (ZIP)</button>
            <p class="small muted">Plannummern nach Schema <span class="mono">${esc(Exporter.planNo(p, 'GR', 1))}</span> (Projekt-Nr. – SIA-Teilphase 33 – Plantyp + Nr.). Das ZIP enthält PDF, DXF, 3D-Modell (DAE/GLB), Bilder, Raumprogramm und Entscheidliste.</p></div>
        </div></div>`;
      const upd = () => this.renderCostTable(); this.bind(main, upd); upd(); this.renderChecklist();
      $('#pdf').onclick = () => this.withBusy($('#pdf'), async () => { const d = await this.makePdf(); d.save(`${Exporter.safeName(p.name)}_Baueingabe.pdf`); });
      $('#dxf').onclick = () => Exporter.download(new Blob([Exporter.buildDxf(p)], { type: 'application/dxf' }), `${Exporter.safeName(p.name)}_LV95.dxf`);
      $('#json').onclick = () => Exporter.download(new Blob([JSON.stringify(p, null, 1)], { type: 'application/json' }), `${Exporter.safeName(p.name)}.baucockpit.json`);
      $('#zip').onclick = () => this.withBusy($('#zip'), () => this.makeZip());
    },
    async withBusy(btn, fn) { const t = btn.textContent; btn.disabled = true; btn.textContent = 'Erstelle…'; try { await fn(); } catch (e) { console.error(e); this.toast('Fehler: ' + e.message, 4000); } btn.disabled = false; btn.textContent = t; },
    renderCostTable() {
      const c = Engine.estimateCosts(this.project, this.catalogMap); if (!c) return;
      $('#ctab').innerHTML = `<table class="t"><tr><th>BKP</th><th>Position</th><th class="r">CHF</th></tr>
        ${c.lines.map(l => `<tr><td>${l.bkp}</td><td>${esc(l.text)}<div class="small muted">${esc(l.basis)}${l.note ? ' · ' + esc(l.note) : ''}</div></td><td class="r">${fN(l.chf, 0)}</td></tr>`).join('')}
        <tr class="sum"><td></td><td>Anlagekosten (ohne Land)</td><td class="r">${fN(c.total, 0)}</td></tr></table>
        <div class="kpis" style="margin-top:12px"><div class="kpi"><b>${fN(c.range[0] / 1e6, 2)}–${fN(c.range[1] / 1e6, 2)} Mio.</b><span>Bandbreite ±25 %</span></div>
        <div class="kpi"><b>${fN(c.perM3, 0)}</b><span>CHF/m³ GV (total)</span></div><div class="kpi"><b>${fN(c.perM2, 0)}</b><span>CHF/m² GF</span></div>
        ${c.land ? `<div class="kpi"><b>${Engine.fmtCHF(c.land + c.total)}</b><span>inkl. Land</span></div>` : ''}</div>`;
    },
    renderChecklist() {
      const p = this.project; const v = p.variants.find(x => x.id === p.activeVariant);
      const items = [
        [p.parcel.polygon.length > 2, 'Parzelle mit Geometrie', p.parcel.egrid ? 'amtlich' : 'manuell'],
        [!!p.terrain && p.terrain.source && !/Annahme|synthet/.test(p.terrain.source), 'Gelände aus swissALTI3D', p.terrain ? p.terrain.source : ''],
        [!!p.rulesConfirmed, 'Zonenwerte mit Baureglement abgeglichen', p.rules.zoneName],
        [v && v.ok, 'Variante baurechtskonform', v ? v.name : ''],
        [p.planFromVariant === p.activeVariant && p.plan.walls.length > 0, 'Grundriss aus aktiver Variante', ''],
        [p.plan.rooms.length > 0, 'Räume erfasst (Flächennachweis)', `${p.plan.rooms.length} Räume`],
        [p.plan.openings.length > 0, 'Türen/Fenster gesetzt', ''],
        [!!p.meta.client, 'Bauherrschaft erfasst', p.meta.client],
        [!!this.settings.office, 'Projektverfasser (Einstellungen)', this.settings.office]
      ];
      $('#chk').innerHTML = items.map(([ok, t, d]) => `<li><span class="chip ${ok ? 'ok' : 'warn'}">${ok ? '✓' : '!'}</span>${esc(t)} <span class="small muted">${esc(d || '')}</span></li>`).join('') + '<li class="small muted" style="margin-top:6px">Nicht enthalten (separat beizulegen): Baugesuchsformular der Gemeinde, Energienachweis, Kanalisation, Schutzraum, Lärmschutz, Unterschriften.</li>';
    },
    async makePdf() { const s = { ...this.settings, _catalogMap: this.catalogMap }; return Exporter.buildPdf(this.project, s, Engine.estimateCosts(this.project, this.catalogMap)); },
    async makeZip() {
      const p = this.project; const zip = new JSZip(); const base = Exporter.safeName(p.name);
      const pdf = await this.makePdf(); zip.file(`01_Baueingabe/${base}_Baueingabe.pdf`, pdf.output('blob'));
      zip.file(`02_CAD/${base}_LV95.dxf`, Exporter.buildDxf(p));
      const tmp = document.createElement('div'); tmp.style.cssText = 'position:fixed;left:-9999px;width:800px;height:600px'; document.body.appendChild(tmp);
      const v3 = this.ensure3D(tmp); v3.build(p);
      zip.file(`03_3D/${base}_Lumion.dae`, await v3.exportScene('dae')); zip.file(`03_3D/${base}.glb`, await v3.exportScene('glb')); tmp.remove();
      for (const [i, im] of p.images.entries()) zip.file(`04_Bilder/${String(i + 1).padStart(2, '0')}_${Exporter.safeName(im.title)}.jpg`, im.url.split(',')[1], { base64: true });
      const csv = rows => '﻿' + rows.map(r => r.map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
      zip.file('05_Listen/Raumprogramm.csv', csv([['Raum', 'Soll m2', 'Ist m2', 'Geschoss', 'Nutzung'], ...p.program.map(r => [r.name, r.area, fN(p.plan.rooms.filter(x => x.name === r.name).reduce((s, x) => s + G.absArea(x.poly), 0), 1), r.level, r.use])]));
      zip.file('05_Listen/Entscheide_Material_Produkte.csv', csv([['Kategorie', 'Produkt', 'Hersteller', 'Menge', 'Einheit', 'Preis', 'Total', 'Status', 'Notiz', 'Datum'], ...p.selections.map(s => { const c = this.catalogMap[s.catalogId] || {}; return [c.category, c.name, c.maker, s.qty, c.unit, c.price, (s.qty || 0) * (c.price || 0), s.status, s.note, (s.date || '').slice(0, 10)]; })]));
      zip.file(`06_Projektdatei/${base}.baucockpit.json`, JSON.stringify(p));
      const v = p.variants.find(x => x.id === p.activeVariant);
      zip.file('LIESMICH.txt', [`Übergabe-Paket ${p.name}`, `Erstellt ${new Date().toLocaleString('de-CH')} mit Baucockpit`, '', `Parzelle ${p.parcel.number} ${p.parcel.gemeinde}, EGRID ${p.parcel.egrid}`, `Variante: ${v ? v.name : '-'}`, `Koordinaten: LV95 (EPSG:2056). DXF in Metern, georeferenziert.`, `3D: Ursprung = Parzellenschwerpunkt E ${fN(G.centroid(p.parcel.polygon)[0], 2)} / N ${fN(G.centroid(p.parcel.polygon)[1], 2)}, Höhe 0 = ${p.terrain ? fN(p.terrain.min, 2) : '0'} m ü.M.`, '', 'Projektdatei (JSON) kann in Baucockpit über «Projekt importieren» wieder geöffnet werden.', 'Vorabklärung – ersetzt keine Prüfung durch die Baubehörde.'].join('\r\n'));
      Exporter.download(await zip.generateAsync({ type: 'blob' }), `${base}_Uebergabe.zip`);
    },

    /* =============== Einstellungen =============== */
    async pSettings(main) {
      const est = await Store.estimate(); const s = this.settings;
      const perm = this.dirHandle && this.dirHandle.queryPermission ? await this.dirHandle.queryPermission({ mode: 'readwrite' }) : null;
      main.innerHTML = `<div class="page"><h1>Einstellungen & Daten</h1><p class="lead">Büroangaben für Plankopf und Baueingabe, Datenspeicher und Sicherung.</p>
        <div class="grid g2">
          <div class="card stack"><h3>Projektverfasser</h3><div class="fields">
            <label class="f" style="grid-column:1/-1"><span>Büro</span><input type="text" id="s_office" value="${esc(s.office)}"></label>
            <label class="f" style="grid-column:1/-1"><span>Adresse</span><input type="text" id="s_addr" value="${esc(s.officeAddr)}"></label>
            <label class="f"><span>Sachbearbeitung</span><input type="text" id="s_author" value="${esc(s.author)}"></label>
            <label class="f"><span>Projekt-Nr. Präfix</span><input type="text" id="s_pref" value="${esc(s.projNrPrefix)}" placeholder="691."></label></div>
            <button class="btn primary" id="s_save">Speichern</button></div>
          <div class="card stack"><h3>Datenspeicher</h3>
            <p class="small" style="margin:0">Projekte werden automatisch im internen Speicher dieses Browsers gesichert (IndexedDB${est ? `, belegt ${fN(est.usage / 1048576, 1)} MB` : ''}). Zusätzlich kann ein Ordner verbunden werden – jede Änderung wird dort als JSON-Datei abgelegt (z. B. im Projektordner auf SharePoint/OneDrive).</p>
            <div class="row"><button class="btn" id="dir">${this.dirHandle ? 'Anderen Ordner wählen' : 'Ordner verbinden…'}</button>
            ${this.dirHandle ? `<span class="chip ${perm === 'granted' ? 'ok' : 'warn'}">${esc(this.dirHandle.name)} · ${perm === 'granted' ? 'aktiv' : 'Freigabe nötig'}</span>${perm !== 'granted' ? '<button class="btn sm" id="dirp">Freigeben</button>' : ''}<button class="btn sm ghost" id="dirx">trennen</button>` : ''}</div>
            ${window.showDirectoryPicker ? '' : '<div class="note warn small">Ordner-Synchronisation benötigt Microsoft Edge oder Google Chrome.</div>'}
            <h3 style="margin-top:8px">Sicherung</h3><div class="row"><button class="btn" id="bak">Komplette Sicherung exportieren</button><button class="btn" id="res">Sicherung einlesen…</button></div>
            <p class="small muted">Sicherung = alle Projekte, Katalog und Einstellungen in einer Datei. Wichtig vor Browser-Wechsel oder Löschen der Browserdaten.</p></div>
        </div></div>`;
      $('#s_save').onclick = async () => { Object.assign(s, { office: $('#s_office').value, officeAddr: $('#s_addr').value, author: $('#s_author').value, projNrPrefix: $('#s_pref').value }); await Store.setSetting('office', s); this.toast('Gespeichert'); };
      $('#dir').onclick = async () => { try { const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'baucockpit' }); this.dirHandle = h; await Store.setSetting('dirHandle', h); if (this.project) await this.syncToFolder(); this.toast('Ordner verbunden'); this.go('settings'); } catch (e) { } };
      $('#dirp') && ($('#dirp').onclick = async () => { await this.dirHandle.requestPermission({ mode: 'readwrite' }); this.go('settings'); });
      $('#dirx') && ($('#dirx').onclick = async () => { this.dirHandle = null; await Store.setSetting('dirHandle', null); this.go('settings'); });
      $('#bak').onclick = async () => Exporter.download(new Blob([JSON.stringify(await Store.exportAll())], { type: 'application/json' }), `Baucockpit_Sicherung_${new Date().toISOString().slice(0, 10)}.json`);
      $('#res').onclick = () => this.importProjectFile();
    }
  };

  // Produktbild im Dialog einlesen
  document.addEventListener('change', e => { if (e.target.id === 'pimg' && e.target.files[0]) { const r = new FileReader(); r.onload = () => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); const s = Math.min(1, 640 / img.width); c.width = img.width * s; c.height = img.height * s; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); App._pimg = c.toDataURL('image/jpeg', 0.82); }; img.src = r.result; }; r.readAsDataURL(e.target.files[0]); } });

  window.App = App;
  window.addEventListener('DOMContentLoaded', () => App.init().catch(e => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<div class="note warn" style="position:fixed;bottom:10px;left:10px">Startfehler: ${esc(e.message)}</div>`); }));
})();
