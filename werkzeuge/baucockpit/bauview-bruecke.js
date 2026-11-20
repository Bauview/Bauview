/* Baucockpit – Brücke zu BauView (Export in eine Richtung)
 * Nur aktiv, wenn das Baucockpit innerhalb von BauView (iframe) läuft.
 * Liest NIE BauView-Daten. Schickt auf ausdrücklichen Klick die Projektdaten an BauView,
 * dort öffnet sich „Neues Projekt eröffnen“ vorausgefüllt. */
(function () {
  if (window.parent === window) return; // eigenständig geöffnet → nichts tun
  const zahl = (x, d) => (x == null || isNaN(x)) ? null : Number(Number(x).toFixed(d));
  const zoneText = z => !z ? '' : typeof z === 'string' ? z : (z.name || z.code || z.label || z.key || '');

  function daten() {
    const A = window.App, p = A && A.project;
    if (!p) return null;
    const meta = p.meta || {}, par = p.parcel || {};
    const v = (p.variants || []).find(x => x.id === p.activeVariant);
    const m = (v && v.metrics) || null;
    let kosten = null;
    try {
      const c = v && window.Engine && Engine.estimateCosts(p, A.catalogMap);
      if (c) kosten = {
        total: Math.round(c.total), von: Math.round(c.range[0]), bis: Math.round(c.range[1]),
        chfM3: zahl(c.rate, 0), land: Math.round(c.land || 0),
        zeilen: c.lines.map(l => ({ bkp: l.bkp, text: l.text, chf: l.chf }))
      };
    } catch (e) { console.warn('Baucockpit: Kostenschätzung nicht verfügbar', e); }
    return {
      quelle: 'baucockpit', version: 1, exportiert: new Date().toISOString(),
      name: p.name || '', nummer: meta.projNr || '', bauherr: meta.client || '', adresse: meta.address || '', notizen: meta.notes || '',
      parzelle: { nummer: par.number || '', egrid: par.egrid || '', gemeinde: par.gemeinde || '', kanton: par.canton || '', flaeche: zahl(par.area, 0), zone: zoneText(par.zone) },
      variante: v ? v.name || '' : '',
      kennwerte: m ? {
        parzelle: zahl(m.parcelArea, 0), gebaeudeflaeche: zahl(m.footprintArea, 1), gf: zahl(m.gf, 1), agf: zahl(m.aGF, 1),
        gv: zahl(m.gv, 0), hnf: zahl(m.hnfEst, 1), geschosse: m.floors || null,
        az: zahl(m.az, 2), uez: zahl(m.uez, 3), gesamthoehe: zahl(m.gh, 2)
      } : null,
      kosten,
      termine: [] // Baucockpit führt (noch) keine Termine
    };
  }

  function senden() {
    const d = daten();
    if (!d) { window.App && App.toast && App.toast('Zuerst ein Projekt öffnen'); return; }
    if (window.App && App.saveNow) { try { App.saveNow(); } catch (e) { /* egal */ } }
    window.parent.postMessage({ typ: 'bauview-werkzeug-export', werkzeug: 'baucockpit', daten: d }, '*');
  }

  window.addEventListener('DOMContentLoaded', () => {
    const ziel = document.querySelector('header.top');
    if (!ziel) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn sm primary'; b.id = 'bv-export';
    b.textContent = 'Als neues BauView-Projekt anlegen';
    b.title = 'Übernimmt Adresse, Parzelle, Bauherr, Kennwerte und Kostenschätzung in ein neues BauView-Projekt';
    b.onclick = senden;
    ziel.appendChild(b);
  });
})();
