/* Baucockpit – Produktkatalog (Startbestand: generische Richtpositionen, frei erweiterbar) */
(function () {
  const CATEGORIES = ['Fassade', 'Fenster', 'Küche', 'Bad', 'Boden', 'Dach', 'Haustechnik', 'Aussenraum', 'Innenausbau'];
  const u = Plan.uid;
  const SEED = [
    ['Fassade', 'Holzschalung vertikal, Lärche unbehandelt', 'm²', 210, '#a7774a', 'Hinterlüftete Fassade, Deckleisten-/Boden-Deckel-Schalung'],
    ['Fassade', 'Verputzte Aussenwärmedämmung, Abrieb 2 mm', 'm²', 165, '#ece7de', 'Kompaktfassade, Farbe frei wählbar'],
    ['Fassade', 'Faserzementplatten anthrazit', 'm²', 245, '#3c3f42', 'Hinterlüftet, grossformatig'],
    ['Fassade', 'Metall-Stehfalz, Aluminium natur', 'm²', 290, '#8b9096', 'Hinterlüftet'],
    ['Fassade', 'Sichtbeton zweischalig', 'm²', 420, '#b9b7b1', 'Kerndämmung, Schalungstyp 4'],
    ['Fenster', 'Holz-Metall-Fenster 3-fach IV', 'm²', 1150, '', 'Uw ≈ 0.75 W/m²K'],
    ['Fenster', 'Kunststoff-Metall-Fenster 3-fach IV', 'm²', 820, '', 'Uw ≈ 0.8 W/m²K'],
    ['Fenster', 'Hebeschiebetür Holz-Metall 4.0 × 2.4 m', 'Stk', 14500, '', 'Schwellenlos'],
    ['Küche', 'Einbauküche Standard, 4 m Zeile', 'Stk', 24000, '', 'Kunstharzfronten, Granit-Abdeckung, Geräte Mittelklasse'],
    ['Küche', 'Küche mit Kochinsel, gehoben', 'Stk', 48000, '', 'Lackfronten, Keramikabdeckung, Dampfabzug integriert'],
    ['Bad', 'Badausstattung Standard (WC, Lavabo, Dusche)', 'Stk', 9500, '', 'Sanitärapparate inkl. Armaturen'],
    ['Bad', 'Badausstattung gehoben (inkl. Wanne)', 'Stk', 19500, '', 'Wand-WC, Doppellavabo, bodenebene Dusche, Wanne'],
    ['Boden', 'Eichenparkett geölt, Landhausdiele', 'm²', 145, '', 'inkl. Verlegung'],
    ['Boden', 'Feinsteinzeug 60×60', 'm²', 120, '', 'inkl. Verlegung'],
    ['Boden', 'Hartbeton geschliffen', 'm²', 160, '', ''],
    ['Dach', 'Flachdach extensiv begrünt', 'm²', 95, '', 'Aufpreis zu Kiesdach'],
    ['Dach', 'Photovoltaik-Anlage, 10 kWp', 'Stk', 22000, '', 'inkl. Wechselrichter, vor Förderbeiträgen'],
    ['Haustechnik', 'Luft-Wasser-Wärmepumpe, aussen', 'Stk', 32000, '', 'inkl. Speicher'],
    ['Haustechnik', 'Erdsonden-Wärmepumpe', 'Stk', 52000, '', 'inkl. Bohrung (Bewilligung nötig)'],
    ['Haustechnik', 'Kontrollierte Wohnungslüftung', 'Stk', 18000, '', ''],
    ['Aussenraum', 'Sitzplatz Feinsteinzeug auf Splitt', 'm²', 180, '', ''],
    ['Aussenraum', 'Carport Holz, 2 PP', 'Stk', 26000, '', ''],
    ['Innenausbau', 'Einbauschränke Garderobe', 'lfm', 2400, '', 'Schreinerarbeit'],
    ['Innenausbau', 'Innentüren Stumpf, weiss', 'Stk', 1350, '', 'inkl. Zarge, Montage']
  ].map(([category, name, unit, price, color, desc]) => ({ id: u('c'), category, name, unit, price, color, desc, maker: '', link: '', image: '', seed: true }));
  window.Catalog = { CATEGORIES, SEED };
})();
