/* ============================================================
   BauView – Baumanagement (REALVIEW-Funktionsumfang nachgebaut)
   Module: Dashboard · Pläne+Mängel · Mängelliste · Abnahmeprotokoll(SIA118)
           · Checklisten/Prüfplan · Regieaufträge · Baujournal · Aktennotizen
           · Adressliste · Bildergalerie · Protokolle · Statistik
   Offline-first via IndexedDB. Mail-Vorbereitung via mailto + Vorschau.
   ============================================================ */
pdfjsLib.GlobalWorkerOptions.workerSrc='vendor/pdf.worker.min.js';

let CURRENT_USER={name:'', initials:'?', email:'', role:''};
let CURRENT_AUTH=null; // aktueller Cloud-Login (Auth-User), null = nicht eingeloggt
const BKP=['111 Vorbereitungsarbeiten','113 Baugrubenaushub','114 Spezielle Fundationen','201 Baumeisterarbeiten','211 Baumeisterarbeiten','211.0 Gerüste','211.4 Montagebau in Holz','213 Bearbeiteter Naturstein','214 Stahl- und Metallbau','221 Fenster, Aussentüren, Tore','222 Spenglerarbeiten','224 Bedachungsarbeiten','226 Fassadenputze','227 Äussere Abschlüsse','228 Storen, Rollläden','230 Elektroanlagen','231 Starkstrominstallationen','232 Telefon / Kommunikation','233 Leuchten','236 Schwachstrominstallationen','240 Heizungs-/Lüftungsanlagen','244 Lüftungsanlagen','250 Sanitäranlagen','251 Sanitärapparate','253 Sanitäre Leitungen','258 Kücheneinrichtungen','271 Gipserarbeiten','272 Metallbauarbeiten (innen)','273 Schreinerarbeiten','274 Schliessanlagen','275 Schliess-/Sicherheitssysteme','281 Bodenbeläge','281.0 Unterlagsböden','281.6 Plattenarbeiten','282 Wandbeläge','283 Deckenbekleidungen','285 Malerarbeiten','287 Reinigung','290 Honorare','291 Architekt','292 Bauingenieur','293 Elektroingenieur','294 HLKS-Ingenieur','296 Bauphysik / Akustik','EL Elektroanlagen','HLKS Haustechnik'];

let db, state={
  module:'dashboard', projectId:null,
  planId:null, version:null, defectId:null, zoom:1, armed:false, lupe:false, drawMode:false, measureMode:false, pdfDoc:null, viewport:null,
  filter:{q:'',status:'',assignee:''}, selection:new Set(), _photoTarget:null, _sign:null,
  _pendingZoom:null, _zoomAnchor:null
};
let _sharpTimer=null;

/* ---------- IndexedDB ---------- */
const STORES=['projects','plans','defects','contacts','protocols','acceptances','checklists','workorders','journal','notes','users','files','app','honorars','baubeschriebe'];
// Welche Stores werden in die Cloud gespiegelt (alle ausser 'app' = nur lokale Einstellungen)
const SYNC_STORES=['projects','plans','defects','contacts','protocols','acceptances','checklists','workorders','journal','notes','users','files','honorars','baubeschriebe'];
function openDB(){return new Promise((res,rej)=>{
  const r=indexedDB.open('bauview2',5);
  let settled=false;
  const timeout=setTimeout(()=>{
    if(settled)return;
    console.warn('[DB] Öffnen dauert ungewöhnlich lange – evtl. durch einen anderen offenen BauView-Tab blockiert.');
    if(typeof toast==='function') toast('Datenbank reagiert nicht. Bitte alle anderen BauView-Tabs schliessen und neu laden.');
  },6000);
  r.onupgradeneeded=e=>{const d=e.target.result;STORES.forEach(s=>{if(!d.objectStoreNames.contains(s))d.createObjectStore(s,{keyPath:'id'});});};
  r.onsuccess=e=>{
    settled=true;clearTimeout(timeout);
    db=e.target.result;
    // Falls ein anderer Tab/eine neuere Version die DB aktualisieren will: sauber schliessen
    // statt mit einer veralteten/instabilen Verbindung weiterzuarbeiten.
    db.onversionchange=()=>{
      db.close();db=undefined;
      if(typeof toast==='function') toast('Eine neuere Version wurde in einem anderen Tab geöffnet. Bitte diese Seite neu laden.');
    };
    res();
  };
  r.onerror=()=>{settled=true;clearTimeout(timeout);rej(r.error);};
  r.onblocked=()=>{
    // Ein anderer offener Tab mit einer älteren Version blockiert die Aktualisierung.
    console.warn('[DB] Aktualisierung blockiert – bitte andere BauView-Tabs schliessen.');
    if(typeof toast==='function') toast('Bitte andere geöffnete BauView-Tabs schliessen und neu laden.');
  };
});}
function tx(s,m='readonly'){
  if(!db) throw new Error('Datenbank ist nicht bereit. Bitte alle anderen BauView-Tabs/-Fenster schliessen und diese Seite neu laden.');
  return db.transaction(s,m).objectStore(s);
}
// --- Lokale Roh-Operationen (IndexedDB) ---
function putLocal(s,o){return new Promise((res,rej)=>{const r=tx(s,'readwrite').put(o);r.onsuccess=()=>res(o);r.onerror=rej;});}
function delLocal(s,id){return new Promise((res,rej)=>{const r=tx(s,'readwrite').delete(id);r.onsuccess=res;r.onerror=rej;});}
// --- Öffentliche API (lokal + Cloud-Spiegelung) ---
const _syncHashes={}; // store:id -> letzter Hash, um identische Uploads zu vermeiden (spart Daten)
function _quickHash(o){ try{const s=JSON.stringify(o);let h=0;for(let i=0;i<s.length;i++){h=(h*31+s.charCodeAt(i))|0;}return h+':'+s.length;}catch(e){return Math.random();} }
function put(s,o){
  return putLocal(s,o).then(saved=>{
    if(SYNC_STORES.includes(s) && typeof cloudUpsert==='function'){
      const key=s+':'+saved.id, h=_quickHash(saved);
      if(_syncHashes[key]!==h){ _syncHashes[key]=h; cloudUpsert(s,saved); } // nur bei echter Änderung hochladen
    }
    return saved;
  });
}
function del(s,id){
  return delLocal(s,id).then(r=>{
    delete _syncHashes[s+':'+id];
    if(SYNC_STORES.includes(s) && typeof cloudDelete==='function') cloudDelete(s,id);
    return r;
  });
}
function all(s){return new Promise((res,rej)=>{const r=tx(s).getAll();r.onsuccess=()=>res(r.result);r.onerror=rej;});}
function get(s,id){return new Promise((res,rej)=>{if(id==null){res(undefined);return;}const r=tx(s).get(id);r.onsuccess=()=>res(r.result);r.onerror=rej;});}
async function byProject(s){return (await all(s)).filter(x=>x.projectId===state.projectId);}

/* Universelles Löschen mit Bestätigung – entfernt lokal UND aus der Cloud (via del()).
   labelText: was angezeigt wird; afterFn: Neu-Rendern nach dem Löschen. */
// --- Entwurfs-Sicherung: bewahrt Eingaben in offenen Formularen, falls ein Fenster
//     unerwartet schliesst (z.B. Browser-Aussetzer). "Speichern" bleibt zusätzlich bestehen
//     und ist weiterhin der Weg, um etwas endgültig zu sichern. ---
function _draftKey(kind,id){ return 'bauview_draft_'+kind+'_'+(id||'new'); }
function _draftSave(kind,id,obj){ try{ localStorage.setItem(_draftKey(kind,id), JSON.stringify(obj)); }catch(e){} }
function _draftLoad(kind,id){ try{ const s=localStorage.getItem(_draftKey(kind,id)); return s?JSON.parse(s):null; }catch(e){ return null; } }
function _draftClear(kind,id){ try{ localStorage.removeItem(_draftKey(kind,id)); }catch(e){} }
// Debounce-Hilfsfunktion für laufendes Zwischenspeichern ohne bei jedem Tastendruck zu schreiben
function _debounce(fn,ms){ let t; const d=(...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms||400); }; d.cancel=()=>clearTimeout(t); return d; }

// --- Spracherkennung (Diktieren) für Freitext-Felder – Hochdeutsch oder Schweizerdeutsch ---
// Nutzt die browsereigene Web Speech API (Chrome/Edge). Kein Server, keine externe Bibliothek.
function _dictateLang(){ try{ return localStorage.getItem('bauview_dictate_lang')||'de-DE'; }catch(e){ return 'de-DE'; } }
function _setDictateLang(l){ try{ localStorage.setItem('bauview_dictate_lang',l); }catch(e){} }
// Hängt einen Diktier-Knopf + Sprachwahl direkt neben ein Textfeld (Label-Zeile).
// Erscheint nur, wenn der Browser Spracherkennung unterstützt (kein Fehler in anderen Browsern).
function attachDictateButton(labelEl,textareaEl){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR||!labelEl||!textareaEl)return;
  const wrap=document.createElement('span');wrap.className='dictate-wrap';
  wrap.innerHTML=`<button type="button" class="dictate-btn" title="Diktieren (Mikrofon)">🎙</button>
    <select class="dictate-lang" title="Sprache der Spracherkennung">
      <option value="de-DE">Hochdeutsch</option>
      <option value="de-CH">Schweizerdeutsch</option>
    </select>`;
  labelEl.appendChild(wrap);
  const langSel=wrap.querySelector('.dictate-lang');langSel.value=_dictateLang();
  langSel.onchange=()=>_setDictateLang(langSel.value);
  const btn=wrap.querySelector('.dictate-btn');
  let rec=null,recording=false,baseText='',finalTxt='';
  btn.onclick=(ev)=>{
    ev.preventDefault();
    if(recording){ if(rec)rec.stop(); return; }
    baseText=textareaEl.value;finalTxt='';
    rec=new SR();rec.lang=langSel.value;rec.continuous=true;rec.interimResults=true;
    rec.onresult=e=>{
      let interim='';
      for(let i=e.resultIndex;i<e.results.length;i++){
        const t=e.results[i][0].transcript;
        if(e.results[i].isFinal)finalTxt+=t+' ';else interim+=t;
      }
      textareaEl.value=(baseText?baseText.replace(/\s+$/,'')+' ':'')+finalTxt+interim;
      textareaEl.dispatchEvent(new Event('input',{bubbles:true}));
    };
    rec.onerror=e=>{
      recording=false;btn.classList.remove('active');
      if(e.error==='not-allowed')toast('Mikrofon-Zugriff wurde verweigert',false,true);
      else if(e.error!=='no-speech'&&e.error!=='aborted')toast('Spracherkennung: '+e.error,false,true);
    };
    rec.onend=()=>{recording=false;btn.classList.remove('active');};
    try{rec.start();recording=true;btn.classList.add('active');}
    catch(e){toast('Spracherkennung konnte nicht gestartet werden',false,true);}
  };
}

async function confirmDelete(store, id, labelText, afterFn){
  if(!id)return false;
  if(!confirm(`„${labelText||'Eintrag'}" wirklich löschen? Das kann nicht rückgängig gemacht werden.`))return false;
  await del(store, id);
  toast('Gelöscht');
  if(typeof afterFn==='function')await afterFn();
  return true;
}
// Schützt Aktions-Buttons vor Doppelklick (verhindert Duplikate). Gibt true zurück, wenn bereits aktiv.
function guardBusy(btn){
  if(!btn)return false;
  if(btn.dataset.busy==='1')return true;
  btn.dataset.busy='1';btn.disabled=true;
  return false;
}
function releaseBusy(btn){ if(btn){btn.dataset.busy='0';btn.disabled=false;} }

const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const nowISO=()=>new Date().toISOString();
const todayISO=()=>new Date().toISOString().slice(0,10);
const fmtDate=iso=>iso?new Date(iso).toLocaleDateString('de-CH',{day:'2-digit',month:'2-digit',year:'numeric'}):'—';
const fmtDateTime=iso=>iso?new Date(iso).toLocaleString('de-CH',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const esc=s=>(s==null?'':String(s)).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money=n=>'CHF '+(Number(n)||0).toLocaleString('de-CH',{minimumFractionDigits:2,maximumFractionDigits:2});
const statusKey=s=>s==='Offen'?'offen':s==='In Arbeit'?'arbeit':'erledigt';
const fileToB64=f=>new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(f);});
const b64ToU8=b64=>{const bin=atob(b64.split(',')[1]);const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u;};
// Liefert die pdf.js-Quelle für eine Planversion: lokale Rohdaten bevorzugt (schnell),
// sonst Fallback auf die Cloud-URL (falls diese Version nur von einem anderen Gerät synchronisiert wurde).
const pdfSourceFor=ver=>ver&&ver.pdfData?{data:b64ToU8(ver.pdfData)}:(ver&&ver.pdfUrl?{url:ver.pdfUrl}:null);
// Repariert beschädigte/unvollständige Plan-Datensätze (z.B. aus einem abgebrochenen
// früheren Upload), damit die Anzeige nie an einem fehlenden 'versions'-Feld abstürzt.
function _normalizePlan(p){
  if(!p) return p;
  if(!Array.isArray(p.versions) || !p.versions.length){
    p.versions=[{v:1,fileName:p.name?p.name+'.pdf':'unbekannt.pdf',pdfData:null,pdfUrl:null,uploadedAt:p.createdAt||nowISO(),uploadedBy:''}];
    p.currentVersion=1;
    p._repaired=true;
  }
  if(!p.currentVersion || !p.versions.some(v=>v.v===p.currentVersion)){
    p.currentVersion=p.versions[p.versions.length-1].v;
  }
  return p;
}

let toastT;
function toast(m,ok=false,isErr=false){
  const t=document.getElementById('toast');t.textContent=m;t.className='toast show'+(ok?' ok':'')+(isErr?' err':'');
  clearTimeout(toastT);
  t.onclick=()=>{clearTimeout(toastT);t.className='toast';};
  toastT=setTimeout(()=>t.className='toast', isErr?12000:2300); // Fehler bleiben deutlich länger stehen
}

/* ---------- Modal helper ---------- */
function modal(html,{wide=false}={}){
  const root=document.getElementById('modalRoot');
  root.innerHTML=`<div class="modal-bg" id="mbg"><div class="modal ${wide?'wide':''}">${html}</div></div>`;
  // Bewusst KEIN Schliessen durch Klick auf den Hintergrund mehr – ein versehentlicher Klick
  // daneben hat sonst ungespeicherte Eingaben gelöscht. Schliessen nur noch über
  // "Abbrechen"/"×"-Knöpfe im Fenster selbst.
  return root;
}
function closeModal(){document.getElementById('modalRoot').innerHTML='';}
// Modal-STAPEL: öffnet ein zusätzliches Fenster ÜBER dem aktuellen, ohne es zu zerstören
// (z.B. Foto-Aufnahme innerhalb eines offenen Editors). closeSubModal() entfernt nur die oberste Ebene.
function subModal(html,{wide=false}={}){
  let layer=document.getElementById('modalRoot2');
  if(!layer){ layer=document.createElement('div'); layer.id='modalRoot2'; document.body.appendChild(layer); }
  const wrap=document.createElement('div'); wrap.className='modal-bg sub-modal-bg';
  wrap.innerHTML=`<div class="modal ${wide?'wide':''}">${html}</div>`;
  layer.appendChild(wrap);
  wrap.addEventListener('click',e=>{if(e.target===wrap)closeSubModal(wrap);});
  return wrap;
}
function closeSubModal(wrap){
  if(wrap&&wrap.remove){wrap.remove();return;}
  const layer=document.getElementById('modalRoot2');
  if(layer&&layer.lastElementChild)layer.lastElementChild.remove();
}

/* ---------- Seed demo ---------- */
async function seedIfEmpty(){
  // Keine Musterdaten – der Nutzer legt alles selbst an.
  const ps=await all('projects');
  if(ps.length && !state.projectId)state.projectId=ps[0].id;
}

/* ---------- Modules registry ---------- */
const MODULES=[
  {id:'dashboard', label:'Übersicht', ic:'▦', render:renderDashboard},
  {id:'plans',     label:'Pläne & Mängel', ic:'📐', render:renderPlans},
  {id:'defects',   label:'Mängelliste', ic:'⚠', render:renderDefectList, badge:async()=>(await byProject('defects')).filter(d=>d.status!=='Erledigt').length},
  {id:'pendenzen', label:'Pendenzen', ic:'📨', render:renderPendenzen},
  {id:'acceptance',label:'Abnahme SIA 118', ic:'✓', render:renderAcceptance},
  {id:'checklists',label:'Prüfpläne', ic:'☑', render:renderChecklists},
  {id:'workorders',label:'Regieaufträge', ic:'🧾', render:renderWorkorders},
  {id:'journal',   label:'Baujournal', ic:'📕', render:renderJournal},
  {id:'notes',     label:'Aktennotizen', ic:'📝', render:renderNotes},
  {id:'contacts',  label:'Unternehmerliste', ic:'👥', render:renderContacts},
  {id:'honorar',   label:'Honorarofferte SIA 102', ic:'🧮', render:renderHonorar},
  {id:'baubeschrieb', label:'Baubeschrieb', ic:'📖', render:renderBaubeschrieb},
  {id:'gallery',   label:'Bildergalerie', ic:'🖼', render:renderGallery},
  {id:'protocols', label:'Protokolle', ic:'📋', render:renderProtocols},
  {id:'stats',     label:'Statistik', ic:'📊', render:renderStats}
];

const RAIL_GROUPS=[
  {title:'', ids:['dashboard']},
  {title:'Erfassung', ids:['plans','defects','pendenzen','notes','journal']},
  {title:'Dokumente', ids:['acceptance','checklists','workorders','protocols','honorar','baubeschrieb']},
  {title:'Projekt', ids:['contacts','gallery','stats']}
];
async function renderRail(){
  const rail=document.getElementById('rail');
  rail.innerHTML='';
  for(const g of RAIL_GROUPS){
    if(g.title){const t=document.createElement('div');t.className='rail-title';t.textContent=g.title;rail.appendChild(t);}
    for(const id of g.ids){
      const m=MODULES.find(x=>x.id===id);if(!m)continue;
      if(typeof roleCanSee==='function'&&!roleCanSee(m.id))continue; // app-seitige Rechte
      const b=document.createElement('button');
      b.className=(m.id===state.module?'active':'');
      let badge='';
      if(m.badge){const n=await m.badge();if(n)badge=`<span class="railbadge">${n}</span>`;}
      b.innerHTML=`<span class="ic">${m.ic}</span><span class="lbl">${m.label.replace(/\n/g,' ')}</span>${badge}`;
      b.onclick=()=>navigate(m.id);
      rail.appendChild(b);
    }
  }
  await renderMobileNav();
}
// Untere Tableiste fürs Handy – kurze Labels, wichtigste Module zuerst
const MOBILE_ORDER=['dashboard','plans','defects','pendenzen','notes','journal','protocols','acceptance','checklists','workorders','contacts','honorar','baubeschrieb','gallery','stats'];
const MOBILE_SHORT={dashboard:'Start',plans:'Pläne',defects:'Mängel',pendenzen:'Pendenz',notes:'Notiz',journal:'Journal',protocols:'Protok.',acceptance:'Abnahme',checklists:'Prüfen',workorders:'Regie',contacts:'Unternehmer',honorar:'Honorar',baubeschrieb:'Baubeschrieb',gallery:'Bilder',stats:'Statistik'};
async function renderMobileNav(){
  const wrap=document.getElementById('mnavScroll');
  if(!wrap)return;
  wrap.innerHTML='';
  for(const id of MOBILE_ORDER){
    const m=MODULES.find(x=>x.id===id);if(!m)continue;
    if(typeof roleCanSee==='function'&&!roleCanSee(m.id))continue;
    const b=document.createElement('button');
    b.className='mnav-item'+(m.id===state.module?' active':'');
    let badge='';
    if(m.badge){const n=await m.badge();if(n)badge=`<span class="mnav-badge">${n}</span>`;}
    b.innerHTML=`<span class="mnav-ic">${m.ic}</span><span>${MOBILE_SHORT[id]||m.label}</span>${badge}`;
    b.onclick=()=>{navigate(m.id);
      // aktiven Tab in Sicht scrollen
      setTimeout(()=>b.scrollIntoView({inline:'center',block:'nearest',behavior:'smooth'}),50);
    };
    wrap.appendChild(b);
  }
}
async function navigate(id){
  state.module=id;state.defectId=null;
  await renderRail();
  const m=MODULES.find(x=>x.id===id);
  document.getElementById('stage').innerHTML='';
  await m.render();
  // Datei-Ablage-Leiste für dieses Modul einblenden (nicht im Dashboard)
  if(state.projectId && !['dashboard'].includes(id)) await renderModuleFiles(id, m.label.replace(/\n/g,' '));
}

/* ============================================================
   MODUL-DATEIABLAGE: externe Dateien je Modul hochladen
   (alle Typen). Lokal als Base64; mit Cloud → Supabase-Storage.
   ============================================================ */
const FILE_ICONS={pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',ppt:'📑',pptx:'📑',jpg:'🖼',jpeg:'🖼',png:'🖼',gif:'🖼',zip:'🗜',dwg:'📐',default:'📎'};
function fileIcon(name){const ext=(name||'').split('.').pop().toLowerCase();return FILE_ICONS[ext]||FILE_ICONS.default;}
function fmtBytes(n){if(!n)return '';if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(0)+' KB';return (n/1048576).toFixed(1)+' MB';}

async function renderModuleFiles(moduleId, moduleLabel){
  const stage=document.getElementById('stage');
  const moduleEl=stage.querySelector('.module');
  if(!moduleEl) return;
  const body=moduleEl.querySelector('.mod-body')||moduleEl;
  // bereits vorhandene Leiste entfernen
  const old=document.getElementById('moduleFilesBar'); if(old)old.remove();
  const files=(await byProject('files')).filter(f=>f.module===moduleId).sort((a,b)=>(b.uploadedAt||'').localeCompare(a.uploadedAt||''));
  const bar=document.createElement('div');
  bar.id='moduleFilesBar';bar.className='modfiles';
  bar.innerHTML=`
    <div class="modfiles-head">
      <span class="modfiles-title">📎 Dateien zu „${esc(moduleLabel)}"<span class="modfiles-count">${files.length}</span></span>
      <button class="btn btn-steel btn-sm" id="modFileAdd">＋ Datei hochladen</button>
    </div>
    <div class="modfiles-list" id="modFilesList">
      ${files.length?files.map(f=>`
        <div class="modfile" data-fid="${f.id}">
          <span class="mf-ic">${fileIcon(f.name)}</span>
          <div class="mf-meta"><div class="mf-name">${esc(f.name)}</div>
            <div class="mf-sub">${fmtBytes(f.size)} · ${fmtDate(f.uploadedAt)} · ${esc(f.uploadedBy||'')}</div></div>
          <button class="mf-open" data-open="${f.id}" title="Öffnen">↗</button>
          <button class="mf-del" data-del="${f.id}" title="Löschen">×</button>
        </div>`).join(''):'<div class="modfiles-empty">Noch keine Dateien. Lade z.B. ältere Protokolle, Pläne oder Berichte zu diesem Modul hoch.</div>'}
    </div>`;
  body.appendChild(bar);
  document.getElementById('modFileAdd').onclick=()=>uploadModuleFile(moduleId,moduleLabel);
  bar.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openStoredFile(b.dataset.open));
  bar.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>deleteStoredFile(b.dataset.del,moduleId,moduleLabel));
}

function uploadModuleFile(moduleId,moduleLabel){
  const inp=document.createElement('input');inp.type='file';inp.multiple=true;
  inp.onchange=async e=>{
    const files=[...e.target.files];if(!files.length)return;
    for(const f of files){
      const rec={id:uid(),projectId:state.projectId,module:moduleId,name:f.name,size:f.size,type:f.type,
        uploadedAt:nowISO(),uploadedBy:CURRENT_USER.name||'',storage:'local',data:null,path:null,url:null};
      // Cloud-Upload wenn verfügbar, sonst lokal als Base64
      if(typeof cloudEnabled==='function' && cloudEnabled()){
        try{
          const up=await cloudUploadFile(state.projectId,f);
          rec.storage='cloud';rec.path=up.path;rec.url=up.url;
        }catch(err){ console.warn('Cloud-Upload fehlgeschlagen, lokal gespeichert:',err.message); rec.data=await fileToB64(f); }
      }else{
        rec.data=await fileToB64(f);
      }
      await put('files',rec);
    }
    toast(files.length===1?'Datei hochgeladen':files.length+' Dateien hochgeladen',true);
    await renderModuleFiles(moduleId,moduleLabel);
  };
  inp.click();
}
async function openStoredFile(id){
  const f=await get('files',id);if(!f)return;
  if(f.storage==='cloud'&&f.url){ window.open(f.url,'_blank'); return; }
  if(f.data){
    // Base64 → Blob → öffnen
    try{
      const arr=f.data.split(',');const mime=(arr[0].match(/:(.*?);/)||[])[1]||f.type||'application/octet-stream';
      const bin=atob(arr[1]);const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);
      const blob=new Blob([u],{type:mime});const url=URL.createObjectURL(blob);
      window.open(url,'_blank');setTimeout(()=>URL.revokeObjectURL(url),60000);
    }catch(e){toast('Datei kann nicht geöffnet werden');}
  }
}
async function deleteStoredFile(id,moduleId,moduleLabel){
  const f=await get('files',id);if(!f)return;
  if(!confirm('Datei „'+f.name+'" löschen?'))return;
  if(f.storage==='cloud'&&f.path&&typeof cloudDeleteFile==='function')await cloudDeleteFile(f.path);
  await del('files',id);
  toast('Datei gelöscht');
  await renderModuleFiles(moduleId,moduleLabel);
}

/* ---------- Project switch ---------- */
// Liefert nur Projekte, die der aktuelle Benutzer sehen darf (Eigentümer/Mitglied/Admin).
// Im Lokal-Modus (ohne Cloud) sind alle sichtbar.
async function visibleProjects(){
  const all_=await all('projects');
  const cloudOn = typeof cloudEnabled==='function' && cloudEnabled() && CURRENT_AUTH;
  if(!cloudOn) return all_;
  const myId=CURRENT_AUTH.id;
  const isAdmin = typeof cloudIsAdmin==='function' && cloudIsAdmin(CURRENT_AUTH.email);
  if(isAdmin) return all_;
  return all_.filter(p=>{
    const members=Array.isArray(p.members)?p.members:[];
    return p.ownerId===myId || members.includes(myId);
  });
}
async function renderProjectSelect(){
  const ps=await visibleProjects();
  // falls aktuelles Projekt nicht (mehr) sichtbar ist, zurücksetzen
  if(state.projectId && !ps.some(p=>p.id===state.projectId)) state.projectId=null;
  if(!state.projectId&&ps.length)state.projectId=ps[0].id;
  if(!ps.length)state.projectId=null;
  const sel=document.getElementById('projSelect');
  if(!ps.length){
    sel.innerHTML=`<option value="">— noch kein Projekt —</option>`;
  }else{
    sel.innerHTML=ps.map(p=>`<option value="${p.id}" ${p.id===state.projectId?'selected':''}>${esc(p.name)}</option>`).join('');
  }
}
document.getElementById('projSelect').onchange=async e=>{
  if(!e.target.value)return;
  state.projectId=e.target.value;state.planId=null;state.defectId=null;state.selection.clear();
  state.module='dashboard';
  await navigate('dashboard');await renderRail();
};

/* ---------- Neues Projekt eröffnen ---------- */
document.getElementById('newProjBtn').onclick=()=>openProjectEditor();
async function openProjectEditor(existing){
  const isNew=!existing;
  const defaultTpl=`Sehr geehrte Damen und Herren der {Unternehmer}\n\nim Rahmen des Projekts „{Projekt}" wurden Ihnen {Anzahl} Pendenz(en) zugewiesen. Wir bitten Sie um fristgerechte Behebung bis spätestens {Frist} und um eine kurze Rückmeldung.\n\nDie Detailliste entnehmen Sie bitte dem beigefügten PDF.\n\nBesten Dank und freundliche Grüsse\n{Benutzer}`;
  const p=existing||{id:uid(),name:'',client:'',address:'',logo:'',mailTemplate:defaultTpl};
  if(p.mailTemplate==null)p.mailTemplate=defaultTpl;
  modal(`<div class="modal-head"><h3>${isNew?'Neues Projekt eröffnen':'Projekt bearbeiten'}</h3>
      <p>${isNew?'Lege ein neues Bauprojekt an. Pläne, Mängel und Kontakte werden separat pro Projekt geführt.':''}</p></div>
    <div class="modal-body">
      <div class="field"><label>Projektname *</label><input id="pr-name" value="${esc(p.name)}" placeholder="z.B. Neubau Mehrfamilienhaus Bergstrasse"></div>
      <div class="field"><label>Bauherr / Auftraggeber</label><input id="pr-client" value="${esc(p.client)}" placeholder="z.B. Bergstrasse Immobilien AG"></div>
      <div class="field"><label>Adresse / Standort</label><input id="pr-address" value="${esc(p.address)}" placeholder="z.B. Bergstrasse 10, 9000 St. Gallen"></div>
      <div class="field"><label>E-Mail-Vorlage für Pendenzen (Autotext)</label>
        <textarea id="pr-mailtpl" style="min-height:150px;font-size:13px;line-height:1.5">${esc(p.mailTemplate)}</textarea>
        <div style="font-size:11.5px;color:var(--muted);margin-top:6px;line-height:1.6">
          Platzhalter werden automatisch ersetzt: <b>{Unternehmer}</b>, <b>{Projekt}</b>, <b>{Anzahl}</b>, <b>{Frist}</b>, <b>{Benutzer}</b>, <b>{Bauherr}</b>.<br>
          Du kannst auch reinen Festtext ohne Platzhalter schreiben.
        </div>
      </div>
      ${(typeof cloudEnabled==='function'&&cloudEnabled())?`
      <div class="field" style="border-top:1px solid var(--line);padding-top:14px;margin-top:6px">
        <label>👥 Projekt-Mitglieder (Zugriff)</label>
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Nur diese Personen (und der Admin) sehen dieses Projekt. Wähle aus den registrierten Benutzern.</div>
        <div id="memberList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px"></div>
        <div style="display:flex;gap:8px"><select id="memberPick" style="flex:1"></select><button class="btn btn-steel btn-sm" id="addMemberBtn" type="button">Hinzufügen</button></div>
      </div>`:''}
    </div>
    <div class="modal-foot">
      ${isNew?'':'<button class="btn btn-danger" id="prDel">Projekt löschen</button>'}
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" id="prSave">${isNew?'Projekt eröffnen':'Speichern'}</button>
    </div>`,{wide:true});
  // Mitglieder-Verwaltung
  if(typeof cloudEnabled==='function'&&cloudEnabled()){
    if(!Array.isArray(p.members))p.members=[];
    if(CURRENT_AUTH&&CURRENT_AUTH.id&&!p.ownerId)p.ownerId=CURRENT_AUTH.id;
    if(CURRENT_AUTH&&CURRENT_AUTH.id&&!p.members.includes(CURRENT_AUTH.id))p.members.push(CURRENT_AUTH.id);
    // Registrierte Benutzer aus Konten-Register + Profilen, dedupliziert nach E-Mail
    let accs=[];try{accs=await cloudListAccounts();}catch(e){}
    let prof=[];try{prof=await all('users');}catch(e){}
    const peopleByEmail={};
    const addP=(id,email,name)=>{email=(email||'').toLowerCase();const key=email||id;if(!peopleByEmail[key])peopleByEmail[key]={id,email,name:name||email||id};else{if(name&&!peopleByEmail[key].name)peopleByEmail[key].name=name;if(id.length>peopleByEmail[key].id.length)peopleByEmail[key].id=id;}};
    accs.forEach(a=>addP(a.id,a.email,a.name));
    prof.forEach(u=>addP(u.authId||u.id,u.email,u.name));
    const people=Object.values(peopleByEmail);
    const nameFor=mid=>{const pp=people.find(x=>x.id===mid);return pp?(pp.name||pp.email):mid;};
    const drawMembers=()=>{
      const ml=document.getElementById('memberList');if(!ml)return;
      ml.innerHTML=p.members.map(mid=>{
        const isOwner=mid===p.ownerId;
        const pp=people.find(x=>x.id===mid);
        return `<div style="display:flex;align-items:center;gap:8px;background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:7px 10px">
          <span style="flex:1;font-size:13px">${esc(nameFor(mid))}${isOwner?' <span class="pill">Eigentümer</span>':''}${pp&&cloudIsAdmin(pp.email)?' <span class="pill">Admin</span>':''}</span>
          ${isOwner?'':`<button class="row-del" data-rmid="${mid}" title="Entfernen" type="button">×</button>`}</div>`;
      }).join('');
      ml.querySelectorAll('[data-rmid]').forEach(b=>b.onclick=()=>{p.members=p.members.filter(x=>x!==b.dataset.rmid);drawMembers();drawPicker();});
    };
    const drawPicker=()=>{
      const sel=document.getElementById('memberPick');if(!sel)return;
      const avail=people.filter(pp=>!p.members.includes(pp.id));
      sel.innerHTML=avail.length?avail.map(pp=>`<option value="${pp.id}">${esc(pp.name||pp.email)}${pp.email?` (${esc(pp.email)})`:''}</option>`).join(''):'<option value="">— alle bereits Mitglied —</option>';
    };
    drawMembers();drawPicker();
    const addBtn=document.getElementById('addMemberBtn');
    if(addBtn)addBtn.onclick=()=>{
      const sel=document.getElementById('memberPick');const id=sel&&sel.value;
      if(!id){toast('Kein Benutzer auswählbar');return;}
      if(p.members.includes(id)){toast('Bereits Mitglied');return;}
      p.members.push(id);drawMembers();drawPicker();
    };
  }
  document.getElementById('prSave').onclick=async()=>{
    const name=document.getElementById('pr-name').value.trim();
    if(!name){toast('Bitte einen Projektnamen eingeben');document.getElementById('pr-name').focus();return;}
    p.name=name;p.client=document.getElementById('pr-client').value.trim();p.address=document.getElementById('pr-address').value.trim();
    p.mailTemplate=document.getElementById('pr-mailtpl').value;
    // Eigentümer + Mitglieder setzen (für serverseitige Projekt-Trennung)
    if(CURRENT_AUTH && CURRENT_AUTH.id){
      if(!p.ownerId) p.ownerId=CURRENT_AUTH.id;
      if(!Array.isArray(p.members)) p.members=[];
      if(!p.members.includes(CURRENT_AUTH.id)) p.members.push(CURRENT_AUTH.id);
    }
    await put('projects',p);
    state.projectId=p.id;state.planId=null;state.defectId=null;state.selection.clear();state.module='dashboard';
    closeModal();
    await renderProjectSelect();await renderRail();await navigate('dashboard');
    toast(isNew?'Projekt eröffnet':'Projekt gespeichert',true);
  };
  if(!isNew)document.getElementById('prDel').onclick=async()=>{
    if(!confirm('Projekt „'+p.name+'" und ALLE zugehörigen Daten (Pläne, Mängel, Protokolle, Kontakte …) unwiderruflich löschen?'))return;
    for(const store of ['plans','defects','contacts','protocols','acceptances','checklists','workorders','journal','notes']){
      const items=(await all(store)).filter(x=>x.projectId===p.id);
      for(const it of items)await del(store,it.id);
    }
    await del('projects',p.id);
    state.projectId=null;closeModal();
    await renderProjectSelect();await renderRail();await navigate('dashboard');
    toast('Projekt gelöscht');
  };
  setTimeout(()=>document.getElementById('pr-name')?.focus(),50);
}

/* ---------- Net status ---------- */
function updateNet(){
  const on=navigator.onLine;const p=document.getElementById('netPill');
  p.className='netpill '+(on?'online':'offline');
  document.getElementById('netText').textContent=on?'Online':'Offline · lokal';
}
window.addEventListener('online',()=>{updateNet();toast('Wieder online – wird synchronisiert',true);});
window.addEventListener('offline',()=>{updateNet();toast('Offline – Änderungen lokal gespeichert');});

/* ---------- Signature pad ---------- */
function attachSignPad(canvas){
  const ctx=canvas.getContext('2d');ctx.lineWidth=2;ctx.lineCap='round';ctx.strokeStyle='#14213d';
  let drawing=false,last=null;
  const pos=e=>{const r=canvas.getBoundingClientRect();const t=e.touches?e.touches[0]:e;return{x:(t.clientX-r.left)*(canvas.width/r.width),y:(t.clientY-r.top)*(canvas.height/r.height)};};
  const start=e=>{drawing=true;last=pos(e);e.preventDefault();};
  const move=e=>{if(!drawing)return;const p=pos(e);ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();last=p;e.preventDefault();};
  const end=()=>{drawing=false;};
  canvas.onmousedown=start;canvas.onmousemove=move;window.addEventListener('mouseup',end);
  canvas.ontouchstart=start;canvas.ontouchmove=move;canvas.ontouchend=end;
  return{clear:()=>ctx.clearRect(0,0,canvas.width,canvas.height),data:()=>canvas.toDataURL('image/png')};
}

/* ============================================================
   FOTO-QUELLE: Kamera (live) oder Datei – mit Komprimierung
   onPick(dataURL) wird mit dem fertigen (komprimierten) Bild aufgerufen.
   ============================================================ */
function compressImage(dataURL,maxDim=1600,quality=0.82){
  return new Promise(res=>{
    const img=new Image();
    img.onload=()=>{
      let{width:w,height:h}=img;
      if(w>maxDim||h>maxDim){if(w>h){h=Math.round(h*maxDim/w);w=maxDim;}else{w=Math.round(w*maxDim/h);h=maxDim;}}
      const cv=document.createElement('canvas');cv.width=w;cv.height=h;
      cv.getContext('2d').drawImage(img,0,0,w,h);
      res(cv.toDataURL('image/jpeg',quality));
    };
    img.onerror=()=>res(dataURL);
    img.src=dataURL;
  });
}
let _camStream=null;
function stopCam(){if(_camStream){_camStream.getTracks().forEach(t=>t.stop());_camStream=null;}}
function openPhotoSource(onPick){
  const wrap=subModal(`<div class="modal-head"><h3>Foto hinzufügen</h3><p>Direkt mit der Kamera aufnehmen oder eine Datei wählen.</p></div>
    <div class="modal-body" id="photoSrcBody">
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <button class="btn btn-primary" id="psCam" style="flex:1;min-width:150px">📷 Kamera aufnehmen</button>
        <button class="btn btn-ghost" id="psFile" style="flex:1;min-width:150px">🖼 Datei wählen</button>
      </div>
      <div id="camArea" class="hidden" style="margin-top:14px">
        <video id="camVideo" autoplay playsinline style="width:100%;border-radius:10px;background:#000;max-height:50vh"></video>
        <div style="display:flex;gap:10px;margin-top:10px">
          <button class="btn btn-ghost btn-sm" id="camSwitch" title="Kamera wechseln">🔄 Wechseln</button>
          <button class="btn btn-primary" id="camShoot" style="flex:1">⬤ Auslösen</button>
        </div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn btn-ghost" id="psCancel">Abbrechen</button></div>`);
  const finish=async(dataURL)=>{stopCam();const c=await compressImage(dataURL);closeSubModal(wrap);onPick(c);};
  wrap.querySelector('#psCancel').onclick=()=>{stopCam();closeSubModal(wrap);};
  // Datei wählen
  wrap.querySelector('#psFile').onclick=()=>{
    const inp=document.createElement('input');inp.type='file';inp.accept='image/*';
    inp.onchange=async e=>{const f=e.target.files[0];if(!f)return;const b64=await fileToB64(f);finish(b64);};
    inp.click();
  };
  // Kamera live
  let facing='environment';
  const startCam=async()=>{
    stopCam();
    try{
      _camStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:facing},audio:false});
      const v=wrap.querySelector('#camVideo');if(!v){stopCam();return;}
      v.srcObject=_camStream;
      wrap.querySelector('#camArea').classList.remove('hidden');
      wrap.querySelector('#psCam').classList.add('hidden');
      wrap.querySelector('#psFile').classList.add('hidden');
    }catch(err){
      toast('Kamerazugriff nicht möglich – bitte Datei wählen');
      const inp=document.createElement('input');inp.type='file';inp.accept='image/*';inp.capture='environment';
      inp.onchange=async e=>{const f=e.target.files[0];if(!f)return;const b64=await fileToB64(f);finish(b64);};
      inp.click();
    }
  };
  wrap.querySelector('#psCam').onclick=startCam;
  wrap.querySelector('#camSwitch').onclick=()=>{facing=facing==='environment'?'user':'environment';startCam();};
  wrap.querySelector('#camShoot').onclick=()=>{
    const v=wrap.querySelector('#camVideo');
    if(!v||!v.videoWidth){toast('Kamera noch nicht bereit');return;}
    const cv=document.createElement('canvas');cv.width=v.videoWidth;cv.height=v.videoHeight;
    cv.getContext('2d').drawImage(v,0,0);
    finish(cv.toDataURL('image/jpeg',0.9));
  };
}
async function renderPlans(){
  const stage=document.getElementById('stage');
  stage.innerHTML=`
    <div class="viewer">
      <div class="plan-side">
        <div class="plan-side-head"><h2>Pläne</h2></div>
        <div class="plan-list" id="planList"></div>
        <div class="plan-side-foot"><button class="btn btn-primary" style="width:100%" id="addPlanBtn">＋ Pläne hochladen</button></div>
      </div>
      <div class="viewer-main" id="viewerMain">
        <div class="empty" id="planEmpty" style="margin:auto">
          <div class="big">📐</div><h3>Kein Plan ausgewählt</h3>
          <p>Lade einen PDF-Plan hoch und setze Mängel-Marker direkt im Plan. Marker bleiben bei Plan-Updates erhalten.</p>
        </div>
        <div class="viewer-toolbar hidden" id="vToolbar">
          <span class="vt-title" id="vtTitle"></span>
          <div class="ver-menu"><button class="tool-btn" id="verBtn">Version ▾</button></div>
          <button class="tool-btn" id="updatePlanBtn" title="Neue Planversion – Marker bleiben erhalten">↻ Plan aktualisieren</button>
          <button class="tool-btn" id="markerBtn">＋ Mangel setzen</button>
          <button class="tool-btn" id="drawBtn" title="Freihand zeichnen, markieren, Formen">✏ Zeichnen</button>
          <button class="tool-btn" id="measureBtn" title="Distanzen anhand des Planmassstabs messen">📏 Massstab</button>
          <button class="tool-btn" id="exportPlanBtn" title="Plan mit Markern &amp; Zeichnungen in Originalgrösse als PDF exportieren">⬇ Plan-PDF</button>
          <div class="zoom-group"><button id="zoomOut" title="Verkleinern">−</button><span id="zoomLabel">100%</span><button id="zoomIn" title="Vergrössern">＋</button></div>
          <button class="tool-btn" id="lupeBtn" title="Lupe: Rechteck im Plan aufziehen, um in den Ausschnitt zu zoomen">🔍 Lupe</button>
          <button class="tool-btn" id="zoomResetBtn" title="Zoom zurücksetzen">⤢ Ansicht</button>
          <div class="legend">
            <span><span class="pin" style="background:var(--open)"></span>Offen</span>
            <span><span class="pin" style="background:var(--warn)"></span>In Arbeit</span>
            <span><span class="pin" style="background:var(--ok)"></span>Erledigt</span>
          </div>
        </div>
        <div class="measure-toolbar hidden" id="measureToolbar">
          <div class="dt-group">
            <label style="font-size:11px;color:var(--muted)">Massstab</label>
            <select id="measureScale">
              <option value="20">1:20</option><option value="50">1:50</option>
              <option value="100" selected>1:100</option><option value="200">1:200</option>
              <option value="250">1:250</option><option value="500">1:500</option>
              <option value="1000">1:1000</option><option value="__custom">Andere…</option>
            </select>
            <input type="number" id="measureScaleCustom" placeholder="z.B. 333" style="width:70px;display:none" min="1">
          </div>
          <div class="dt-group" style="font-size:13px;font-weight:700" id="measureResult">Zwei Punkte anklicken und ziehen, um zu messen.</div>
          <div class="dt-group">
            <button class="tool-btn" id="measureClear" title="Messung löschen">🗑 Löschen</button>
            <button class="btn btn-primary btn-sm" id="measureDone">✓ Fertig</button>
          </div>
        </div>
        <div class="draw-toolbar hidden" id="drawToolbar">
          <div class="dt-group">
            <button class="dt-tool active" data-tool="pen" title="Freihand">✏</button>
            <button class="dt-tool" data-tool="highlight" title="Textmarker (Leuchtstift)">🖍</button>
            <button class="dt-tool" data-tool="text" title="Text-Vermerk direkt auf den Plan setzen">🅣</button>
            <button class="dt-tool" data-tool="line" title="Linie">╱</button>
            <button class="dt-tool" data-tool="arrow" title="Pfeil">➜</button>
            <button class="dt-tool" data-tool="rect" title="Rechteck">▭</button>
            <button class="dt-tool" data-tool="ellipse" title="Kreis/Ellipse">◯</button>
            <button class="dt-tool" data-tool="select" title="Verschieben / Auswählen">✥</button>
            <button class="dt-tool" data-tool="erase" title="Radierer – Form antippen zum Löschen">⌫</button>
          </div>
          <div class="dt-group dt-colors">
            ${['#d32f2f','#e08a1c','#f0c419','#2e7d46','#1f6fb2','#7b3fa0','#1a1a1a','#ffffff'].map(c=>`<button class="dt-color${c==='#d32f2f'?' active':''}" data-color="${c}" style="background:${c};${c==='#ffffff'?'border-color:#ccc':''}"></button>`).join('')}
            <input type="color" id="dtCustomColor" title="Eigene Farbe" value="#d32f2f">
          </div>
          <div class="dt-group">
            <label style="font-size:11px;color:var(--muted)">Stärke</label>
            <input type="range" id="dtWidth" min="1" max="12" value="3" style="width:70px">
          </div>
          <div class="dt-group">
            <label style="font-size:11px;color:var(--muted)">Deckkraft</label>
            <input type="range" id="dtOpacity" min="10" max="100" value="100" style="width:70px">
            <span id="dtOpacityLabel" style="font-size:11px;color:var(--muted);width:32px">100%</span>
          </div>
          <div class="dt-group">
            <button class="tool-btn" id="dtUndo" title="Letzten Schritt rückgängig">↶ Rückgängig</button>
            <button class="tool-btn" id="dtClear" title="Alle Zeichnungen dieses Plans löschen">🗑 Alles löschen</button>
            <button class="btn btn-primary btn-sm" id="dtDone">✓ Fertig</button>
          </div>
        </div>
        <div class="canvas-scroll hidden" id="canvasScroll">
          <div class="canvas-stage" id="canvasStage">
            <canvas id="pdfCanvas"></canvas>
            <canvas id="drawCanvas"></canvas>
            <canvas id="measureCanvas"></canvas>
            <div class="marker-layer" id="markerLayer"></div>
            <div class="lupe-rect hidden" id="lupeRect"></div>
          </div>
        </div>
        <div class="armed-hint hidden" id="armedHint">📍 In den Plan tippen zum Platzieren · ESC bricht ab</div>
      </div>
      <div class="drawer" id="drawer">
        <div class="drawer-head"><span class="dr-num" id="dNum">—</span><h3 id="dHeadTitle">Mangel</h3><button class="drawer-close" id="drawerClose">×</button></div>
        <div class="drawer-body" id="drawerBody"></div>
        <div class="drawer-foot"><button class="btn btn-danger btn-sm" id="dDelete">Löschen</button><button class="btn btn-steel btn-sm" id="dShare">🔗 Für Unternehmer</button><button class="btn btn-primary btn-sm" id="dSave">Speichern</button></div>
      </div>
    </div>`;
  document.getElementById('addPlanBtn').onclick=()=>document.getElementById('planFileInput').click();
  document.getElementById('updatePlanBtn').onclick=()=>{if(state.planId)document.getElementById('updateFileInput').click();else toast('Zuerst einen Plan wählen');};
  document.getElementById('markerBtn').onclick=toggleArm;
  document.getElementById('drawBtn').onclick=toggleDrawMode;
  document.getElementById('measureBtn').onclick=toggleMeasureMode;
  document.getElementById('exportPlanBtn').onclick=()=>{if(state.planId)exportPlanAnnotatedPDF(state.planId);else toast('Zuerst einen Plan wählen');};
  document.getElementById('zoomIn').onclick=()=>zoomBy(1.25);
  document.getElementById('zoomOut').onclick=()=>zoomBy(0.8);
  document.getElementById('zoomResetBtn').onclick=()=>{state.zoom=1;renderPage();};
  document.getElementById('lupeBtn').onclick=toggleLupe;
  document.getElementById('drawerClose').onclick=()=>{closeDrawer();state.defectId=null;renderMarkers();};
  document.getElementById('dSave').onclick=saveDefect;
  document.getElementById('dShare').onclick=()=>{if(state.defectId)openShareModal(state.defectId);};
  document.getElementById('dDelete').onclick=deleteDefect;
  document.getElementById('markerLayer').onclick=placeMarker;
  setupWheelZoom();
  setupLupe();
  setupDrawTools();
  setupMeasureTool();
  await renderPlanList();
  if(state.planId)await openPlan(state.planId);
}

/* ---------- Zoom-Helfer (zentriert um aktuelle Scrollposition) ---------- */
function zoomBy(factor){
  const scroll=document.getElementById('canvasScroll');
  if(!scroll)return;
  // eventuell hängende Mausrad-Vorschau abbrechen
  if(_sharpTimer){clearTimeout(_sharpTimer);_sharpTimer=null;}
  state._pendingZoom=null;
  const stage=document.getElementById('canvasStage');if(stage)stage.style.transform='';
  const prev=state.zoom;
  const next=Math.min(Math.max(prev*factor,0.4),6);
  if(next===prev)return;
  const cx=(scroll.scrollLeft+scroll.clientWidth/2)/ (state.viewport?state.viewport.width:scroll.scrollWidth);
  const cy=(scroll.scrollTop+scroll.clientHeight/2)/ (state.viewport?state.viewport.height:scroll.scrollHeight);
  state.zoom=next;
  renderPage().then(()=>{
    if(state.viewport){
      scroll.scrollLeft=cx*state.viewport.width - scroll.clientWidth/2;
      scroll.scrollTop=cy*state.viewport.height - scroll.clientHeight/2;
    }
  });
}

/* ---------- Mausrad-Zoom (flüssig: sofort CSS-Transform, scharfes Re-Render nach Pause) ---------- */
function setupWheelZoom(){
  const scroll=document.getElementById('canvasScroll');
  if(!scroll)return;
  scroll.addEventListener('wheel',e=>{
    if(!state.pdfDoc||state.lupe||!state.viewport)return;
    e.preventDefault();
    const rect=scroll.getBoundingClientRect();
    const mx=e.clientX-rect.left, my=e.clientY-rect.top; // Cursor im Viewport
    // aktuelle sichtbare Skalierung = gerenderte Auflösung * aktive Vorschau-Transform
    const curZoom=(state._pendingZoom!=null?state._pendingZoom:state.zoom);
    const curScale=curZoom/state.zoom; // Transform-Faktor relativ zur gerenderten Stage
    const curW=state.viewport.width*curScale, curH=state.viewport.height*curScale;
    // Planpunkt (0..1) unter dem Cursor – aus AKTUELLER Scroll+Skalierung
    const ax=(scroll.scrollLeft+mx)/curW;
    const ay=(scroll.scrollTop+my)/curH;
    // neuen Zielzoom bestimmen
    const next=Math.min(Math.max(curZoom*(e.deltaY<0?1.12:0.89),0.4),6);
    if(next===curZoom)return;
    state._pendingZoom=next;
    // Vorschau anwenden und Scroll so setzen, dass (ax,ay) unter dem Cursor bleibt
    const factor=next/state.zoom;
    const stage=document.getElementById('canvasStage');
    if(stage){stage.style.transformOrigin='0 0';stage.style.transform=`scale(${factor})`;}
    const zl=document.getElementById('zoomLabel');if(zl)zl.textContent=Math.round(next*100)+'%';
    const newW=state.viewport.width*factor, newH=state.viewport.height*factor;
    scroll.scrollLeft=ax*newW-mx;
    scroll.scrollTop=ay*newH-my;
    // Anker für scharfes Nachrendern merken
    state._zoomAnchor={ax,ay,mx,my};
    scheduleSharpRender();
  },{passive:false});
}

function scheduleSharpRender(){
  if(_sharpTimer)clearTimeout(_sharpTimer);
  _sharpTimer=setTimeout(async()=>{
    _sharpTimer=null;
    if(state._pendingZoom==null)return;
    const target=state._pendingZoom;
    const anchor=state._zoomAnchor;
    state.zoom=target;
    // Im Hintergrund fertig rendern – die CSS-Vorschau bleibt währenddessen unverändert sichtbar
    const result=await _computePlanRender();
    state._pendingZoom=null;
    if(!result)return;
    // Jetzt ALLES in einem Schritt umschalten: Transform weg, scharfes Bild rein, Scroll korrigiert – kein sichtbarer Sprung
    const stage=document.getElementById('canvasStage');
    const scroll=document.getElementById('canvasScroll');
    if(stage)stage.style.transform='';
    _applyPlanRender(result);
    if(anchor&&scroll){
      scroll.scrollLeft=anchor.ax*result.vp.width-anchor.mx;
      scroll.scrollTop=anchor.ay*result.vp.height-anchor.my;
    }
    await renderMarkers();
    await _ensureDrawCache();
    renderDrawings();
    renderMeasure();
    const zl=document.getElementById('zoomLabel');if(zl)zl.textContent=Math.round(state.zoom*100)+'%';
  },140);
}

/* ---------- Lupe: Rechteck aufziehen → in Ausschnitt zoomen ---------- */
function toggleLupe(){
  state.lupe=!state.lupe;
  document.getElementById('lupeBtn').classList.toggle('armed',state.lupe);
  if(state.lupe&&state.armed)toggleArm(); // Marker-Modus aus, wenn Lupe an
  if(state.lupe&&state.measureMode)toggleMeasureMode();
  const scroll=document.getElementById('canvasScroll');
  const ml=document.getElementById('markerLayer');
  if(scroll)scroll.style.cursor=state.lupe?'crosshair':'';
  if(ml)ml.style.pointerEvents=state.lupe?'none':''; // damit Lupe-Drag durchkommt
}
function setupLupe(){
  const scroll=document.getElementById('canvasScroll');
  const stage=document.getElementById('canvasStage');
  const rectEl=document.getElementById('lupeRect');
  if(!scroll||!stage||!rectEl)return;
  let startX,startY,dragging=false;
  const stagePos=e=>{const r=stage.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};};
  stage.addEventListener('mousedown',e=>{
    if(!state.lupe)return;
    e.preventDefault();
    const p=stagePos(e);startX=p.x;startY=p.y;dragging=true;
    rectEl.classList.remove('hidden');
    rectEl.style.left=startX+'px';rectEl.style.top=startY+'px';rectEl.style.width='0px';rectEl.style.height='0px';
  });
  window.addEventListener('mousemove',e=>{
    if(!dragging)return;
    const p=stagePos(e);
    const x=Math.min(p.x,startX),y=Math.min(p.y,startY),w=Math.abs(p.x-startX),h=Math.abs(p.y-startY);
    rectEl.style.left=x+'px';rectEl.style.top=y+'px';rectEl.style.width=w+'px';rectEl.style.height=h+'px';
  });
  window.addEventListener('mouseup',e=>{
    if(!dragging)return;dragging=false;
    rectEl.classList.add('hidden');
    if(!state.viewport)return;
    const p=stagePos(e);
    const x=Math.min(p.x,startX),y=Math.min(p.y,startY),w=Math.abs(p.x-startX),h=Math.abs(p.y-startY);
    if(w<20||h<20){return;} // zu klein → ignorieren
    // relative Region (0..1) auf dem aktuellen Plan
    const rx=x/state.viewport.width, ry=y/state.viewport.height;
    const rw=w/state.viewport.width, rh=h/state.viewport.height;
    // Zielzoom: so dass die Auswahl den sichtbaren Bereich füllt
    const factorW=scroll.clientWidth/(w), factorH=scroll.clientHeight/(h);
    const target=state.zoom*Math.min(factorW,factorH);
    state.zoom=Math.min(Math.max(target,0.4),6);
    renderPage().then(()=>{
      if(state.viewport){
        // Auswahl-Mitte zentrieren
        const cx=(rx+rw/2)*state.viewport.width, cy=(ry+rh/2)*state.viewport.height;
        scroll.scrollLeft=cx-scroll.clientWidth/2;
        scroll.scrollTop=cy-scroll.clientHeight/2;
      }
    });
    toggleLupe(); // Lupe nach Gebrauch wieder aus
  });
}

async function renderPlanList(){
  let plans=await byProject('plans');
  const list=document.getElementById('planList');
  if(!list)return;
  if(!plans.length){list.innerHTML=`<div style="padding:24px 14px;text-align:center;color:var(--muted);font-size:12.5px">Noch keine Pläne.</div>`;return;}
  // Beschädigte Datensätze reparieren (z.B. aus einem abgebrochenen früheren Upload) und speichern
  let repaired=false;
  plans.forEach(p=>{ _normalizePlan(p); if(p._repaired){repaired=true;delete p._repaired;} });
  if(repaired){ for(const p of plans) await put('plans',p); toast('Ein beschädigter Plan-Eintrag wurde repariert.'); }
  // sortIndex sicherstellen (für Altdaten ohne Index)
  let changed=false;
  plans.forEach((p,i)=>{if(p.sortIndex==null){p.sortIndex=i+1;changed=true;}});
  if(changed){for(const p of plans)await put('plans',p);}
  plans.sort((a,b)=>(a.sortIndex||0)-(b.sortIndex||0));
  const defs=await byProject('defects');
  list.innerHTML=plans.map((p,i)=>{
    const c=defs.filter(d=>d.planId===p.id).length;
    const cur=p.versions.find(v=>v.v===p.currentVersion);
    return `<div class="plan-item ${p.id===state.planId?'active':''}" data-plan="${p.id}" draggable="true">
      <span class="plan-drag" title="Zum Sortieren ziehen">⠿</span>
      <div class="plan-thumb" id="thumb-${p.id}">PDF</div>
      <div class="plan-meta"><div class="pn">${esc(p.name)}</div>
        <div class="pv">${esc(cur?cur.fileName:'')} · <span class="ver-badge">v${p.currentVersion}</span></div>
        ${c?`<div class="pcount">● ${c} ${c===1?'Mangel':'Mängel'}</div>`:''}</div>
      <div class="plan-actions">
        <button class="plan-move" data-up="${p.id}" title="Nach oben" ${i===0?'disabled':''}>▲</button>
        <button class="plan-move" data-down="${p.id}" title="Nach unten" ${i===plans.length-1?'disabled':''}>▼</button>
        <button class="plan-del" data-del="${p.id}" title="Plan löschen">×</button>
      </div></div>`;
  }).join('');
  list.querySelectorAll('.plan-item').forEach(el=>el.onclick=e=>{
    if(e.target.closest('.plan-del,.plan-move,.plan-drag'))return;
    openPlan(el.dataset.plan);
  });
  list.querySelectorAll('.plan-del').forEach(b=>b.onclick=e=>{e.stopPropagation();deletePlan(b.dataset.del);});
  list.querySelectorAll('[data-up]').forEach(b=>b.onclick=e=>{e.stopPropagation();movePlan(b.dataset.up,-1);});
  list.querySelectorAll('[data-down]').forEach(b=>b.onclick=e=>{e.stopPropagation();movePlan(b.dataset.down,1);});
  setupPlanDnD(list);
  plans.forEach(renderThumb);
}

// Plan in der Reihenfolge verschieben (Pfeile)
async function movePlan(id,dir){
  let plans=(await byProject('plans')).sort((a,b)=>(a.sortIndex||0)-(b.sortIndex||0));
  const idx=plans.findIndex(p=>p.id===id);
  const swap=idx+dir;
  if(swap<0||swap>=plans.length)return;
  [plans[idx],plans[swap]]=[plans[swap],plans[idx]];
  await persistPlanOrder(plans);
  await renderPlanList();
}
// Neue Reihenfolge speichern
async function persistPlanOrder(orderedPlans){
  for(let i=0;i<orderedPlans.length;i++){
    const p=orderedPlans[i];
    if(p.sortIndex!==i+1){p.sortIndex=i+1;await put('plans',p);}
  }
}
// Drag & Drop Sortierung
function setupPlanDnD(list){
  let dragId=null;
  list.querySelectorAll('.plan-item').forEach(el=>{
    el.addEventListener('dragstart',e=>{dragId=el.dataset.plan;el.style.opacity='0.4';e.dataTransfer.effectAllowed='move';});
    el.addEventListener('dragend',()=>{el.style.opacity='';list.querySelectorAll('.plan-item').forEach(x=>x.classList.remove('drop-above','drop-below'));});
    el.addEventListener('dragover',e=>{
      e.preventDefault();
      const r=el.getBoundingClientRect();const after=(e.clientY-r.top)>r.height/2;
      list.querySelectorAll('.plan-item').forEach(x=>x.classList.remove('drop-above','drop-below'));
      el.classList.add(after?'drop-below':'drop-above');
    });
    el.addEventListener('drop',async e=>{
      e.preventDefault();
      const targetId=el.dataset.plan;
      el.classList.remove('drop-above','drop-below');
      if(!dragId||dragId===targetId)return;
      let plans=(await byProject('plans')).sort((a,b)=>(a.sortIndex||0)-(b.sortIndex||0));
      const from=plans.findIndex(p=>p.id===dragId);
      const moved=plans.splice(from,1)[0];
      let to=plans.findIndex(p=>p.id===targetId);
      const r=el.getBoundingClientRect();const after=(e.clientY-r.top)>r.height/2;
      if(after)to+=1;
      plans.splice(to,0,moved);
      await persistPlanOrder(plans);
      await renderPlanList();
    });
  });
}
async function renderThumb(p){
  const el=document.getElementById('thumb-'+p.id);if(!el)return;
  try{
    const cur=p.versions.find(v=>v.v===p.currentVersion);
    const src=pdfSourceFor(cur); if(!src)return;
    const doc=await pdfjsLib.getDocument(src).promise;
    const page=await doc.getPage(1);const vp=page.getViewport({scale:.18});
    const cv=document.createElement('canvas');cv.width=vp.width;cv.height=vp.height;
    await page.render({canvasContext:cv.getContext('2d'),viewport:vp}).promise;
    el.innerHTML='';el.appendChild(cv);
  }catch(e){}
}

async function deletePlan(id){
  const plan=await get('plans',id);
  if(!plan)return;
  const marks=(await byProject('defects')).filter(d=>d.planId===id);
  const warn=marks.length
    ? `Plan „${plan.name}" und die ${marks.length} darauf gesetzten ${marks.length===1?'Mangel-Marker':'Mangel-Marker'} unwiderruflich löschen?`
    : `Plan „${plan.name}" wirklich löschen?`;
  if(!confirm(warn))return;
  // zugehörige Mängel mitlöschen
  for(const d of marks)await del('defects',d.id);
  await del('plans',id);
  if(state.planId===id){
    state.planId=null;state.defectId=null;state.pdfDoc=null;closeDrawer();
    const tb=document.getElementById('vToolbar'), cs=document.getElementById('canvasScroll'), pe=document.getElementById('planEmpty');
    if(tb)tb.classList.add('hidden');
    if(cs)cs.classList.add('hidden');
    if(pe)pe.classList.remove('hidden');
  }
  await renderPlanList();await renderRail();
  toast('Plan gelöscht');
}

document.getElementById('planFileInput').onchange=async e=>{
  const files=[...e.target.files].filter(f=>f);
  if(!files.length)return;
  try{
    // höchsten bestehenden sortIndex ermitteln
    const existing=await byProject('plans');
    let maxSort=existing.reduce((m,p)=>Math.max(m,(p.sortIndex??0)),0);
    let firstId=null;
    for(const f of files){
      const b64=await fileToB64(f);
      maxSort+=1;
      const plan={id:uid(),projectId:state.projectId,name:f.name.replace(/\.pdf$/i,''),currentVersion:1,sortIndex:maxSort,
        versions:[{v:1,fileName:f.name,pdfData:b64,uploadedAt:nowISO(),uploadedBy:CURRENT_USER.name}]};
      await put('plans',plan);
      if(!firstId)firstId=plan.id;
    }
    toast(files.length===1?'Plan hochgeladen':files.length+' Pläne hochgeladen',true);
    await renderPlanList();
    if(firstId)openPlan(firstId);
  }catch(err){
    console.error('[Plan-Upload]',err);
    toast('Hochladen fehlgeschlagen: '+(err.message||'unbekannter Fehler'),false,true);
  }finally{
    e.target.value='';
  }
};
document.getElementById('updateFileInput').onchange=async e=>{
  const f=e.target.files[0];if(!f||!state.planId)return;
  try{
    const plan=await get('plans',state.planId);if(!plan)throw new Error('Plan nicht gefunden');
    _normalizePlan(plan);
    const b64=await fileToB64(f);
    const newV=plan.currentVersion+1;
    plan.versions.push({v:newV,fileName:f.name,pdfData:b64,uploadedAt:nowISO(),uploadedBy:CURRENT_USER.name});
    plan.currentVersion=newV;await put('plans',plan);
    const planDefs=(await byProject('defects')).filter(d=>d.planId===plan.id);
    // Planausschnitte für alle Marker auf neuer Version neu erzeugen
    for(const d of planDefs){d.excerpt=await cropPlanAround(plan,d.rx,d.ry,d.num,d.status);await put('defects',d);}
    toast(`Plan auf v${newV} aktualisiert · ${planDefs.length} Marker erhalten`,true);
    state.version=newV;await renderPlanList();await loadPlanRender();
  }catch(err){
    console.error('[Plan-Aktualisierung]',err);
    toast('Aktualisieren fehlgeschlagen: '+(err.message||'unbekannter Fehler'),false,true);
  }finally{
    e.target.value='';
  }
};

async function openPlan(id){
  state.planId=id;state.defectId=null;state.zoom=1;state._pendingZoom=null;closeDrawer();
  if(_sharpTimer){clearTimeout(_sharpTimer);_sharpTimer=null;}
  const _st=document.getElementById('canvasStage');if(_st)_st.style.transform='';
  if(state.lupe)toggleLupe();
  _measureP1=null;_measureP2=null; // Messung gilt nur pro Plan, nicht planübergreifend
  const plan=await get('plans',id);if(!plan){toast('Plan nicht gefunden');return;}
  _normalizePlan(plan);state.version=plan.currentVersion;
  document.getElementById('planEmpty').classList.add('hidden');
  document.getElementById('vToolbar').classList.remove('hidden');
  document.getElementById('canvasScroll').classList.remove('hidden');
  await renderPlanList();await loadPlanRender();
  if(state.measureMode)await _measureLoadScale();
}
async function loadPlanRender(){
  const plan=await get('plans',state.planId);
  if(!plan){toast('Plan nicht gefunden');return;}
  _normalizePlan(plan);
  const ver=plan.versions.find(v=>v.v===state.version)||plan.versions.find(v=>v.v===plan.currentVersion);
  const titleEl=document.getElementById('vtTitle');
  if(titleEl)titleEl.innerHTML=`${esc(plan.name)} <span class="ver">v${ver.v} · ${esc(ver.fileName)}</span>`;
  const src=pdfSourceFor(ver);
  if(!src){toast('Plan-Datei nicht verfügbar (weder lokal noch in der Cloud gefunden – bitte Plan erneut hochladen)',false,true);return;}
  try{ state.pdfDoc=await pdfjsLib.getDocument(src).promise; }
  catch(e){ toast('Plan konnte nicht geladen werden: '+e.message,false,true); return; }
  await renderPage();buildVerMenu(plan);
}
let _rendering=false, _renderQueued=false;
async function renderPage(){
  if(_rendering){_renderQueued=true;return;} // kein paralleles Rendern
  _rendering=true;
  try{ await _renderPageInner(); }
  finally{
    _rendering=false;
    if(_renderQueued){_renderQueued=false;await renderPage();}
  }
}
// Rendert die PDF-Seite in ein UNSICHTBARES Canvas (kein Flackern/Springen sichtbar,
// da das echte Canvas erst berührt wird, wenn der neue Inhalt komplett fertig ist).
async function _computePlanRender(){
  const scroll=document.getElementById('canvasScroll');
  if(!scroll||!state.pdfDoc)return null;
  const page=await state.pdfDoc.getPage(1);
  const baseVp=page.getViewport({scale:1});
  state.baseVpWidth=baseVp.width;state.baseVpHeight=baseVp.height; // PDF-Punkte bei scale=1 = reale Papiergrösse (für Massstabsmessung, zoom-unabhängig)
  const cw=(scroll.clientWidth||900)-60;
  const scale=Math.min(cw/baseVp.width,1.6)*state.zoom;
  const vp=page.getViewport({scale});
  const off=document.createElement('canvas');off.width=vp.width;off.height=vp.height;
  await page.render({canvasContext:off.getContext('2d'),viewport:vp}).promise;
  return {vp,off};
}
// Schaltet das fertige Ergebnis in EINEM synchronen Schritt sichtbar (kein Zwischenzustand).
function _applyPlanRender(result){
  if(!result)return;
  const {vp,off}=result;
  state.viewport=vp;
  const cv=document.getElementById('pdfCanvas');
  cv.width=vp.width;cv.height=vp.height;
  cv.getContext('2d').drawImage(off,0,0);
  const stage=document.getElementById('canvasStage');stage.style.width=vp.width+'px';stage.style.height=vp.height+'px';
  const ml=document.getElementById('markerLayer');ml.style.width=vp.width+'px';ml.style.height=vp.height+'px';
  closeMarkerPopup(); // Position würde sonst nach Zoom/Neurendern nicht mehr stimmen
}
async function _renderPageInner(){
  const result=await _computePlanRender();
  if(!result)return;
  _applyPlanRender(result);
  await renderMarkers();
  await _ensureDrawCache();
  renderDrawings();
  renderMeasure();
  const zl=document.getElementById('zoomLabel');if(zl)zl.textContent=Math.round(state.zoom*100)+'%';
}
/* ---------- Planausschnitt rund um einen Marker erzeugen (für Listen-Übersicht) ---------- */
async function cropPlanAround(plan, rx, ry, num, status){
  try{
    if(!plan)return null;
    _normalizePlan(plan);
    const ver=plan.versions.find(v=>v.v===plan.currentVersion);
    const src=pdfSourceFor(ver); if(!src)return null;
    const doc=await pdfjsLib.getDocument(src).promise;
    const page=await doc.getPage(1);
    // hochauflösend rendern für scharfen Ausschnitt
    const base=page.getViewport({scale:1});
    const scale=Math.min(2200/base.width,3); // genug Auflösung, gedeckelt
    const vp=page.getViewport({scale});
    const full=document.createElement('canvas');full.width=vp.width;full.height=vp.height;
    await page.render({canvasContext:full.getContext('2d'),viewport:vp}).promise;
    // Ausschnittgrösse: ~24% der Planbreite rund um den Marker (enger = Mangel besser sichtbar)
    const cropW=Math.min(vp.width,vp.height)*0.24;
    const cx=rx*vp.width, cy=ry*vp.height;
    let sx=cx-cropW/2, sy=cy-cropW/2;
    sx=Math.max(0,Math.min(sx,vp.width-cropW));
    sy=Math.max(0,Math.min(sy,vp.height-cropW));
    const out=document.createElement('canvas');const OUT=480;out.width=OUT;out.height=OUT;
    const ctx=out.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,OUT,OUT);
    ctx.drawImage(full,sx,sy,cropW,cropW,0,0,OUT,OUT);
    // Marker-Pin einzeichnen (Position des Markers im Ausschnitt)
    const mx=(cx-sx)/cropW*OUT, my=(cy-sy)/cropW*OUT;
    const color=status==='In Arbeit'?'#b8860b':status==='Erledigt'?'#2f7d54':'#a8392a';
    ctx.save();
    const pinH=44,pinW=34;
    ctx.translate(mx,my);
    ctx.beginPath();
    // Tropfenform
    ctx.moveTo(0,0);
    ctx.bezierCurveTo(-pinW/2,-pinH*0.55,-pinW/2,-pinH,0,-pinH);
    ctx.bezierCurveTo(pinW/2,-pinH,pinW/2,-pinH*0.55,0,0);
    ctx.fillStyle=color;ctx.fill();
    ctx.beginPath();ctx.arc(0,-pinH*0.66,pinW*0.28,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();
    ctx.fillStyle=color;ctx.font='bold 15px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText(String(num),0,-pinH*0.66);
    ctx.restore();
    return out.toDataURL('image/jpeg',0.82);
  }catch(e){return null;}
}

async function renderMarkers(){
  const layer=document.getElementById('markerLayer');if(!layer||!state.viewport)return;
  const defs=(await byProject('defects')).filter(d=>d.planId===state.planId);
  const w=state.viewport.width,h=state.viewport.height;
  layer.innerHTML=defs.map(d=>{
    const color=d.status==='Offen'?'#c8481c':d.status==='In Arbeit'?'#b8860b':'#2f7d54';
    return `<div class="marker ${d.id===state.defectId?'sel':''}" data-def="${d.id}" style="left:${d.rx*w}px;top:${d.ry*h}px">
      <svg viewBox="0 0 30 38"><path d="M15 0C6.7 0 0 6.7 0 15c0 10 15 23 15 23s15-13 15-23C30 6.7 23.3 0 15 0z" fill="${color}"/><circle cx="15" cy="15" r="10" fill="rgba(255,255,255,.25)"/></svg>
      <span class="mlabel">${d.num}</span></div>`;
  }).join('');
  layer.querySelectorAll('.marker').forEach(el=>el.onclick=ev=>{ev.stopPropagation();showMarkerPopup(el.dataset.def,el);});
}
// Kompaktes Vorschau-Popup direkt am Marker (Foto, Kurztext, Auftrag, Unternehmer) –
// öffnet erst auf Wunsch den vollständigen Bearbeiten-Dialog.
function closeMarkerPopup(){const p=document.getElementById('markerPopup');if(p)p.remove();}
async function showMarkerPopup(id,el){
  closeMarkerPopup();
  const d=await get('defects',id);if(!d)return;
  const stage=document.getElementById('canvasStage');if(!stage)return;
  const color=d.status==='Offen'?'var(--brand-red)':d.status==='In Arbeit'?'#b8860b':'#2f7d54';
  const left=el.style.left,top=el.style.top;
  const pop=document.createElement('div');
  pop.id='markerPopup';pop.className='marker-popup';
  pop.style.left=left;pop.style.top=top;
  const loc=[d.floor,d.room].filter(Boolean).join(' · ');
  pop.innerHTML=`
    <div class="mp-head" style="background:${color}">
      <span>#${String(d.num).padStart(3,'0')} ${esc(d.status)}</span>
      <button class="mp-close" type="button">×</button>
    </div>
    <div class="mp-body">
      ${(d.photos&&d.photos[0])?`<img class="mp-photo" src="${d.photos[0]}">`:''}
      <div class="mp-title">${esc(d.title||'(ohne Titel)')}</div>
      ${loc?`<div class="mp-row">📍 ${esc(loc)}</div>`:''}
      ${d.trade?`<div class="mp-row">🔧 ${esc(d.trade)}</div>`:''}
      ${d.assignee?`<div class="mp-row">👤 ${esc(d.assignee)}</div>`:''}
      ${d.due?`<div class="mp-row">📅 Termin: ${fmtDate(d.due)}</div>`:''}
      <button class="btn btn-primary btn-sm mp-open" type="button" style="width:100%;margin-top:8px">Details öffnen</button>
    </div>`;
  stage.appendChild(pop);
  pop.querySelector('.mp-close').onclick=e=>{e.stopPropagation();closeMarkerPopup();};
  pop.querySelector('.mp-open').onclick=e=>{e.stopPropagation();closeMarkerPopup();selectDefect(id);};
  pop.onclick=e=>e.stopPropagation();
  // Popup schliessen, wenn irgendwo anders geklickt wird
  setTimeout(()=>document.addEventListener('click',closeMarkerPopup,{once:true}),0);
}
function toggleArm(){
  state.armed=!state.armed;
  document.getElementById('markerBtn').classList.toggle('armed',state.armed);
  document.getElementById('armedHint').classList.toggle('hidden',!state.armed);
  if(state.armed&&state.lupe)toggleLupe(); // Lupe aus, wenn Marker-Modus an
  if(state.armed&&state.drawMode)toggleDrawMode(); // Zeichnen aus, wenn Marker-Modus an
  if(state.armed&&state.measureMode)toggleMeasureMode();
}

/* ============================================================
   ZEICHNEN AUF PLÄNEN (Freihand, Formen, Farben, Verschieben, Radieren)
   Daten liegen normalisiert (0..1, wie Marker) auf dem Plan-Objekt: plan.drawings
   ============================================================ */
let _drawTool='pen', _drawColor='#d32f2f', _drawWidth=3, _drawOpacity=1;
let _drawing=null;      // aktuell gezeichnete Form (im Aufbau)
let _drawUndoStack=[];  // für Rückgängig (Snapshot vor jeder Änderung)
let _drawSelected=null; // ausgewählte Form-id (Verschieben-Werkzeug)
let _dragStart=null;
// Zwischenspeicher der Zeichnungen des GERADE OFFENEN Plans. Während des Zeichnens/Verschiebens
// wird NUR dieser Speicher gelesen/verändert (nie die Datenbank) – das verhindert das Flackern,
// das durch überholende asynchrone Datenbank-Lesevorgänge bei schnellen Mausbewegungen entstand.
let _drawCache=null, _drawCachePlanId=null, _drawSaveTimer=null;
async function _ensureDrawCache(){
  if(_drawCachePlanId===state.planId && _drawCache)return _drawCache;
  const plan=await get('plans',state.planId);
  _drawCache=(plan&&plan.drawings)?JSON.parse(JSON.stringify(plan.drawings)):[];
  _drawCachePlanId=state.planId;
  return _drawCache;
}
// Speichert den Zwischenspeicher in die Datenbank (leicht verzögert gebündelt, damit schnelle
// Änderungsfolgen – z.B. Verschieben – nicht bei jedem Mausschritt einen Schreibvorgang auslösen).
function _scheduleDrawSave(immediate){
  clearTimeout(_drawSaveTimer);
  const doSave=async()=>{
    const planId=_drawCachePlanId;if(!planId)return;
    const plan=await get('plans',planId);if(!plan)return;
    plan.drawings=_drawCache;
    if(immediate) await put('plans',plan); else await putLocal('plans',plan); // Zwischenstände nur lokal, Cloud erst am Ende
  };
  if(immediate){doSave();}else{_drawSaveTimer=setTimeout(doSave,250);}
}
function toggleDrawMode(){
  state.drawMode=!state.drawMode;
  const btn=document.getElementById('drawBtn');if(btn)btn.classList.toggle('armed',state.drawMode);
  const tb=document.getElementById('drawToolbar');if(tb)tb.classList.toggle('hidden',!state.drawMode);
  const dc=document.getElementById('drawCanvas');if(dc)dc.style.pointerEvents=state.drawMode?'auto':'none';
  const ml=document.getElementById('markerLayer');if(ml)ml.style.pointerEvents=state.drawMode?'none':''; // Marker-Ebene beim Zeichnen durchlässig machen
  if(state.drawMode){
    if(state.armed)toggleArm();
    if(state.lupe)toggleLupe();
    if(state.measureMode)toggleMeasureMode();
    _ensureDrawCache().then(()=>renderDrawings());
  }else{
    _drawSelected=null;
    _scheduleDrawSave(true); // beim Verlassen des Zeichnen-Modus sicher final speichern (inkl. Cloud)
    renderDrawings();
  }
}

/* ============================================================
   MASSSTABS-MESSWERKZEUG
   ------------------------------------------------------------
   Misst Distanzen zwischen zwei Punkten anhand des eingestellten
   Planmassstabs (z.B. 1:100). Die Berechnung basiert auf der
   PHYSISCHEN Seitengrösse der PDF (state.baseVpWidth/Height, in
   PDF-Punkten bei scale=1) – diese ändert sich NIE mit dem Zoom,
   daher bleibt das Verhältnis beim Herein-/Herauszoomen exakt
   erhalten ("bleibt im Zoom erhalten"). Der Massstab wird pro
   Plan gespeichert ("heftet sich automatisch an").
   ============================================================ */
let _measureP1=null, _measureP2=null, _measureDragging=false;
function toggleMeasureMode(){
  state.measureMode=!state.measureMode;
  const btn=document.getElementById('measureBtn');if(btn)btn.classList.toggle('armed',state.measureMode);
  const tb=document.getElementById('measureToolbar');if(tb)tb.classList.toggle('hidden',!state.measureMode);
  const mc=document.getElementById('measureCanvas');if(mc)mc.style.pointerEvents=state.measureMode?'auto':'none';
  const ml=document.getElementById('markerLayer');if(ml&&state.measureMode)ml.style.pointerEvents='none';
  if(state.measureMode){
    if(state.armed)toggleArm();
    if(state.lupe)toggleLupe();
    if(state.drawMode)toggleDrawMode();
    _measureLoadScale();
  }else{
    _measureP1=null;_measureP2=null;renderMeasure();
  }
}
async function _measureLoadScale(){
  const plan=await get('plans',state.planId);
  const scale=(plan&&plan.scale)||100;
  const sel=document.getElementById('measureScale');
  if(!sel)return;
  const known=[...sel.options].some(o=>o.value===String(scale));
  if(known){ sel.value=String(scale); document.getElementById('measureScaleCustom').style.display='none'; }
  else{ sel.value='__custom'; const ci=document.getElementById('measureScaleCustom'); ci.style.display='';ci.value=scale; }
  updateMeasureResult();
}
function _currentMeasureScale(){
  const sel=document.getElementById('measureScale');
  if(!sel)return 100;
  if(sel.value==='__custom'){ const v=+document.getElementById('measureScaleCustom').value; return v>0?v:100; }
  return +sel.value;
}
async function _measureSaveScale(){
  const plan=await get('plans',state.planId);if(!plan)return;
  plan.scale=_currentMeasureScale();
  await put('plans',plan); // heftet den Massstab dauerhaft an diesen Plan an
}
function setupMeasureTool(){
  const sel=document.getElementById('measureScale');
  const custom=document.getElementById('measureScaleCustom');
  sel.onchange=()=>{ custom.style.display=sel.value==='__custom'?'':'none'; updateMeasureResult(); _measureSaveScale(); };
  custom.oninput=()=>{ updateMeasureResult(); _measureSaveScale(); };
  document.getElementById('measureClear').onclick=()=>{ _measureP1=null;_measureP2=null;renderMeasure();updateMeasureResult(); };
  document.getElementById('measureDone').onclick=toggleMeasureMode;
  const mc=document.getElementById('measureCanvas');
  mc.addEventListener('pointerdown',ev=>{
    if(!state.measureMode)return; ev.preventDefault();
    _measureP1=planCoords(ev);_measureP2=_measureP1;_measureDragging=true;
    try{mc.setPointerCapture(ev.pointerId);}catch(e){}
    renderMeasure();updateMeasureResult();
  });
  mc.addEventListener('pointermove',ev=>{
    if(!state.measureMode||!_measureDragging)return;
    _measureP2=planCoords(ev);renderMeasure();updateMeasureResult();
  });
  window.addEventListener('pointerup',()=>{ if(_measureDragging){_measureDragging=false;} });
}
// Rechnet die reale Distanz zweier normalisierter (0..1) Punkte anhand des Massstabs.
function _measureDistanceM(p1,p2){
  const pw=state.baseVpWidth, ph=state.baseVpHeight;
  if(!pw||!ph||!p1||!p2)return 0;
  // PDF-Punkte -> mm (1pt = 25.4/72 mm), normalisierte Differenz auf reale Papiergrösse skalieren
  const dxMM=Math.abs(p2.x-p1.x)*pw*(25.4/72);
  const dyMM=Math.abs(p2.y-p1.y)*ph*(25.4/72);
  const distOnPaperMM=Math.hypot(dxMM,dyMM);
  const scaleN=_currentMeasureScale();
  return (distOnPaperMM*scaleN)/1000; // mm real -> m
}
function updateMeasureResult(){
  const el=document.getElementById('measureResult');if(!el)return;
  if(!_measureP1||!_measureP2){ el.textContent='Zwei Punkte anklicken und ziehen, um zu messen.'; return; }
  const m=_measureDistanceM(_measureP1,_measureP2);
  el.textContent=`Distanz: ${m<1?(m*100).toFixed(1)+' cm':m.toFixed(2)+' m'}  ·  Massstab 1:${_currentMeasureScale()}`;
}
// Zeichnet die aktuelle Messlinie – wird auch nach Zoom/Neurendern erneut aufgerufen,
// damit die Linie am exakt gleichen Planpunkt bleibt (nicht an der Bildschirmposition).
function renderMeasure(){
  const mc=document.getElementById('measureCanvas');if(!mc||!state.viewport)return;
  const w=state.viewport.width,h=state.viewport.height;
  if(mc.width!==w||mc.height!==h){mc.width=w;mc.height=h;}
  const ctx=mc.getContext('2d');
  ctx.clearRect(0,0,w,h);
  if(!_measureP1||!_measureP2)return;
  const x1=_measureP1.x*w,y1=_measureP1.y*h,x2=_measureP2.x*w,y2=_measureP2.y*h;
  ctx.save();
  ctx.strokeStyle='#1f6fb2';ctx.fillStyle='#1f6fb2';ctx.lineWidth=2;ctx.lineCap='round';
  ctx.setLineDash([7,5]);
  ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
  ctx.setLineDash([]);
  [[x1,y1],[x2,y2]].forEach(([x,y])=>{ ctx.beginPath();ctx.arc(x,y,4.5,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x,y,4.5,0,Math.PI*2);ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.stroke(); });
  // Distanz-Label mittig auf der Linie
  const mx=(x1+x2)/2, my=(y1+y2)/2;
  const m=_measureDistanceM(_measureP1,_measureP2);
  const label=m<1?(m*100).toFixed(1)+' cm':m.toFixed(2)+' m';
  ctx.font='bold 13px sans-serif';
  const tw=ctx.measureText(label).width;
  ctx.fillStyle='#1f6fb2';ctx.fillRect(mx-tw/2-5,my-19,tw+10,18);
  ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(label,mx,my-10);
  ctx.restore();
}
function setupDrawTools(){
  document.querySelectorAll('.dt-tool').forEach(b=>b.onclick=()=>{
    document.querySelectorAll('.dt-tool').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');_drawTool=b.dataset.tool;_drawSelected=null;
    // sinnvolle Voreinstellung für den Textmarker (breiter, halbtransparent) – bleibt einstellbar
    if(_drawTool==='highlight'){
      _drawWidth=Math.max(_drawWidth,14);
      _drawOpacity=Math.min(_drawOpacity,0.35)||0.35;
      const dw=document.getElementById('dtWidth');if(dw)dw.value=_drawWidth;
      const doEl=document.getElementById('dtOpacity');if(doEl){doEl.value=Math.round(_drawOpacity*100);document.getElementById('dtOpacityLabel').textContent=Math.round(_drawOpacity*100)+'%';}
    }
    renderDrawings();
  });
  document.querySelectorAll('.dt-color').forEach(b=>b.onclick=()=>{
    document.querySelectorAll('.dt-color').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');_drawColor=b.dataset.color;
    if(_drawSelected)applyStyleToSelected();
  });
  const cc=document.getElementById('dtCustomColor');
  if(cc)cc.oninput=()=>{_drawColor=cc.value;document.querySelectorAll('.dt-color').forEach(x=>x.classList.remove('active'));if(_drawSelected)applyStyleToSelected();};
  const dw=document.getElementById('dtWidth');
  if(dw)dw.oninput=()=>{_drawWidth=+dw.value;if(_drawSelected)applyStyleToSelected();};
  const doEl=document.getElementById('dtOpacity');
  if(doEl)doEl.oninput=()=>{
    _drawOpacity=(+doEl.value)/100;
    document.getElementById('dtOpacityLabel').textContent=doEl.value+'%';
    if(_drawSelected)applyStyleToSelected();
  };
  document.getElementById('dtUndo').onclick=undoDraw;
  document.getElementById('dtClear').onclick=clearAllDrawings;
  document.getElementById('dtDone').onclick=toggleDrawMode;
  const dc=document.getElementById('drawCanvas');
  dc.addEventListener('pointerdown',drawPointerDown);
  dc.addEventListener('pointermove',drawPointerMove);
  window.addEventListener('pointerup',drawPointerUp);
  dc.addEventListener('dblclick',ev=>{
    if(!state.drawMode||!_drawCache||_drawTool!=='select')return; // Text-Werkzeug behandelt Bearbeiten bereits selbst per Klick
    const p=planCoords(ev);
    for(let i=_drawCache.length-1;i>=0;i--){
      if(_drawCache[i].type==='text'&&shapeHit(_drawCache[i],p)){openTextInput(null,_drawCache[i]);return;}
    }
  });
  document.addEventListener('keydown',e=>{
    if(!state.drawMode)return;
    if((e.key==='Delete'||e.key==='Backspace')&&_drawSelected&&document.activeElement.tagName!=='INPUT'){e.preventDefault();deleteSelectedDrawing();}
  });
}
function applyStyleToSelected(){
  if(!_drawCache)return;
  const sh=_drawCache.find(s=>s.id===_drawSelected);if(!sh)return;
  sh.color=_drawColor;sh.width=_drawWidth;sh.opacity=_drawOpacity;
  _scheduleDrawSave();renderDrawings();
}
function planCoords(ev){
  const dc=document.getElementById('drawCanvas');const r=dc.getBoundingClientRect();
  const x=(ev.clientX-r.left)/r.width, y=(ev.clientY-r.top)/r.height;
  return {x:Math.min(1,Math.max(0,x)), y:Math.min(1,Math.max(0,y))};
}
function drawPointerDown(ev){
  if(!state.drawMode||!_drawCache)return; ev.preventDefault();
  const p=planCoords(ev);
  if(_drawTool==='select'){
    hitTestSelect(p);_dragStart=p;return;
  }
  if(_drawTool==='erase'){
    eraseAt(p);return;
  }
  if(_drawTool==='text'){
    const hit=_drawCache.slice().reverse().find(s=>s.type==='text'&&shapeHit(s,p));
    openTextInput(hit?null:p,hit||null);return;
  }
  _drawing={id:uid(),type:_drawTool,color:_drawColor,width:_drawWidth,opacity:_drawOpacity,points:[p]};
  if(_drawTool==='pen'||_drawTool==='highlight')dc_capture(ev);
}
function dc_capture(ev){try{document.getElementById('drawCanvas').setPointerCapture(ev.pointerId);}catch(e){}}
function drawPointerMove(ev){
  if(!state.drawMode||!_drawCache)return;
  if(_drawTool==='select'&&_drawSelected&&_dragStart){
    const p=planCoords(ev);
    const dx=p.x-_dragStart.x, dy=p.y-_dragStart.y;
    _dragStart=p;
    moveSelected(dx,dy);
    return;
  }
  if(!_drawing)return;
  const p=planCoords(ev);
  if(_drawing.type==='pen'||_drawing.type==='highlight'){ _drawing.points.push(p); }
  else { _drawing.points[1]=p; } // Formen: Start + aktueller Endpunkt (Vorschau)
  renderDrawings(); // synchron, liest nur den Zwischenspeicher – kein Flackern
}
function drawPointerUp(ev){
  if(!state.drawMode||!_drawCache)return;
  if(_drawTool==='select'){_dragStart=null;if(_drawSelected)_scheduleDrawSave(true);return;}
  if(!_drawing)return;
  const isFreehand=_drawing.type==='pen'||_drawing.type==='highlight';
  if(!isFreehand && !_drawing.points[1]){_drawing=null;return;} // reines Klicken ohne Ziehen -> nichts anlegen
  if(isFreehand && _drawing.points.length<2){_drawing=null;return;}
  pushUndoSnapshot();
  _drawCache.push(_drawing);
  _drawing=null;
  _scheduleDrawSave(true);
  renderDrawings();
}
function moveSelected(dx,dy){
  if(!_drawCache)return;
  const sh=_drawCache.find(s=>s.id===_drawSelected);if(!sh)return;
  sh.points=sh.points.map(pt=>({x:Math.min(1,Math.max(0,pt.x+dx)),y:Math.min(1,Math.max(0,pt.y+dy))}));
  _scheduleDrawSave(); // während des Ziehens nur gebündelt/lokal – Cloud-Sync erst beim Loslassen
  renderDrawings();
}
function hitTestSelect(p){
  if(!_drawCache)return;
  for(let i=_drawCache.length-1;i>=0;i--){ // von oben (zuletzt gezeichnet) nach unten testen
    if(shapeHit(_drawCache[i],p)){_drawSelected=_drawCache[i].id;renderDrawings();return;}
  }
  _drawSelected=null;renderDrawings();
}
// Öffnet ein schwebendes Textfeld direkt auf dem Plan (neuer Vermerk, oder Bearbeiten bei existingShape)
function openTextInput(p,existingShape){
  const dc=document.getElementById('drawCanvas');if(!dc)return;
  const r=dc.getBoundingClientRect();
  const anchor=existingShape?existingShape.points[0]:p;
  const inp=document.createElement('textarea');
  inp.className='draw-text-input';
  inp.style.left=(r.left+anchor.x*r.width)+'px';
  inp.style.top=(r.top+anchor.y*r.height)+'px';
  inp.style.color=existingShape?existingShape.color:_drawColor;
  const fs=Math.max(12,(existingShape?existingShape.width:_drawWidth)*6*(r.width/dc.width));
  inp.style.fontSize=fs+'px';
  inp.value=existingShape?existingShape.text:'';
  inp.placeholder='Vermerk…';
  document.body.appendChild(inp);
  inp.focus();
  let done=false;
  const commit=()=>{
    if(done)return;done=true;
    const text=inp.value.trim();
    inp.remove();
    if(!text){ if(existingShape){pushUndoSnapshot();_drawCache=_drawCache.filter(s=>s.id!==existingShape.id);_scheduleDrawSave(true);renderDrawings();} return; }
    pushUndoSnapshot();
    if(existingShape){
      existingShape.text=text;existingShape.color=_drawColor;existingShape.width=_drawWidth;existingShape.opacity=_drawOpacity;
    }else{
      _drawCache.push({id:uid(),type:'text',points:[p],text,color:_drawColor,width:_drawWidth,opacity:_drawOpacity});
    }
    _scheduleDrawSave(true);renderDrawings();
  };
  inp.addEventListener('blur',commit);
  inp.addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();inp.blur();}
    if(e.key==='Escape'){e.preventDefault();inp.value=existingShape?existingShape.text:'';inp.blur();}
  });
}
function shapeHit(sh,p){
  const tol=0.015;
  if(sh.type==='rect'||sh.type==='ellipse'){
    const x0=Math.min(sh.points[0].x,sh.points[1].x)-tol, x1=Math.max(sh.points[0].x,sh.points[1].x)+tol;
    const y0=Math.min(sh.points[0].y,sh.points[1].y)-tol, y1=Math.max(sh.points[0].y,sh.points[1].y)+tol;
    return p.x>=x0&&p.x<=x1&&p.y>=y0&&p.y<=y1;
  }
  if(sh.type==='text'){
    const dc=document.getElementById('drawCanvas');
    const w=dc?dc.width:1000, h=dc?dc.height:1000;
    const lines=(sh.text||'').split('\n');
    const fs=(sh.width||3)*6;
    const boxW=Math.max(...lines.map(l=>l.length))*fs*0.55/w;
    const boxH=lines.length*fs*1.25/h;
    return p.x>=sh.points[0].x-0.005 && p.x<=sh.points[0].x+boxW && p.y>=sh.points[0].y-0.005 && p.y<=sh.points[0].y+boxH;
  }
  // Linie/Pfeil/Stift: Distanz zu Liniensegmenten prüfen
  const pts=sh.points;
  for(let i=0;i<pts.length-1;i++){
    if(distToSeg(p,pts[i],pts[i+1])<tol)return true;
  }
  return false;
}
function distToSeg(p,a,b){
  const dx=b.x-a.x,dy=b.y-a.y; const len2=dx*dx+dy*dy;
  if(len2===0)return Math.hypot(p.x-a.x,p.y-a.y);
  let t=((p.x-a.x)*dx+(p.y-a.y)*dy)/len2; t=Math.max(0,Math.min(1,t));
  const cx=a.x+t*dx, cy=a.y+t*dy;
  return Math.hypot(p.x-cx,p.y-cy);
}
function eraseAt(p){
  if(!_drawCache||!_drawCache.length)return;
  const idx=[...(_drawCache)].reverse().findIndex(s=>shapeHit(s,p));
  if(idx===-1)return;
  const realIdx=_drawCache.length-1-idx;
  pushUndoSnapshot();
  _drawCache.splice(realIdx,1);
  _scheduleDrawSave(true);renderDrawings();
}
function deleteSelectedDrawing(){
  if(!_drawSelected||!_drawCache)return;
  pushUndoSnapshot();
  _drawCache=_drawCache.filter(s=>s.id!==_drawSelected);
  _drawCachePlanId=state.planId; // Referenz bleibt gültig
  _drawSelected=null;
  _scheduleDrawSave(true);renderDrawings();
}
function pushUndoSnapshot(){
  _drawUndoStack.push(JSON.parse(JSON.stringify(_drawCache||[])));
  if(_drawUndoStack.length>25)_drawUndoStack.shift();
}
function undoDraw(){
  if(!_drawUndoStack.length){toast('Nichts rückgängig zu machen');return;}
  _drawCache=_drawUndoStack.pop();
  _drawSelected=null;
  _scheduleDrawSave(true);renderDrawings();
}
function clearAllDrawings(){
  if(!confirm('Alle Zeichnungen auf diesem Plan löschen? Dies kann nicht rückgängig gemacht werden (ausser mit „Rückgängig" direkt danach).'))return;
  pushUndoSnapshot();
  _drawCache=[];
  _scheduleDrawSave(true);renderDrawings();toast('Zeichnungen gelöscht',true);
}
// SYNCHRON – liest nur den Zwischenspeicher, keine Datenbankzugriffe während des Zeichnens.
// Das ist die eigentliche Behebung des Flacker-Bugs (vorher: async DB-Lesevorgänge liefen
// bei schnellen Mausbewegungen durcheinander und überschrieben sich gegenseitig).
function renderDrawings(){
  const dc=document.getElementById('drawCanvas');if(!dc||!state.viewport)return;
  const w=state.viewport.width,h=state.viewport.height;
  if(dc.width!==w||dc.height!==h){dc.width=w;dc.height=h;}
  const ctx=dc.getContext('2d');
  ctx.clearRect(0,0,w,h);
  const shapes=(_drawCachePlanId===state.planId&&_drawCache)?_drawCache:[];
  shapes.forEach(sh=>drawShape(ctx,sh,w,h,sh.id===_drawSelected));
  if(_drawing)drawShape(ctx,_drawing,w,h,false);
}
function drawShape(ctx,sh,w,h,selected,widthScale){
  widthScale=widthScale||1;
  ctx.save();
  ctx.globalAlpha=(sh.opacity!=null?sh.opacity:1);
  ctx.strokeStyle=sh.color;ctx.fillStyle=sh.color;ctx.lineWidth=sh.width*widthScale;ctx.lineCap='round';ctx.lineJoin='round';
  const P=sh.points.map(p=>({x:p.x*w,y:p.y*h}));
  if(sh.type==='pen'||sh.type==='highlight'){
    ctx.beginPath();P.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();
  }else if(sh.type==='line'){
    if(P[1]){ctx.beginPath();ctx.moveTo(P[0].x,P[0].y);ctx.lineTo(P[1].x,P[1].y);ctx.stroke();}
  }else if(sh.type==='arrow'){
    if(P[1]){
      ctx.beginPath();ctx.moveTo(P[0].x,P[0].y);ctx.lineTo(P[1].x,P[1].y);ctx.stroke();
      const ang=Math.atan2(P[1].y-P[0].y,P[1].x-P[0].x);const ah=(8+sh.width)*widthScale;
      ctx.beginPath();ctx.moveTo(P[1].x,P[1].y);
      ctx.lineTo(P[1].x-ah*Math.cos(ang-Math.PI/6),P[1].y-ah*Math.sin(ang-Math.PI/6));
      ctx.lineTo(P[1].x-ah*Math.cos(ang+Math.PI/6),P[1].y-ah*Math.sin(ang+Math.PI/6));
      ctx.closePath();ctx.fill();
    }
  }else if(sh.type==='rect'){
    if(P[1]){const x=Math.min(P[0].x,P[1].x),y=Math.min(P[0].y,P[1].y),ww=Math.abs(P[1].x-P[0].x),hh=Math.abs(P[1].y-P[0].y);ctx.strokeRect(x,y,ww,hh);}
  }else if(sh.type==='ellipse'){
    if(P[1]){const cx=(P[0].x+P[1].x)/2,cy=(P[0].y+P[1].y)/2,rx=Math.abs(P[1].x-P[0].x)/2,ry=Math.abs(P[1].y-P[0].y)/2;
      ctx.beginPath();ctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2);ctx.stroke();}
  }else if(sh.type==='text'){
    const fs=sh.width*6*widthScale;
    ctx.font='600 '+fs+'px sans-serif';ctx.textBaseline='top';ctx.fillStyle=sh.color;
    (sh.text||'').split('\n').forEach((line,i)=>ctx.fillText(line,P[0].x,P[0].y+i*fs*1.25));
  }
  if(selected){
    ctx.save();ctx.globalAlpha=1;ctx.strokeStyle='#1f6fb2';ctx.setLineDash([5,4]);ctx.lineWidth=1.5;
    let x0,y0,x1,y1;
    if(sh.type==='text'){
      const fs=sh.width*6*widthScale;const lines=(sh.text||'').split('\n');
      const bw=Math.max(...lines.map(l=>l.length))*fs*0.55;
      x0=P[0].x-4;y0=P[0].y-4;x1=P[0].x+bw+4;y1=P[0].y+lines.length*fs*1.25+4;
    }else{
      const xs=P.map(p=>p.x),ys=P.map(p=>p.y);
      x0=Math.min(...xs)-6;y0=Math.min(...ys)-6;x1=Math.max(...xs)+6;y1=Math.max(...ys)+6;
    }
    ctx.strokeRect(x0,y0,x1-x0,y1-y0);ctx.restore();
  }
  ctx.restore();
}
/* ---------- Plan-Export: Originalgrösse als PDF, mit Markern + Zeichnungen ---------- */
// Holt die rohen PDF-Bytes einer Planversion (lokal bevorzugt, sonst von der Cloud-URL nachgeladen)
async function _getPdfBytes(ver){
  if(ver.pdfData) return b64ToU8(ver.pdfData);
  if(ver.pdfUrl){
    const resp=await fetch(ver.pdfUrl);
    if(!resp.ok) throw new Error('PDF konnte nicht von der Cloud geladen werden');
    return new Uint8Array(await resp.arrayBuffer());
  }
  throw new Error('Keine PDF-Daten verfügbar');
}
function _hexToRgb01(hex){
  const h=(hex||'#000000').replace('#','');
  const r=parseInt(h.substring(0,2),16)/255, g=parseInt(h.substring(2,4),16)/255, b=parseInt(h.substring(4,6),16)/255;
  return {r:r||0,g:g||0,b:b||0};
}
/* ---------- Plan-Export: Original-PDF bleibt Vektor, Marker/Zeichnungen werden als
   zusätzliche Vektor-Ebene obendrauf gezeichnet (wie Anmerkungen in Adobe Acrobat) –
   keine Rasterung, keine Unschärfe. ---------- */
async function exportPlanAnnotatedPDF(planId){
  try{
    const plan=await get('plans',planId);
    if(!plan){toast('Plan nicht gefunden',false,true);return;}
    _normalizePlan(plan);
    const ver=plan.versions.find(v=>v.v===plan.currentVersion);
    if(!ver){toast('Planversion nicht gefunden',false,true);return;}
    if(typeof PDFLib==='undefined'){toast('PDF-Bibliothek nicht geladen',false,true);return;}
    toast('Erstelle PDF mit Anmerkungen…');
    const bytes=await _getPdfBytes(ver);
    const {PDFDocument,rgb,StandardFonts,degrees}=PDFLib;
    const pdfDoc=await PDFDocument.load(bytes);
    const page=pdfDoc.getPages()[0];
    const {width:PW,height:PH}=page.getSize();
    const fontBold=await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontReg=await pdfDoc.embedFont(StandardFonts.Helvetica);
    // Normalisierte (0..1) Plankoordinaten -> PDF-Punkte (PDF: Ursprung unten links, Y invertiert)
    const toPt=p=>({x:p.x*PW, y:PH-p.y*PH});
    // Strichstärke: Zeichnungen wurden auf dem Bildschirm bei state.viewport.width Pixel breit erzeugt;
    // auf die tatsächliche PDF-Punktgrösse umrechnen, damit Linien weder zu dünn noch zu dick wirken.
    const editWidth=(state.planId===planId&&state.viewport)?state.viewport.width:PW;
    const widthScale=PW/editWidth;

    // --- Zeichnungen (Vektor: Linien, Formen, Pfeile, Textmarker, Text-Vermerke) ---
    const drawings=plan.drawings||[];
    drawings.forEach(sh=>{
      const P=sh.points.map(toPt);
      const {r,g,b}=_hexToRgb01(sh.color);
      const color=rgb(r,g,b);
      const opacity=sh.opacity!=null?sh.opacity:1;
      const thickness=Math.max(0.5,sh.width*widthScale);
      if(sh.type==='pen'||sh.type==='highlight'){
        for(let i=0;i<P.length-1;i++) page.drawLine({start:P[i],end:P[i+1],thickness,color,lineCap:1,opacity});
      }else if(sh.type==='line'){
        if(P[1]) page.drawLine({start:P[0],end:P[1],thickness,color,lineCap:1,opacity});
      }else if(sh.type==='arrow'){
        if(P[1]){
          page.drawLine({start:P[0],end:P[1],thickness,color,lineCap:1,opacity});
          const ang=Math.atan2(P[1].y-P[0].y,P[1].x-P[0].x);const ah=(8+sh.width)*widthScale;
          const p1={x:P[1].x-ah*Math.cos(ang-Math.PI/6),y:P[1].y-ah*Math.sin(ang-Math.PI/6)};
          const p2={x:P[1].x-ah*Math.cos(ang+Math.PI/6),y:P[1].y-ah*Math.sin(ang+Math.PI/6)};
          page.drawSvgPath(`M ${P[1].x} ${P[1].y} L ${p1.x} ${p1.y} L ${p2.x} ${p2.y} Z`,{color,borderColor:color,opacity,borderOpacity:opacity});
        }
      }else if(sh.type==='rect'){
        if(P[1]){
          const x=Math.min(P[0].x,P[1].x), y=Math.min(P[0].y,P[1].y);
          const w=Math.abs(P[1].x-P[0].x), h=Math.abs(P[1].y-P[0].y);
          page.drawRectangle({x,y,width:w,height:h,borderColor:color,borderWidth:thickness,borderOpacity:opacity});
        }
      }else if(sh.type==='ellipse'){
        if(P[1]){
          const cx=(P[0].x+P[1].x)/2, cy=(P[0].y+P[1].y)/2;
          const rx=Math.abs(P[1].x-P[0].x)/2, ry=Math.abs(P[1].y-P[0].y)/2;
          page.drawEllipse({x:cx,y:cy,xScale:rx,yScale:ry,borderColor:color,borderWidth:thickness,borderOpacity:opacity});
        }
      }else if(sh.type==='text'){
        const fs=sh.width*6*widthScale;
        const lines=(sh.text||'').split('\n');
        lines.forEach((line,i)=>{
          page.drawText(line,{x:P[0].x,y:P[0].y-fs*(i+1)*1.05,size:fs,font:fontReg,color,opacity});
        });
      }
    });

    // --- Mängel-Marker (Pin + Nummer, als Vektorpfad + Text) ---
    const defs=(await byProject('defects')).filter(d=>d.planId===planId);
    const s=(PW/900); // Pin-Grösse proportional zur Plangrösse
    defs.forEach(d=>{
      const colorHex=d.status==='Offen'?'#c8481c':d.status==='In Arbeit'?'#b8860b':'#2f7d54';
      const {r,g,b}=_hexToRgb01(colorHex);const color=rgb(r,g,b);
      const c=toPt({x:d.rx,y:d.ry});
      const pinW=30*s, pinH=38*s;
      // Tropfenform als SVG-Pfad (relativ zur Marker-Spitze c, PDF-Y zeigt nach oben -> +pinH statt -pinH)
      const path=`M ${c.x} ${c.y}
        C ${c.x-pinW/2} ${c.y+pinH*0.55}, ${c.x-pinW/2} ${c.y+pinH}, ${c.x} ${c.y+pinH}
        C ${c.x+pinW/2} ${c.y+pinH}, ${c.x+pinW/2} ${c.y+pinH*0.55}, ${c.x} ${c.y}
        Z`;
      page.drawSvgPath(path,{color,borderColor:color});
      page.drawEllipse({x:c.x,y:c.y+pinH*0.66,xScale:pinW*0.32,yScale:pinW*0.32,color:rgb(1,1,1)});
      const label=String(d.num);
      const fs=pinW*0.55;
      const tw=fontBold.widthOfTextAtSize(label,fs);
      page.drawText(label,{x:c.x-tw/2,y:c.y+pinH*0.66-fs*0.36,size:fs,font:fontBold,color});
    });

    const outBytes=await pdfDoc.save();
    const blob=new Blob([outBytes],{type:'application/pdf'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=`${(plan.name||'Plan').replace(/[\\/:*?"<>|]+/g,'_')}_mit_Anmerkungen.pdf`;
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),4000);
    toast(`PDF erstellt (Vektor, Originalgrösse) · ${defs.length} Marker · ${drawings.length} Zeichnung(en)`,true);
  }catch(e){
    console.error('[Plan-Export]',e);
    toast('Export fehlgeschlagen: '+(e.message||'unbekannter Fehler'),false,true);
  }
}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(state.armed)toggleArm();if(state.lupe)toggleLupe();}});
async function placeMarker(e){
  if(!state.armed)return;
  const rect=e.currentTarget.getBoundingClientRect();
  const rx=(e.clientX-rect.left)/rect.width, ry=(e.clientY-rect.top)/rect.height;
  const defs=await byProject('defects');
  const num=defs.reduce((m,d)=>Math.max(m,d.num),0)+1;
  const def={id:uid(),projectId:state.projectId,planId:state.planId,num,title:'',desc:'',status:'Offen',
    assignee:'',assigneeId:'',due:'',dueOriginal:'',checkedAt:'',floor:'',room:'',trade:'',rx,ry,page:1,photos:[],docs:[],createdAt:nowISO(),createdBy:CURRENT_USER.name,
    history:[{at:nowISO(),by:CURRENT_USER.name,action:'Mangel erstellt'}]};
  await put('defects',def);toggleArm();
  // Planausschnitt direkt erzeugen
  const plan=await get('plans',state.planId);
  if(plan){def.excerpt=await cropPlanAround(plan,rx,ry,num,'Offen');await put('defects',def);}
  await renderMarkers();await renderPlanList();await renderRail();
  selectDefect(def.id);
}
async function selectDefect(id){state.defectId=id;await renderMarkers();openDrawer(await get('defects',id));}

async function openDrawer(d){
  const dr=document.getElementById('drawer');if(!dr)return;dr.classList.add('open');
  document.getElementById('dNum').textContent='#'+String(d.num).padStart(3,'0');
  document.getElementById('dHeadTitle').textContent=d.title||'Neuer Mangel';
  const contacts=await byProject('contacts');
  const photos=(d.photos||[]).map((p,i)=>`<img src="${p}" data-i="${i}">`).join('');
  const docs=(d.docs||[]).map((doc,i)=>`<div class="doc-chip" data-doc="${i}">📄 ${esc(doc.name)}</div>`).join('');
  document.getElementById('drawerBody').innerHTML=`
    <div class="field"><label>Titel / Kurzbeschrieb</label><input id="f-title" value="${esc(d.title)}" placeholder="z.B. Riss in Trockenbauwand"></div>
    <div class="field"><label id="f-desc-label">Beschreibung</label><textarea id="f-desc" placeholder="Detaillierte Beschreibung…">${esc(d.desc)}</textarea></div>
    <div class="field"><label>Status</label><select id="f-status">${['Offen','In Arbeit','Erledigt'].map(s=>`<option ${s===d.status?'selected':''}>${s}</option>`).join('')}</select></div>

    <div class="field-group-title">Örtlichkeit</div>
    <div class="field-row">
      <div class="field"><label>Stockwerk</label><input id="f-floor" value="${esc(d.floor)}" placeholder="z.B. 2. OG" list="floorList"></div>
      <div class="field"><label>Raum</label><input id="f-room" value="${esc(d.room)}" placeholder="z.B. Wohnzimmer" list="roomList"></div>
    </div>
    <datalist id="floorList">${['UG','EG','1. OG','2. OG','3. OG','Attika','Dachgeschoss'].map(o=>`<option>${o}</option>`).join('')}</datalist>
    <datalist id="roomList">${['Wohnzimmer','Küche','Schlafzimmer','Bad','WC','Korridor','Balkon','Keller','Treppenhaus'].map(o=>`<option>${o}</option>`).join('')}</datalist>

    <div class="field-group-title">Auftrag</div>
    <div class="field-row">
      <div class="field"><label>Gewerk / BKP</label><input id="f-trade" value="${esc(d.trade)}" placeholder="z.B. 285 Malerarbeiten" list="bkpList"></div>
      <div class="field"><label>Zuständiger Unternehmer</label>
        <select id="f-assignee"><option value="">— wählen —</option>
          ${contacts.map(c=>`<option value="${c.id}" ${c.id===d.assigneeId?'selected':''}>${esc(c.company)} (${esc(c.trade)})</option>`).join('')}
        </select></div>
    </div>
    <datalist id="bkpList">${BKP.map(b=>`<option>${b}</option>`).join('')}</datalist>

    <div class="field-group-title">Termine</div>
    <div class="field-row">
      <div class="field"><label>Termin</label><input type="date" id="f-due" value="${d.due||''}"></div>
      <div class="field"><label>Termin ursprünglich</label><input type="date" id="f-dueOrig" value="${d.dueOriginal||''}"></div>
      <div class="field"><label>Kontrolliert am</label><input type="date" id="f-checked" value="${d.checkedAt||''}"></div>
    </div>

    <div class="field"><label>Fotos</label><div class="photo-grid">${photos}<button class="photo-add" id="photoAddBtn">＋</button></div></div>
    <div class="field"><label>Zusatzdokumente <span style="font-weight:400;color:var(--muted);font-size:11.5px">(Pläne, PDFs, sonstige Dateien)</span></label>
      <div class="doc-list">${docs}</div>
      <button class="btn btn-ghost btn-sm" id="docAddBtn" type="button" style="margin-top:6px">＋ Dokument anhängen</button>
      <input type="file" id="docFileInput" class="hidden">
    </div>
    <div class="field"><label>Verlauf</label><div class="histbox">${(d.history||[]).map(h=>`<div>${fmtDate(h.at)} · ${esc(h.by)} – ${esc(h.action)}</div>`).join('')}</div></div>`;
  document.getElementById('photoAddBtn').onclick=()=>openPhotoSource(async(b64)=>{
    const dd=await get('defects',d.id);dd.photos=dd.photos||[];dd.photos.push(b64);
    dd.history.push({at:nowISO(),by:CURRENT_USER.name,action:'Foto hinzugefügt'});
    await put('defects',dd);openDrawer(dd);await renderPlanList();toast('Foto angefügt',true);
  });
  document.querySelectorAll('.drawer-body .photo-grid img').forEach(img=>img.onclick=()=>window.open(img.src,'_blank'));
  attachDictateButton(document.getElementById('f-desc-label'),document.getElementById('f-desc'));
  document.getElementById('docAddBtn').onclick=()=>document.getElementById('docFileInput').click();
  document.getElementById('docFileInput').onchange=async e=>{
    const f=e.target.files[0];if(!f)return;
    const b64=await fileToB64(f);
    const dd=await get('defects',d.id);dd.docs=dd.docs||[];dd.docs.push({name:f.name,data:b64});
    dd.history.push({at:nowISO(),by:CURRENT_USER.name,action:'Dokument angehängt: '+f.name});
    await put('defects',dd);e.target.value='';openDrawer(dd);toast('Dokument angefügt',true);
  };
  document.querySelectorAll('.drawer-body .doc-chip').forEach(chip=>chip.onclick=async()=>{
    const dd=await get('defects',d.id);const doc=dd.docs[+chip.dataset.doc];if(!doc)return;
    const a=document.createElement('a');a.href=doc.data;a.download=doc.name;a.click();
  });
}
function closeDrawer(){const dr=document.getElementById('drawer');if(dr)dr.classList.remove('open');}
async function saveDefect(){
  if(!state.defectId)return;
  const d=await get('defects',state.defectId);
  const ns=document.getElementById('f-status').value;
  if(ns!==d.status)d.history.push({at:nowISO(),by:CURRENT_USER.name,action:`Status → ${ns}`});
  d.title=document.getElementById('f-title').value.trim();
  d.desc=document.getElementById('f-desc').value.trim();
  d.status=ns;
  d.floor=document.getElementById('f-floor').value.trim();
  d.room=document.getElementById('f-room').value.trim();
  const newDue=document.getElementById('f-due').value;
  if(newDue && !d.dueOriginal) d.dueOriginal=newDue; // ursprünglichen Termin einmalig festhalten
  d.due=newDue;
  d.dueOriginal=document.getElementById('f-dueOrig').value||d.dueOriginal;
  d.checkedAt=document.getElementById('f-checked').value;
  const aid=document.getElementById('f-assignee').value;d.assigneeId=aid;
  if(aid){const c=await get('contacts',aid);d.assignee=c?c.company:'';}else d.assignee='';
  d.trade=document.getElementById('f-trade').value.trim();
  // Planausschnitt rund um den Marker aktualisieren (für Listenübersicht)
  if(d.planId){const plan=await get('plans',d.planId);if(plan){d.excerpt=await cropPlanAround(plan,d.rx,d.ry,d.num,d.status);}}
  await put('defects',d);
  await renderMarkers();await renderPlanList();await renderRail();
  document.getElementById('dHeadTitle').textContent=d.title||'Mangel';
  toast('Gespeichert',true);
}
async function deleteDefect(){
  if(!state.defectId||!confirm('Diesen Mangel wirklich löschen?'))return;
  await del('defects',state.defectId);state.defectId=null;closeDrawer();
  await renderMarkers();await renderPlanList();await renderRail();toast('Mangel gelöscht');
}
// Erstellt einen login-freien Freigabe-Link + QR-Code für einen Mangel (nur Ansicht, für Unternehmer).
// Lädt eine öffentliche JSON-Momentaufnahme in den Cloud-Speicher hoch; Änderungen am Mangel danach
// erfordern eine erneute Freigabe (Snapshot wird nicht automatisch aktualisiert).
async function openShareModal(id){
  if(typeof cloudEnabled!=='function'||!cloudEnabled()){
    toast('Freigabe benötigt eine aktive Cloud-Verbindung (nicht im lokalen Testmodus verfügbar)',false,true);
    return;
  }
  const d=await get('defects',id);if(!d){toast('Mangel nicht gefunden',false,true);return;}
  const proj=await get('projects',state.projectId);
  modal(`<div class="modal-head"><h3>Für Unternehmer freigeben</h3><p>Login-freier Link – zeigt Mangel #${String(d.num).padStart(3,'0')} nur zur Ansicht, ohne Bearbeitungsmöglichkeit.</p></div>
    <div class="modal-body" style="text-align:center">
      <div id="shareLoading" style="padding:30px;color:var(--muted)">Erstelle Freigabe-Link…</div>
      <div id="shareResult" class="hidden">
        <img id="shareQr" style="width:200px;height:200px;margin:0 auto;display:block;border:1px solid var(--line);border-radius:8px">
        <div class="field" style="margin-top:14px;text-align:left"><label>Link</label>
          <div style="display:flex;gap:6px"><input id="shareUrl" readonly style="flex:1"><button class="btn btn-steel btn-sm" id="shareCopyBtn" type="button">Kopieren</button></div>
        </div>
        <p style="color:var(--muted);font-size:12px;margin-top:10px">Der Unternehmer sieht Titel, Beschreibung, Ort, Foto und Termin – ohne Login, ohne Bearbeitungsmöglichkeit. Bei späteren Änderungen am Mangel diesen Link erneut erzeugen.</p>
      </div>
    </div>
    <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">Schliessen</button></div>`);
  const snapshot={v:1,id:d.id,num:d.num,title:d.title,desc:d.desc,floor:d.floor,room:d.room,trade:d.trade,
    assignee:d.assignee,due:d.due,status:d.status,photos:(d.photos||[]).slice(0,3),excerpt:d.excerpt||null,
    projectName:proj.name,generatedAt:nowISO()};
  const publicUrl=await cloudUploadPublicJSON('defect-'+d.id,snapshot);
  const loadEl=document.getElementById('shareLoading');if(!loadEl)return; // Fenster inzwischen geschlossen
  if(!publicUrl){loadEl.textContent='Freigabe fehlgeschlagen (keine Verbindung zur Cloud). Bitte später erneut versuchen.';return;}
  const shareLink=location.origin+location.pathname+'?share='+d.id;
  loadEl.classList.add('hidden');
  document.getElementById('shareResult').classList.remove('hidden');
  document.getElementById('shareUrl').value=shareLink;
  try{
    const qr=window.qrcode(0,'M');qr.addData(shareLink);qr.make();
    document.getElementById('shareQr').src=qr.createDataURL(6,4);
  }catch(e){ console.warn('[QR]',e.message); }
  document.getElementById('shareCopyBtn').onclick=()=>{
    navigator.clipboard?.writeText(shareLink).then(()=>toast('Link kopiert',true)).catch(()=>toast('Kopieren nicht möglich',false,true));
  };
}
// --- Öffentliche Ansicht für Unternehmer (kein Login, nur Lesen) ---
// Wird ganz am Anfang von init() geprüft: ?share=<id> in der URL -> eigene, minimale Ansicht statt der normalen App.
async function tryRenderPublicShare(){
  const params=new URLSearchParams(location.search);
  const shareId=params.get('share');
  if(!shareId)return false;
  document.body.innerHTML=`<div id="pubView" style="max-width:520px;margin:0 auto;padding:20px;font-family:sans-serif;color:#1a1a1a">
    <div style="text-align:center;padding:60px 0;color:#8a8378">Lade…</div></div>`;
  try{
    // Öffentliche URL aus der bekannten Struktur ableiten (Storage-Bucket 'files', öffentlich lesbar)
    const base=(typeof CLOUD_CONFIG!=='undefined'&&CLOUD_CONFIG.url)?CLOUD_CONFIG.url:'https://oljyepagacpgbqkjzfxm.supabase.co';
    const url=`${base}/storage/v1/object/public/files/public/defect-${shareId}.json`;
    const resp=await fetch(url);
    if(!resp.ok)throw new Error('nicht gefunden');
    const d=await resp.json();
    const sevColor=d.status==='Offen'?'#c8481c':d.status==='In Arbeit'?'#b8860b':'#2f7d54';
    const loc=[d.floor,d.room].filter(Boolean).join(' · ');
    document.getElementById('pubView').innerHTML=`
      <div style="text-align:center;margin-bottom:18px"><b style="font-size:18px;color:#a8392a">BauView</b><div style="font-size:12px;color:#8a8378">Mangel-Ansicht (ohne Login)</div></div>
      <div style="background:#fff;border:1px solid #ddd6cb;border-radius:12px;padding:18px;box-shadow:0 2px 10px rgba(0,0,0,.06)">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <span style="background:${sevColor};color:#fff;font-size:11px;font-weight:700;padding:3px 9px;border-radius:5px">${d.status}</span>
          <span style="color:#8a8378;font-size:12px">#${String(d.num).padStart(3,'0')} · ${d.projectName||''}</span>
        </div>
        <h2 style="margin:0 0 8px;font-size:19px">${(d.title||'(ohne Titel)').replace(/</g,'&lt;')}</h2>
        ${d.desc?`<p style="color:#444;font-size:14px;line-height:1.5">${d.desc.replace(/</g,'&lt;')}</p>`:''}
        ${loc?`<div style="font-size:13px;color:#6b6258;margin-top:8px">📍 ${loc.replace(/</g,'&lt;')}</div>`:''}
        ${d.trade?`<div style="font-size:13px;color:#6b6258;margin-top:4px">🔧 ${d.trade.replace(/</g,'&lt;')}</div>`:''}
        ${d.assignee?`<div style="font-size:13px;color:#6b6258;margin-top:4px">👤 ${d.assignee.replace(/</g,'&lt;')}</div>`:''}
        ${d.due?`<div style="font-size:13px;color:#6b6258;margin-top:4px">📅 Termin: ${d.due.split('-').reverse().join('.')}</div>`:''}
        ${(d.photos&&d.photos.length)?`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px">${d.photos.map(p=>`<img src="${p}" style="width:90px;height:90px;object-fit:cover;border-radius:6px">`).join('')}</div>`:''}
        ${d.excerpt?`<div style="margin-top:12px"><div style="font-size:11px;color:#8a8378;margin-bottom:4px">Lage im Plan</div><img src="${d.excerpt}" style="width:100%;border-radius:6px;border:1px solid #ddd6cb"></div>`:''}
      </div>
      <div style="text-align:center;color:#8a8378;font-size:11px;margin-top:16px">Nur zur Information · ohne Bearbeitungsmöglichkeit</div>
    </div>`;
  }catch(e){
    document.getElementById('pubView').innerHTML=`<div style="text-align:center;padding:60px 20px;color:#8a8378">
      <div style="font-size:15px;font-weight:700;color:#1a1a1a;margin-bottom:8px">Nicht gefunden</div>
      <div style="font-size:13px">Dieser Freigabe-Link ist ungültig oder abgelaufen.</div></div>`;
  }
  return true;
}
document.getElementById('photoInput').onchange=async e=>{
  const f=e.target.files[0];if(!f||!state._photoTarget)return;
  const b64=await fileToB64(f);const d=await get('defects',state._photoTarget);
  d.photos=d.photos||[];d.photos.push(b64);
  d.history.push({at:nowISO(),by:CURRENT_USER.name,action:'Foto hinzugefügt'});
  await put('defects',d);e.target.value='';openDrawer(d);toast('Foto angefügt',true);
};
function buildVerMenu(plan){
  const btn=document.getElementById('verBtn');if(!btn)return;btn.textContent=`Version v${state.version} ▾`;
  btn.onclick=()=>{
    let m=document.getElementById('verPop');if(m){m.remove();return;}
    m=document.createElement('div');m.className='ver-list';m.id='verPop';
    m.innerHTML=plan.versions.slice().reverse().map(v=>`<button class="${v.v===state.version?'cur':''}" data-v="${v.v}">Version v${v.v}${v.v===plan.currentVersion?' (aktuell)':''}<small>${esc(v.fileName)} · ${fmtDate(v.uploadedAt)} · ${esc(v.uploadedBy)}</small></button>`).join('');
    btn.parentElement.appendChild(m);
    m.querySelectorAll('button').forEach(b=>b.onclick=async()=>{state.version=+b.dataset.v;m.remove();await loadPlanRender();});
  };
}

/* ============================================================
   MODULE: MÄNGELLISTE (Filter, Bulk, Listen-Export, Massen-Mail)
   ============================================================ */
async function renderDefectList(){
  const stage=document.getElementById('stage');
  state.selection.clear();
  let defs=await byProject('defects');
  const contacts=await byProject('contacts');
  const f=state.filter;
  const assignees=[...new Set(defs.map(d=>d.assignee).filter(Boolean))];
  stage.innerHTML=`
    <div class="module">
      <div class="mod-head">
        <div><h1>Pendenzen- & Mängelliste</h1><div class="sub" id="defSub"></div></div>
        <div class="spacer"></div>
        <button class="btn btn-ghost btn-sm" id="bulkStatusBtn">Status setzen</button>
        <button class="btn btn-steel btn-sm" id="mailBtn">✉ Liste versenden</button>
        <button class="btn btn-primary btn-sm" id="pdfBtn">⬇ Liste als PDF</button>
      </div>
      <div class="mod-body">
        <div class="toolbar-row">
          <input class="search-box" id="srch" placeholder="Suchen…" value="${esc(f.q)}">
          <select class="filter-sel" id="fStatus"><option value="">Alle Status</option>${['Offen','In Arbeit','Erledigt'].map(s=>`<option ${f.status===s?'selected':''}>${s}</option>`).join('')}</select>
          <select class="filter-sel" id="fAssignee"><option value="">Alle Unternehmer</option>${assignees.map(a=>`<option ${f.assignee===a?'selected':''}>${esc(a)}</option>`).join('')}</select>
          <div class="spacer" style="flex:1"></div>
          <span style="font-size:12px;color:var(--muted)" id="selInfo"></span>
        </div>
        <div id="defTableWrap"></div>
      </div>
    </div>`;
  document.getElementById('srch').oninput=e=>{f.q=e.target.value;drawTable();};
  document.getElementById('fStatus').onchange=e=>{f.status=e.target.value;drawTable();};
  document.getElementById('fAssignee').onchange=e=>{f.assignee=e.target.value;drawTable();};
  document.getElementById('pdfBtn').onclick=()=>exportDefectPDF(filtered());
  document.getElementById('mailBtn').onclick=()=>openMailComposer(filtered());
  document.getElementById('bulkStatusBtn').onclick=bulkStatus;

  function filtered(){
    return defs.filter(d=>{
      if(f.status&&d.status!==f.status)return false;
      if(f.assignee&&d.assignee!==f.assignee)return false;
      if(f.q){const q=f.q.toLowerCase();if(!((d.title||'')+' '+(d.desc||'')+' '+(d.trade||'')+' '+(d.assignee||'')).toLowerCase().includes(q))return false;}
      return true;
    }).sort((a,b)=>a.num-b.num);
  }
  function drawTable(){
    const rows=filtered();
    document.getElementById('defSub').textContent=`${rows.length} von ${defs.length} Einträgen · ${defs.filter(d=>d.status!=='Erledigt').length} offen`;
    const wrap=document.getElementById('defTableWrap');
    if(!rows.length){wrap.innerHTML=`<div class="empty"><div class="big">⚠</div><h3>Keine Mängel</h3><p>Erfasse Mängel im Modul „Pläne & Mängel" direkt auf dem Plan.</p></div>`;return;}
    wrap.innerHTML=`
      <div class="def-selrow"><label class="def-selall"><input type="checkbox" id="selAll"> Alle auswählen</label></div>
      <div class="def-cards">${rows.map(d=>{
        const imgs=[];
        if(d.excerpt)imgs.push(`<figure class="def-img"><img src="${d.excerpt}" data-img="${d.id}-x"><figcaption>Planausschnitt</figcaption></figure>`);
        (d.photos||[]).forEach((p,i)=>imgs.push(`<figure class="def-img"><img src="${p}" data-img="${d.id}-${i}"><figcaption>Foto ${i+1}</figcaption></figure>`));
        return `<div class="def-card ${d.id===state.defectId?'active':''}" data-id="${d.id}">
          <button class="card-del" data-del="${d.id}" title="Mangel löschen">×</button>
          <div class="def-card-main">
            <div class="def-card-head">
              <input type="checkbox" class="rowchk" data-id="${d.id}" ${state.selection.has(d.id)?'checked':''}>
              <span class="dr-num">#${String(d.num).padStart(3,'0')}</span>
              <span class="status-tag status-${statusKey(d.status)}">${d.status}</span>
            </div>
            <div class="def-card-title">${esc(d.title||'(ohne Titel)')}</div>
            ${d.desc?`<div class="def-card-desc">${esc(d.desc)}</div>`:''}
            <div class="def-card-meta">
              <span>👤 ${esc(d.assignee||'—')}</span>
              <span>🔧 ${esc(d.trade||'—')}</span>
              <span>📅 ${fmtDate(d.due)}</span>
            </div>
            <button class="btn btn-ghost btn-sm def-open" data-open="${d.id}">Im Plan öffnen →</button>
          </div>
          ${imgs.length?`<div class="def-card-imgs">${imgs.join('')}</div>`:`<div class="def-card-imgs def-noimg">Keine Bilder</div>`}
        </div>`;
      }).join('')}</div>`;
    wrap.querySelectorAll('.rowchk').forEach(cb=>cb.onclick=e=>{e.stopPropagation();const id=cb.dataset.id;cb.checked?state.selection.add(id):state.selection.delete(id);updateSelInfo();});
    wrap.querySelectorAll('[data-open]').forEach(b=>b.onclick=e=>{e.stopPropagation();jumpToDefect(b.dataset.open);});
    wrap.querySelectorAll('.card-del[data-del]').forEach(b=>b.onclick=async e=>{e.stopPropagation();const d=await get('defects',b.dataset.del);await confirmDelete('defects',b.dataset.del,d?('Mangel #'+String(d.num).padStart(3,'0')):'Mangel',async()=>{await renderDefectList();await renderRail();});});
    wrap.querySelectorAll('.def-img img').forEach(img=>img.onclick=e=>{e.stopPropagation();window.open(img.src,'_blank');});
    wrap.querySelectorAll('.def-card').forEach(card=>card.onclick=e=>{
      if(e.target.closest('.card-del,.rowchk,.def-img,.def-open'))return;
      openDefectEditModal(card.dataset.id);
    });
    const sa=document.getElementById('selAll');
    if(sa)sa.onclick=e=>{rows.forEach(d=>e.target.checked?state.selection.add(d.id):state.selection.delete(d.id));drawTable();updateSelInfo();};
    updateSelInfo();
  }
  function updateSelInfo(){const n=state.selection.size;const el=document.getElementById('selInfo');if(el)el.textContent=n?`${n} ausgewählt`:'';}
  drawTable();
}
async function jumpToDefect(id){
  const d=await get('defects',id);
  if(!d.planId){toast('Dieser Mangel ist keinem Plan zugeordnet');return;}
  const plan=await get('plans',d.planId);
  if(!plan){toast('Zugehöriger Plan nicht gefunden');return;}
  state.planId=d.planId;state.defectId=id;
  await navigate('plans');
  setTimeout(()=>{const m=document.querySelector(`.marker[data-def="${id}"]`);if(m)m.scrollIntoView({behavior:'smooth',block:'center'});},300);
}
// Bearbeiten eines Mangels DIREKT aus der Mängelliste (gleiche Felder wie im Plan-Drawer),
// ohne dass man erst zum Plan wechseln muss.
async function openDefectEditModal(id){
  const d=await get('defects',id);
  if(!d){toast('Mangel nicht gefunden',false,true);return;}
  const contacts=await byProject('contacts');
  const photos=(d.photos||[]).map((p,i)=>`<img src="${p}" data-i="${i}">`).join('');
  modal(`<div class="modal-head"><h3>#${String(d.num).padStart(3,'0')} ${esc(d.title||'Mangel bearbeiten')}</h3></div>
    <div class="modal-body">
      <div class="field"><label>Titel / Kurzbeschrieb</label><input id="fe-title" value="${esc(d.title)}" placeholder="z.B. Riss in Trockenbauwand"></div>
      <div class="field"><label>Beschreibung</label><textarea id="fe-desc" placeholder="Detaillierte Beschreibung…">${esc(d.desc)}</textarea></div>
      <div class="field-row">
        <div class="field"><label>Status</label><select id="fe-status">${['Offen','In Arbeit','Erledigt'].map(s=>`<option ${s===d.status?'selected':''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label>Frist</label><input type="date" id="fe-due" value="${d.due||''}"></div>
      </div>
      <div class="field"><label>Zuständiger Unternehmer</label>
        <select id="fe-assignee"><option value="">— wählen —</option>
          ${contacts.map(c=>`<option value="${c.id}" ${c.id===d.assigneeId?'selected':''}>${esc(c.company)} (${esc(c.trade)})</option>`).join('')}
        </select></div>
      <div class="field"><label>Gewerk / BKP</label><input id="fe-trade" value="${esc(d.trade)}" placeholder="z.B. 285 Malerarbeiten" list="bkpListModal"></div>
      <datalist id="bkpListModal">${BKP.map(b=>`<option>${b}</option>`).join('')}</datalist>
      <div class="field"><label>Fotos</label><div class="photo-grid" id="fePhotoGrid">${photos}<button class="photo-add" id="fePhotoAddBtn" type="button">＋</button></div></div>
      ${d.excerpt?`<div class="field"><label>Planausschnitt</label><br><img src="${d.excerpt}" style="max-width:220px;border-radius:8px;border:1px solid var(--line);margin-top:4px"></div>`:''}
      <div class="field"><label>Verlauf</label><div class="histbox">${(d.history||[]).map(h=>`<div>${fmtDate(h.at)} · ${esc(h.by)} – ${esc(h.action)}</div>`).join('')||'<span style="color:var(--muted);font-size:12px">Noch keine Einträge</span>'}</div></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-danger" id="feDelBtn">Löschen</button>
      ${d.planId?'<button class="btn btn-steel" id="feJumpBtn" type="button">Im Plan öffnen →</button>':''}
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" id="feSaveBtn">Speichern</button>
    </div>`,{wide:true});
  document.getElementById('fePhotoAddBtn').onclick=()=>openPhotoSource(async(b64)=>{
    const dd=await get('defects',id);dd.photos=dd.photos||[];dd.photos.push(b64);
    dd.history.push({at:nowISO(),by:CURRENT_USER.name,action:'Foto hinzugefügt'});
    await put('defects',dd);toast('Foto angefügt',true);openDefectEditModal(id);
  });
  document.querySelectorAll('#fePhotoGrid img').forEach(img=>img.onclick=()=>window.open(img.src,'_blank'));
  const jb=document.getElementById('feJumpBtn');
  if(jb)jb.onclick=()=>{closeModal();jumpToDefect(id);};
  document.getElementById('feSaveBtn').onclick=async(ev)=>{
    if(guardBusy(ev.currentTarget))return;
    const dd=await get('defects',id);
    const ns=document.getElementById('fe-status').value;
    if(ns!==dd.status)dd.history.push({at:nowISO(),by:CURRENT_USER.name,action:`Status → ${ns}`});
    dd.title=document.getElementById('fe-title').value.trim();
    dd.desc=document.getElementById('fe-desc').value.trim();
    dd.status=ns;dd.due=document.getElementById('fe-due').value;
    const aid=document.getElementById('fe-assignee').value;dd.assigneeId=aid;
    if(aid){const c=await get('contacts',aid);dd.assignee=c?c.company:'';}else dd.assignee='';
    dd.trade=document.getElementById('fe-trade').value.trim();
    // Planausschnitt bei Statusänderung mit aktualisieren (Pin-Farbe im Ausschnitt)
    if(dd.planId){const plan=await get('plans',dd.planId);if(plan){dd.excerpt=await cropPlanAround(plan,dd.rx,dd.ry,dd.num,dd.status);}}
    await put('defects',dd);
    closeModal();
    await renderDefectList();await renderRail();
    toast('Gespeichert',true);
  };
  document.getElementById('feDelBtn').onclick=async()=>{
    const ok=await confirmDelete('defects',id,'Mangel #'+String(d.num).padStart(3,'0'),async()=>{await renderDefectList();await renderRail();});
    if(ok)closeModal();
  };
}
async function bulkStatus(){
  if(!state.selection.size){toast('Keine Einträge ausgewählt');return;}
  modal(`<div class="modal-head"><h3>Status für ${state.selection.size} Einträge setzen</h3></div>
    <div class="modal-body"><div class="field"><label>Neuer Status</label><select id="bulkSel">${['Offen','In Arbeit','Erledigt'].map(s=>`<option>${s}</option>`).join('')}</select></div></div>
    <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button><button class="btn btn-primary" id="bulkApply">Anwenden</button></div>`);
  document.getElementById('bulkApply').onclick=async()=>{
    const ns=document.getElementById('bulkSel').value;
    for(const id of state.selection){const d=await get('defects',id);if(d.status!==ns){d.status=ns;d.history.push({at:nowISO(),by:CURRENT_USER.name,action:`Status → ${ns} (Sammelbearbeitung)`});await put('defects',d);}}
    closeModal();state.selection.clear();toast('Status aktualisiert',true);await renderDefectList();await renderRail();
  };
}

/* ---------- PDF: Mängelliste ---------- */
/* ---------- PDF-Branding: Kopf-Logo (oben rechts) + Fusszeile auf jeder Seite ---------- */
function pdfHeaderLogo(doc){
  // helbling architektur Logo oben rechts
  if(typeof BRAND==='undefined'||!BRAND.headerLogo)return;
  try{
    const props=doc.getImageProperties(BRAND.headerLogo);
    const w=58, h=w*props.height/props.width; // proportional, ~58mm breit
    doc.addImage(BRAND.headerLogo,'JPEG',210-14-w,9,w,h);
  }catch(e){}
}
function pdfFooterAllPages(doc){
  if(typeof BRAND==='undefined'||!BRAND.footer)return;
  try{
    const props=doc.getImageProperties(BRAND.footer);
    const w=182, h=w*props.height/props.width; // volle Breite minus Ränder
    const n=doc.getNumberOfPages();
    for(let i=1;i<=n;i++){
      doc.setPage(i);
      const y=297-8-h; // 8mm Abstand zum unteren Rand (A4=297mm)
      doc.setDrawColor(168,57,42);doc.setLineWidth(0.3);doc.line(14,y-2,196,y-2);
      doc.addImage(BRAND.footer,'JPEG',14,y,w,h);
    }
  }catch(e){}
}

/* ============================================================
   PDF-LAYOUT-SYSTEM (sauber, einheitlich)
   ------------------------------------------------------------
   Verhindert Linien über Text durch korrekte Höhen-Berechnung.
   Alle Maße in mm. A4 = 210 x 297.
   ============================================================ */
const PDF={
  ML:14, MR:196, TOP:44,           // linker/rechter Rand, Start-Y
  FOOT_LIMIT:268,                  // unterhalb davon: neue Seite (Platz für Fusszeile)
  LH:4.6,                          // Zeilenhöhe normaler Text (mm bei 9pt)
  LH_S:3.8                         // Zeilenhöhe kleiner Text (8pt)
};
// misst, wie hoch ein umgebrochener Textblock wird (mm)
function pdfTextHeight(doc,text,width,lh){
  const lines=doc.splitTextToSize(String(text||''),width);
  return {lines, h: lines.length*(lh||PDF.LH)};
}
// prüft Seitenumbruch VOR dem Zeichnen eines Blocks der Höhe blockH
function pdfEnsureSpace(doc, y, blockH, redrawHeader){
  if(y+blockH>PDF.FOOT_LIMIT){
    doc.addPage();
    let ny=20;
    if(typeof redrawHeader==='function') ny=redrawHeader()||20;
    return ny;
  }
  return y;
}
// Titelkopf eines Dokuments (einheitlich), gibt Start-Y für Inhalt zurück
function pdfDocHead(doc, title, lines){
  pdfHeaderLogo(doc);
  doc.setTextColor(168,57,42);doc.setFontSize(16);doc.setFont(undefined,'bold');
  doc.text(title,PDF.ML,18);doc.setFont(undefined,'normal');
  doc.setDrawColor(168,57,42);doc.setLineWidth(0.4);
  const tw=doc.getTextWidth(title);doc.line(PDF.ML,21,PDF.ML+tw,21);
  doc.setFontSize(9);doc.setTextColor(60);
  let y=29;
  (lines||[]).forEach(ln=>{
    if(ln){
      const txt=String(ln.l||''); const x=ln.x||PDF.ML;
      if(ln.proj){
        // Projekttitel: fett + unterstrichen (einheitlich in allen Dokumenten)
        doc.setFont(undefined,'bold');doc.setTextColor(26,26,26);doc.text(txt,x,y);
        const w=doc.getTextWidth(txt);doc.setDrawColor(26,26,26);doc.setLineWidth(0.25);doc.line(x,y+1,x+w,y+1);
        doc.setFont(undefined,'normal');doc.setTextColor(60);
      }else{ doc.text(txt,x,y); }
    }
    if(!ln.same)y+=5;
  });
  return Math.max(y+4,42);
}

/* ============================================================
   MODULE: PENDENZEN PRO UNTERNEHMER
   Kombiniert offene Mängel + Aktennotizen, gruppiert nach Unternehmer,
   erzeugt pro Unternehmer ein PDF und bereitet eine Mail (mit Anhang) vor.
   ============================================================ */
async function collectPendenzen(){
  const defs=(await byProject('defects')).filter(d=>d.status!=='Erledigt');
  const notes=await byProject('notes');
  const items=[];
  defs.forEach(d=>items.push({kind:'Mangel',srcStore:'defects',srcId:d.id,num:d.num,title:d.title||'(ohne Titel)',desc:d.desc||'',
    due:d.due||'',assigneeId:d.assigneeId||'',assignee:d.assignee||'',trade:d.trade||'',photos:d.photos||[],excerpt:d.excerpt||null}));
  notes.forEach(n=>items.push({kind:'Aktennotiz',srcStore:'notes',srcId:n.id,num:null,title:n.title||'(ohne Titel)',desc:n.text||'',
    due:n.due||'',assigneeId:n.assigneeId||'',assignee:n.assignee||'',trade:'',photos:n.photos||[],date:n.date,excerpt:null}));
  return items;
}
async function renderPendenzen(){
  const stage=document.getElementById('stage');
  const items=await collectPendenzen();
  const contacts=await byProject('contacts');
  // gruppieren
  const groups={};
  items.forEach(it=>{const k=it.assigneeId||'_none';(groups[k]=groups[k]||[]).push(it);});
  const assigned=Object.entries(groups).filter(([k])=>k!=='_none');
  const unassignedCount=(groups['_none']||[]).length;
  stage.innerHTML=`
    <div class="module">
      <div class="mod-head"><div><h1>Pendenzen pro Unternehmer</h1>
        <div class="sub">Offene Mängel + Aktennotizen, automatisch je Unternehmer gruppiert</div></div>
        <div class="spacer"></div>
        <button class="btn btn-primary btn-sm" id="genAllBtn">📨 Mails vorbereiten</button>
      </div>
      <div class="mod-body">
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px">
          <div class="stat-card" style="flex:1;min-width:150px"><div class="num">${items.length}</div><div class="lbl">Pendenzen gesamt</div></div>
          <div class="stat-card" style="flex:1;min-width:150px"><div class="num">${assigned.length}</div><div class="lbl">Unternehmer</div></div>
          <div class="stat-card" style="flex:1;min-width:150px"><div class="num" style="${unassignedCount?'color:var(--warn)':''}">${unassignedCount}</div><div class="lbl">Ohne Zuordnung</div></div>
        </div>
        ${unassignedCount?`<div style="background:var(--warn-bg);border:1px solid #e8d9a8;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:13px">
          ⚠ <b>${unassignedCount}</b> Pendenz(en) sind keinem Unternehmer zugeordnet. Beim Mails-Vorbereiten kannst du wählen, was damit geschieht.</div>`:''}
        <div id="pendList"></div>
      </div>
    </div>`;
  document.getElementById('genAllBtn').onclick=()=>openPendenzenMail();
  const wrap=document.getElementById('pendList');
  if(!items.length){wrap.innerHTML=`<div class="empty"><div class="big">📨</div><h3>Keine offenen Pendenzen</h3><p>Sobald du Mängel oder Aktennotizen mit Frist/Unternehmer erfasst, erscheinen sie hier gruppiert.</p></div>`;return;}
  const blocks=[];
  const itemCard=it=>{
    const imgs=[];
    if(it.excerpt)imgs.push(`<figure class="def-img"><img src="${it.excerpt}" class="pend-img"><figcaption>Planausschnitt</figcaption></figure>`);
    (it.photos||[]).forEach((p,i)=>imgs.push(`<figure class="def-img"><img src="${p}" class="pend-img"><figcaption>Foto ${i+1}</figcaption></figure>`));
    return `<div class="def-card" data-pendid="${it.srcId}">
      <button class="card-del" data-pdel="${it.srcId}" data-pstore="${it.srcStore}" title="${it.kind} löschen">×</button>
      <div class="def-card-main">
        <div class="def-card-head">
          <span class="pill">${it.kind}</span>
          ${it.num?`<span class="dr-num">#${String(it.num).padStart(3,'0')}</span>`:''}
        </div>
        <div class="def-card-title">${esc(it.title)}</div>
        ${it.desc?`<div class="def-card-desc">${esc(it.desc)}</div>`:''}
        <div class="def-card-meta"><span>📅 ${it.due?fmtDate(it.due):'—'}</span>${it.trade?`<span>🔧 ${esc(it.trade)}</span>`:''}</div>
      </div>
      ${imgs.length?`<div class="def-card-imgs">${imgs.join('')}</div>`:`<div class="def-card-imgs def-noimg">Keine Bilder</div>`}
    </div>`;
  };
  for(const [cid,list] of assigned){
    const c=contacts.find(x=>x.id===cid);
    blocks.push(`<div style="margin-bottom:22px"><div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <h3 style="font-size:15px">${esc(c?c.company:'Unbekannt')}</h3><span class="pill">${list.length} Pendenz(en)</span>
      ${c&&c.email?`<span style="font-size:12px;color:var(--muted)">${esc(c.email)}</span>`:'<span style="font-size:12px;color:var(--warn)">keine E-Mail hinterlegt</span>'}</div>
      <div class="def-cards">${list.map(itemCard).join('')}</div></div>`);
  }
  if(unassignedCount){
    blocks.push(`<div style="margin-bottom:22px"><div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <h3 style="font-size:15px;color:var(--warn)">Ohne Zuordnung</h3><span class="pill">${unassignedCount}</span></div>
      <div class="def-cards">${groups['_none'].map(itemCard).join('')}</div></div>`);
  }
  wrap.innerHTML=blocks.join('');
  wrap.querySelectorAll('.pend-img').forEach(img=>img.onclick=()=>window.open(img.src,'_blank'));
  wrap.querySelectorAll('.card-del[data-pdel]').forEach(b=>b.onclick=async e=>{
    e.stopPropagation();
    const store=b.dataset.pstore, id=b.dataset.pdel;
    const rec=await get(store,id);
    const label=store==='defects'?('Mangel #'+String(rec?rec.num:'').padStart(3,'0')):('Notiz „'+(rec?rec.title:'')+'"');
    await confirmDelete(store,id,label,async()=>{await renderPendenzen();await renderRail();});
  });
}

async function openPendenzenMail(){
  const items=await collectPendenzen();
  if(!items.length){toast('Keine Pendenzen vorhanden');return;}
  const proj=await get('projects',state.projectId);
  const contacts=await byProject('contacts');
  const groups={};
  items.forEach(it=>{const k=it.assigneeId||'_none';(groups[k]=groups[k]||[]).push(it);});
  const hasUnassigned=(groups['_none']||[]).length>0;
  let includeUnassigned='separat'; // 'separat' | 'weglassen'
  // Aufbau der Gruppenliste (Funktion, da bei Änderung von includeUnassigned neu)
  function buildGroupList(){
    const gl=[];
    Object.entries(groups).forEach(([cid,list])=>{
      if(cid==='_none')return;
      gl.push({cid,contact:contacts.find(x=>x.id===cid),items:list});
    });
    if(hasUnassigned&&includeUnassigned==='separat'){
      gl.push({cid:'_none',contact:null,items:groups['_none']});
    }
    return gl;
  }
  let groupList=buildGroupList();
  let active=groupList[0];

  modal(`<div class="modal-head"><h3>Pendenzen-Mails vorbereiten</h3>
      <p>Pro Unternehmer: Pendenzenliste als PDF + Mail mit deinem projektweiten Autotext.</p></div>
    <div class="modal-body" style="padding:0">
      ${hasUnassigned?`<div style="padding:12px 18px;border-bottom:1px solid var(--line-2);background:var(--warn-bg);font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span>⚠ ${groups['_none'].length} Pendenz(en) ohne Unternehmer:</span>
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="radio" name="unassChoice" value="separat" checked> als eigene Gruppe „Ohne Zuordnung"</label>
        <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="radio" name="unassChoice" value="weglassen"> weglassen</label>
      </div>`:''}
      <div style="display:flex;border-bottom:1px solid var(--line-2);overflow-x:auto" id="pmTabs"></div>
      <div style="padding:18px" id="pmPane"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeModal()">Schliessen</button>
      <button class="btn btn-steel" id="pmPdfBtn">⬇ Nur PDF</button>
      <button class="btn btn-primary" id="pmSendBtn">📨 PDF + Mail</button>
    </div>`,{wide:true});

  if(hasUnassigned){
    document.querySelectorAll('input[name="unassChoice"]').forEach(r=>r.onchange=e=>{
      includeUnassigned=e.target.value;groupList=buildGroupList();
      if(!groupList.includes(active))active=groupList[0];
      renderTabs();renderPane();
    });
  }
  function fillTemplate(tpl,g){
    const due=g.items.map(i=>i.due).filter(Boolean).sort()[0]||'';
    return (tpl||'')
      .replaceAll('{Unternehmer}',g.contact?g.contact.company:'(ohne Zuordnung)')
      .replaceAll('{Projekt}',proj.name||'')
      .replaceAll('{Anzahl}',String(g.items.length))
      .replaceAll('{Frist}',due?fmtDate(due):'—')
      .replaceAll('{Benutzer}',CURRENT_USER.name||'')
      .replaceAll('{Bauherr}',proj.client||'');
  }
  function renderTabs(){
    document.getElementById('pmTabs').innerHTML=groupList.map((g,i)=>{
      const name=g.contact?g.contact.company:'Ohne Zuordnung';
      return `<button data-i="${i}" style="padding:11px 15px;font-size:13px;font-weight:600;white-space:nowrap;border-bottom:2px solid ${g===active?'var(--brand-red)':'transparent'};color:${g===active?'var(--brand-red)':'var(--muted)'}">${esc(name)} <span style="opacity:.7">(${g.items.length})</span></button>`;
    }).join('');
    document.querySelectorAll('#pmTabs button').forEach(b=>b.onclick=()=>{active=groupList[+b.dataset.i];renderTabs();renderPane();});
  }
  function renderPane(){
    const g=active;const c=g.contact;
    document.getElementById('pmPane').innerHTML=`
      <div class="mail-preview">
        <div class="mail-field"><div class="k">An</div><div class="v"><input id="pmTo" value="${c&&c.email?esc(c.email):''}" placeholder="${c?'keine E-Mail hinterlegt':'(ohne Zuordnung – manuell eintragen)'}"></div></div>
        <div class="mail-field"><div class="k">Betreff</div><div class="v"><input id="pmSubj" value="Pendenzenliste – ${esc(proj.name)} (${g.items.length})"></div></div>
        <textarea class="mail-body-edit" id="pmBody">${esc(fillTemplate(proj.mailTemplate,g))}</textarea>
      </div>
      <div style="margin-top:8px;font-size:12px;color:var(--muted)">📎 Die Pendenzenliste „${esc(c?c.company:'Ohne Zuordnung')}" wird als PDF angehängt (Handy) bzw. heruntergeladen (Desktop).</div>`;
  }
  async function makePDF(g){
    return buildPendenzPDF(g,proj);
  }
  document.getElementById('pmPdfBtn').onclick=async()=>{
    const blob=await makePDF(active);
    const fn=`Pendenzenliste_${(active.contact?active.contact.company:'ohne_Zuordnung').replace(/\s+/g,'_')}.pdf`;
    downloadBlob(blob,fn);toast('PDF erstellt',true);
  };
  document.getElementById('pmSendBtn').onclick=async()=>{
    const g=active;
    const to=document.getElementById('pmTo').value.trim();
    const subj=document.getElementById('pmSubj').value;
    const body=document.getElementById('pmBody').value;
    const blob=await makePDF(g);
    const fn=`Pendenzenliste_${(g.contact?g.contact.company:'ohne_Zuordnung').replace(/\s+/g,'_')}.pdf`;
    const file=new File([blob],fn,{type:'application/pdf'});
    // Web Share mit Datei (v.a. Handy): PDF als echter Anhang
    if(navigator.canShare&&navigator.canShare({files:[file]})){
      try{
        await navigator.share({files:[file],title:subj,text:body});
        toast('Geteilt – Mailprogramm wählen',true);return;
      }catch(e){if(e&&e.name==='AbortError')return;}
    }
    // Fallback (Desktop): PDF herunterladen + Mailentwurf öffnen
    downloadBlob(blob,fn);
    setTimeout(()=>{window.location.href=`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`;},300);
    toast('PDF heruntergeladen – Mailentwurf geöffnet. PDF bitte anhängen.',true);
  };
  renderTabs();renderPane();
}

function downloadBlob(blob,filename){
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(url);a.remove();},1000);
}

function buildPendenzPDF(g,proj){
  const {jsPDF}=window.jspdf;const doc=new jsPDF();
  let y=pdfDocHead(doc,'Pendenzenliste',[
    {l:proj.name,proj:true},
    {l:'Unternehmer: '+(g.contact?g.contact.company:'Ohne Zuordnung')},
    {l:'Stand: '+new Date().toLocaleString('de-CH')},
    {l:'Pendenzen: '+g.items.length}
  ]);
  const C={art:PDF.ML+2, title:PDF.ML+26, due:170};
  const titleW=120, descW=120;
  const drawHeader=(yy)=>{
    doc.setFillColor(240,236,229);doc.rect(PDF.ML,yy,182,7,'F');
    doc.setTextColor(107,98,88);doc.setFontSize(8);doc.setFont(undefined,'bold');
    doc.text('Art',C.art,yy+4.7);doc.text('Pendenz',C.title,yy+4.7);doc.text('Frist',C.due,yy+4.7);
    doc.setFont(undefined,'normal');
    return yy+10;
  };
  y=drawHeader(y);
  g.items.sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999')).forEach(it=>{
    const titleText=(it.num?'#'+String(it.num).padStart(3,'0')+'  ':'')+it.title;
    const t=pdfTextHeight(doc,titleText,titleW,PDF.LH);
    let descBlock=null;
    if(it.desc) descBlock=pdfTextHeight(doc,it.desc,descW,PDF.LH_S);
    const rowH=t.h+(descBlock?descBlock.h+1:0)+4;
    y=pdfEnsureSpace(doc,y,rowH,()=>drawHeader(20));
    const top=y+4;
    doc.setTextColor(168,57,42);doc.setFontSize(8);doc.text(it.kind,C.art,top);
    doc.setTextColor(26,26,26);doc.setFontSize(9);doc.text(t.lines,C.title,top);
    doc.setTextColor(90);doc.setFontSize(8);doc.text(it.due?fmtDate(it.due):'—',C.due,top);
    if(descBlock){doc.setTextColor(130);doc.setFontSize(8);doc.text(descBlock.lines,C.title,top+t.h);}
    const lineY=y+rowH-1.5;
    doc.setDrawColor(232,227,219);doc.setLineWidth(0.2);doc.line(PDF.ML,lineY,PDF.MR,lineY);
    y+=rowH;
  });
  pdfFooterAllPages(doc);
  return doc.output('blob');
}

async function exportDefectPDF(rows){
  const {jsPDF}=window.jspdf;const doc=new jsPDF();
  const proj=await get('projects',state.projectId);
  let y=pdfDocHead(doc,'Pendenzen- & Mängelliste',[
    {l:proj.name,proj:true},
    {l:proj.client||''},
    {l:'Stand: '+new Date().toLocaleString('de-CH')},
    {l:'Einträge: '+rows.length}
  ]);
  // Spalten (nur für Text-only-Zeilen ohne Bilder)
  const C={nr:PDF.ML+2, title:PDF.ML+12, comp:118, due:158, status:176};
  const titleW=98, descW=98;
  const drawHeader=(yy)=>{
    doc.setFillColor(240,236,229);doc.rect(PDF.ML,yy,182,7,'F');
    doc.setTextColor(107,98,88);doc.setFontSize(8);doc.setFont(undefined,'bold');
    doc.text('Nr',C.nr,yy+4.7);doc.text('Mangel',C.title,yy+4.7);
    doc.text('Unternehmer',C.comp,yy+4.7);doc.text('Frist',C.due,yy+4.7);doc.text('Status',C.status,yy+4.7);
    doc.setFont(undefined,'normal');
    return yy+10;
  };
  // Bild in eine Box einpassen (proportional, ohne Verzerrung, vertikal zentriert), gibt tatsächliche Höhe zurück
  const drawBoxedImage=(imgData,x,yy,boxW,boxH)=>{
    try{
      const props=doc.getImageProperties(imgData);
      const ratio=props.width/props.height;
      let w=boxW,h=boxW/ratio;
      if(h>boxH){h=boxH;w=boxH*ratio;}
      const cy=yy+(boxH-h)/2, cx=x+(boxW-w)/2;
      doc.addImage(imgData,cx,cy,w,h);
      doc.setDrawColor(215);doc.setLineWidth(0.2);doc.rect(cx,cy,w,h);
    }catch(e){}
  };
  y=drawHeader(y);
  const CARD_PAD=6, IMG_GAP=4, CARD_GAP=6;
  // Feste Ziel-Kartenhöhe, damit auf jeder Seite exakt 2 Mängel mit Bild Platz finden.
  // Auf Basis der TATSÄCHLICHEN Startposition berechnet (Kopfzeile ist je nach Projektname/Kunde
  // unterschiedlich hoch) – so passen garantiert 2 Karten, auch auf der ersten Seite.
  const TARGET_CARD_H=(PDF.FOOT_LIMIT-y-CARD_GAP)/2;
  let cardsOnPage=0;
  rows.sort((a,b)=>a.num-b.num).forEach(d=>{
    // Bilder sammeln: Planausschnitt zuerst, dann alle Fotos (kein Limit – wird zu 4er-Reihen umgebrochen)
    const images=[];
    if(d.excerpt) images.push(d.excerpt);
    (d.photos||[]).forEach(p=>images.push(p));
    const hasImages=images.length>0;

    if(!hasImages){
      // --- Kompakte Textzeile (unverändert) ---
      const t=pdfTextHeight(doc,d.title||'—',titleW,PDF.LH);
      let descBlock=null;
      if(d.desc) descBlock=pdfTextHeight(doc,d.desc,descW,PDF.LH_S);
      const rowH=t.h + (descBlock?descBlock.h+1:0) + 4;
      y=pdfEnsureSpace(doc,y,rowH,()=>{cardsOnPage=0;return drawHeader(20);});
      const top=y+4;
      doc.setTextColor(26,26,26);doc.setFontSize(9);
      doc.text('#'+String(d.num).padStart(3,'0'),C.nr,top);
      doc.text(t.lines,C.title,top);
      doc.setTextColor(90);doc.setFontSize(8);
      doc.text(doc.splitTextToSize(d.assignee||'—',36),C.comp,top);
      doc.text(fmtDate(d.due),C.due,top);
      doc.text(d.status,C.status,top);
      if(descBlock){doc.setTextColor(130);doc.setFontSize(8);doc.text(descBlock.lines,C.title,top+t.h);}
      const lineY=y+rowH-1.5;
      doc.setDrawColor(232,227,219);doc.setLineWidth(0.2);doc.line(PDF.ML,lineY,PDF.MR,lineY);
      y+=rowH;
      return;
    }

    // --- Grosse Karte (Planausschnitt/Foto vorhanden) – exakt 2 pro Seite ---
    // Nach 2 Karten auf der aktuellen Seite: zwingend neue Seite (statt nur "wenn kein Platz mehr").
    if(cardsOnPage>=2){ doc.addPage(); y=drawHeader(20); cardsOnPage=0; }
    const innerW=182-2*CARD_PAD;
    const cols=Math.min(images.length,4);
    const nRows=Math.ceil(images.length/4);
    const headTxt=`#${String(d.num).padStart(3,'0')}  ${d.title||'(ohne Titel)'}`;
    const titleBlock=pdfTextHeight(doc,headTxt,innerW,5.6);
    const descBlock=d.desc?pdfTextHeight(doc,d.desc,innerW,4.6):null;
    const metaH=5.5;
    const textH=titleBlock.h + (descBlock?descBlock.h+1.5:0) + metaH + 2;
    // Bildgrösse aus der FESTEN Kartenhöhe ableiten, damit die Karte immer gleich hoch bleibt (2 pro Seite).
    const IMG_W=(innerW-(cols-1)*IMG_GAP)/cols;
    let IMG_H=(TARGET_CARD_H-CARD_PAD*2-textH-4-(nRows-1)*IMG_GAP)/nRows;
    IMG_H=Math.max(25,Math.min(IMG_H,IMG_W*1.4)); // nie zu klein, nie unnötig überhoch
    const imagesH=nRows*IMG_H + (nRows-1)*IMG_GAP;
    // Karte wächst nur über die Zielhöhe hinaus, wenn der Inhalt (z.B. sehr langer Text) es zwingend braucht.
    const cardH=Math.max(TARGET_CARD_H, CARD_PAD*2 + textH + 4 + imagesH);
    // Passt die Karte nicht mehr auf die aktuelle Seite -> neue Seite, Zähler zurücksetzen
    if(y+cardH>PDF.FOOT_LIMIT){ doc.addPage(); y=drawHeader(20); cardsOnPage=0; }
    // Karten-Hintergrund zur optischen Abgrenzung
    doc.setFillColor(250,248,244);doc.setDrawColor(228,222,212);doc.setLineWidth(0.3);
    doc.roundedRect(PDF.ML,y,182,cardH,2,2,'FD');
    let ty=y+CARD_PAD+4.5;
    doc.setTextColor(26,26,26);doc.setFontSize(11.5);doc.setFont(undefined,'bold');
    doc.text(titleBlock.lines,PDF.ML+CARD_PAD,ty);doc.setFont(undefined,'normal');
    ty+=titleBlock.h;
    if(descBlock){doc.setTextColor(90);doc.setFontSize(9);doc.text(descBlock.lines,PDF.ML+CARD_PAD,ty);ty+=descBlock.h+1.5;}
    doc.setTextColor(130);doc.setFontSize(8);
    doc.text(`Unternehmer: ${d.assignee||'—'}    Frist: ${fmtDate(d.due)}    Status: ${d.status}`,PDF.ML+CARD_PAD,ty+3);
    // Bilder-Raster: max. 4 pro Zeile, danach nächste Zeile
    let imgX=PDF.ML+CARD_PAD, imgY=y+CARD_PAD+textH+4;
    images.forEach((img,i)=>{
      if(i>0 && i%4===0){ imgX=PDF.ML+CARD_PAD; imgY+=IMG_H+IMG_GAP; }
      drawBoxedImage(img,imgX,imgY,IMG_W,IMG_H);
      imgX+=IMG_W+IMG_GAP;
    });
    y+=cardH+CARD_GAP;
    cardsOnPage++;
  });
  pdfFooterAllPages(doc);
  doc.save(`Maengelliste_${(proj.name||'').replace(/\s+/g,'_')}.pdf`);
  toast('PDF-Liste erstellt',true);
}

/* ============================================================
   MAIL-COMPOSER: automatische Mängel-Mails pro Unternehmer
   ============================================================ */
async function openMailComposer(rows){
  if(!rows.length){toast('Keine Einträge zum Versenden');return;}
  const proj=await get('projects',state.projectId);
  const contacts=await byProject('contacts');
  // Gruppieren nach Unternehmer
  const groups={};
  rows.forEach(d=>{const key=d.assigneeId||'_none';(groups[key]=groups[key]||[]).push(d);});
  const groupList=Object.entries(groups).map(([cid,ds])=>{
    const c=contacts.find(x=>x.id===cid);
    return {cid,contact:c,defs:ds};
  });
  let active=groupList[0];
  modal(`<div class="modal-head"><h3>Mängel-Mails vorbereiten</h3><p>Pro Unternehmer wird automatisch eine E-Mail mit den zugewiesenen Mängeln erstellt.</p></div>
    <div class="modal-body" style="padding:0">
      <div style="display:flex;border-bottom:1px solid var(--line-2);overflow-x:auto" id="mailTabs"></div>
      <div style="padding:18px" id="mailPane"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeModal()">Schliessen</button>
      <button class="btn btn-steel" id="copyMailBtn">Text kopieren</button>
      <button class="btn btn-primary" id="openMailBtn">In Mail-App öffnen</button>
    </div>`,{wide:true});
  function buildBody(g){
    const c=g.contact;
    const lines=g.defs.sort((a,b)=>a.num-b.num).map(d=>
      `#${String(d.num).padStart(3,'0')}  ${d.title||'(ohne Titel)'}\n   ${d.desc||''}\n   Gewerk: ${d.trade||'—'} | Frist: ${fmtDate(d.due)} | Status: ${d.status}`).join('\n\n');
    const anrede=c?`Sehr geehrte Damen und Herren der ${c.company}`:'Sehr geehrte Damen und Herren';
    return `${anrede}\n\n`
      +`im Rahmen des Projekts „${proj.name}" wurden Ihnen folgende Pendenzen/Mängel zugewiesen. `
      +`Wir bitten Sie um fristgerechte Behebung und Rückmeldung.\n\n`
      +`────────────────────────\n${lines}\n────────────────────────\n\n`
      +`Bei Rückfragen stehen wir gerne zur Verfügung.\n\nFreundliche Grüsse\n${CURRENT_USER.name}\n${proj.client||''}`;
  }
  function renderTabs(){
    document.getElementById('mailTabs').innerHTML=groupList.map((g,i)=>{
      const name=g.contact?g.contact.company:'Ohne Zuweisung';
      return `<button data-i="${i}" style="padding:11px 15px;font-size:13px;font-weight:600;white-space:nowrap;border-bottom:2px solid ${g===active?'var(--signal)':'transparent'};color:${g===active?'var(--signal)':'var(--muted)'}">${esc(name)} <span style="opacity:.7">(${g.defs.length})</span></button>`;
    }).join('');
    document.querySelectorAll('#mailTabs button').forEach(b=>b.onclick=()=>{active=groupList[+b.dataset.i];renderTabs();renderPane();});
  }
  function renderPane(){
    const g=active;const c=g.contact;
    document.getElementById('mailPane').innerHTML=`
      <div class="mail-preview">
        <div class="mail-field"><div class="k">An</div><div class="v"><input id="mTo" value="${c?esc(c.email):''}" placeholder="${c?'':'Keine E-Mail hinterlegt'}"></div></div>
        <div class="mail-field"><div class="k">Betreff</div><div class="v"><input id="mSubj" value="Pendenzen-/Mängelliste – ${esc(proj.name)} (${g.defs.length})"></div></div>
        <textarea class="mail-body-edit" id="mBody">${esc(buildBody(g))}</textarea>
      </div>
      ${!c?`<div style="margin-top:10px;font-size:12.5px;color:var(--warn)">⚠ Für diese Gruppe ist kein Unternehmer mit E-Mail hinterlegt. Adresse manuell ergänzen oder im Modul „Adressliste" zuweisen.</div>`:''}`;
  }
  document.getElementById('openMailBtn').onclick=()=>{
    const to=document.getElementById('mTo').value, subj=document.getElementById('mSubj').value, body=document.getElementById('mBody').value;
    window.location.href=`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`;
    toast('Mail-Entwurf geöffnet',true);
  };
  document.getElementById('copyMailBtn').onclick=async()=>{
    const body=document.getElementById('mBody').value;
    try{await navigator.clipboard.writeText(body);toast('Text kopiert',true);}catch(e){toast('Kopieren nicht möglich');}
  };
  renderTabs();renderPane();
}

/* ============================================================
   MODULE: PROTOKOLLE (Sitzungs-/Bauprotokoll aus Mängeln erzeugen)
   ============================================================ */
async function renderProtocols(){
  const stage=document.getElementById('stage');
  const protos=(await byProject('protocols')).sort((a,b)=>b.date.localeCompare(a.date));
  stage.innerHTML=`
    <div class="module">
      <div class="mod-head"><div><h1>Protokolle</h1><div class="sub">Sitzungs- & Bauprotokolle · Pendenzen aus Mängelliste übernehmbar</div></div>
        <div class="spacer"></div><button class="btn btn-primary btn-sm" id="newProtoBtn">＋ Neues Protokoll</button></div>
      <div class="mod-body">
        ${protos.length?`<div class="cards">${protos.map(p=>`
          <div class="card" data-id="${p.id}">
            <button class="card-del" data-del="${p.id}" title="Protokoll löschen">×</button>
            <h4>${esc(p.title)}</h4>
            <div class="meta">Nr. ${esc(p.number||'—')}<br>📅 ${fmtDate(p.date)}<br>👥 ${(p.attendees||[]).length} Teilnehmer<br>📌 ${(p.items||[]).length} Traktanden</div>
          </div>`).join('')}</div>`
        :`<div class="empty"><div class="big">📋</div><h3>Noch keine Protokolle</h3><p>Erstelle ein Sitzungs- oder Bauprotokoll. Offene Mängel lassen sich als Pendenzen direkt übernehmen.</p></div>`}
      </div>
    </div>`;
  document.getElementById('newProtoBtn').onclick=()=>openProtocolEditor();
  document.querySelectorAll('.card[data-id]').forEach(c=>c.onclick=async e=>{if(e.target.closest('.card-del'))return;openProtocolEditor(await get('protocols',c.dataset.id));});
  document.querySelectorAll('.card-del[data-del]').forEach(b=>b.onclick=async e=>{e.stopPropagation();const p=await get('protocols',b.dataset.del);await confirmDelete('protocols',b.dataset.del,p?p.title:'Protokoll',renderProtocols);});
}
async function openProtocolEditor(p){
  const proj=await get('projects',state.projectId);
  const contacts=await byProject('contacts');
  const defs=(await byProject('defects')).filter(d=>d.status!=='Erledigt').sort((a,b)=>a.num-b.num);
  const isNew=!p;
  p=p||{id:uid(),projectId:state.projectId,title:'Bausitzung',number:'',date:todayISO(),location:proj.address||'',attendees:[],items:[],createdAt:nowISO()};
  modal(`<div class="modal-head"><h3>${isNew?'Neues Protokoll':'Protokoll bearbeiten'}</h3></div>
    <div class="modal-body">
      <div class="field-row">
        <div class="field"><label>Titel</label><input id="p-title" value="${esc(p.title)}"></div>
        <div class="field" style="max-width:120px"><label>Nr.</label><input id="p-number" value="${esc(p.number)}" placeholder="2026-01"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Datum</label><input type="date" id="p-date" value="${p.date}"></div>
        <div class="field"><label>Ort</label><input id="p-location" value="${esc(p.location)}"></div>
      </div>
      <div class="field"><label>Teilnehmer</label>
        <div class="pill-row" id="attPills"></div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <select id="attAdd" style="flex:1;min-width:180px"><option value="">+ Aus Unternehmerliste…</option>${contacts.map(c=>`<option value="${c.id}">${esc(c.contact)} – ${esc(c.company)}</option>`).join('')}</select>
          <input id="attFree" placeholder="Externe Person eingeben…" style="flex:1;min-width:180px">
          <button class="btn btn-ghost btn-sm" id="attFreeBtn" type="button">＋ Hinzufügen</button>
        </div>
      </div>
      <div class="field">
        <label>Traktanden / Pendenzen</label>
        <div id="protoItems"></div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-ghost btn-sm" id="addItemBtn">＋ Traktandum</button>
          <button class="btn btn-steel btn-sm" id="importDefBtn">⚠ Offene Mängel übernehmen (${defs.length})</button>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      ${isNew?'':'<button class="btn btn-danger" id="protoDelBtn">Löschen</button>'}
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-steel" id="protoPdfBtn">⬇ Als PDF</button>
      <button class="btn btn-primary" id="protoSaveBtn">Speichern</button>
    </div>`,{wide:true});
  let attendees=[...p.attendees], items=JSON.parse(JSON.stringify(p.items||[]));
  function drawAtt(){
    document.getElementById('attPills').innerHTML=attendees.map((a,i)=>`<span class="pill">${esc(a.name)}${a.external?' <span style="opacity:.7;font-size:10px">(extern)</span>':''} <b data-i="${i}" style="cursor:pointer;color:var(--signal)">×</b></span>`).join('')||'<span style="font-size:12px;color:var(--muted)">Keine Teilnehmer</span>';
    document.querySelectorAll('#attPills b').forEach(b=>b.onclick=()=>{attendees.splice(+b.dataset.i,1);drawAtt();});
  }
  document.getElementById('attAdd').onchange=async e=>{if(!e.target.value)return;const c=await get('contacts',e.target.value);attendees.push({name:c.contact+' ('+c.company+')'});e.target.value='';drawAtt();};
  const addFree=()=>{const inp=document.getElementById('attFree');const v=inp.value.trim();if(!v)return;attendees.push({name:v,external:true});inp.value='';drawAtt();};
  document.getElementById('attFreeBtn').onclick=addFree;
  document.getElementById('attFree').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();addFree();}};
  function drawItems(){
    document.getElementById('protoItems').innerHTML=items.map((it,i)=>`
      <div style="border:1px solid var(--line-2);border-radius:8px;padding:10px;margin-bottom:8px;background:var(--paper-2)">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
          <input data-i="${i}" data-k="topic" value="${esc(it.topic)}" placeholder="Thema" style="flex:1;border:none;font-weight:600;background:transparent;font-size:14px">
          <b style="font-weight:600;font-size:14px;color:var(--ink)">${i+1}.</b>
          <span class="status-tag status-${statusKey(it.status||'Offen')}">${it.status||'Offen'}</span>
          <b data-del="${i}" style="cursor:pointer;color:var(--signal)">×</b>
        </div>
        <textarea data-i="${i}" data-k="text" placeholder="Beschluss / Beschreibung…" style="width:100%;border:1px solid var(--line);border-radius:6px;padding:7px;min-height:42px;background:var(--paper)">${esc(it.text)}</textarea>
        <div style="display:flex;gap:8px;margin-top:6px">
          <input data-i="${i}" data-k="responsible" value="${esc(it.responsible||'')}" placeholder="Zuständig" style="flex:1;border:1px solid var(--line);border-radius:6px;padding:6px;background:var(--paper);font-size:12.5px">
          <input data-i="${i}" data-k="due" type="date" value="${it.due||''}" style="border:1px solid var(--line);border-radius:6px;padding:6px;background:var(--paper);font-size:12.5px">
        </div>
        <div class="photo-grid" style="margin-top:8px;grid-template-columns:repeat(5,1fr)">${(it.photos||[]).map((ph,pi)=>`<img src="${ph}" data-pimg="${i}-${pi}">`).join('')}<button class="photo-add" data-padd="${i}" title="Foto">＋</button></div>
      </div>`).join('');
    document.querySelectorAll('#protoItems [data-k]').forEach(el=>el.oninput=()=>{items[+el.dataset.i][el.dataset.k]=el.value;});
    document.querySelectorAll('#protoItems [data-del]').forEach(b=>b.onclick=()=>{items.splice(+b.dataset.del,1);drawItems();});
    document.querySelectorAll('#protoItems [data-padd]').forEach(b=>b.onclick=()=>{const idx=+b.dataset.padd;openPhotoSource(b64=>{items[idx].photos=items[idx].photos||[];items[idx].photos.push(b64);drawItems();});});
    document.querySelectorAll('#protoItems [data-pimg]').forEach(img=>img.onclick=()=>window.open(img.src,'_blank'));
  }
  document.getElementById('addItemBtn').onclick=()=>{items.push({topic:'',text:'',responsible:'',due:'',status:'Offen',photos:[]});drawItems();};
  document.getElementById('importDefBtn').onclick=(ev)=>{
    const btn=ev.currentTarget;
    // bereits importierte Mängel nicht erneut hinzufügen (Duplikat-Schutz)
    const already=new Set(items.filter(it=>it.fromDefect).map(it=>it.fromDefect));
    const toAdd=defs.filter(d=>!already.has(d.num));
    if(!toAdd.length){toast('Alle offenen Mängel sind bereits übernommen');return;}
    toAdd.forEach(d=>items.push({topic:`Mangel #${String(d.num).padStart(3,'0')}: ${d.title||''}`,text:d.desc||'',responsible:d.assignee||'',due:d.due||'',status:d.status,fromDefect:d.num}));
    drawItems();toast(`${toAdd.length} Mängel übernommen`,true);
  };
  function collect(){
    p.title=document.getElementById('p-title').value;p.number=document.getElementById('p-number').value;
    p.date=document.getElementById('p-date').value;p.location=document.getElementById('p-location').value;
    p.attendees=attendees;p.items=items;return p;
  }
  document.getElementById('protoSaveBtn').onclick=async(ev)=>{if(guardBusy(ev.currentTarget))return;await put('protocols',collect());closeModal();toast('Protokoll gespeichert',true);renderProtocols();};
  document.getElementById('protoPdfBtn').onclick=()=>exportProtocolPDF(collect(),proj);
  if(!isNew){const pd=document.getElementById('protoDelBtn');if(pd)pd.onclick=async()=>{const ok=await confirmDelete('protocols',p.id,p.title||'Protokoll',renderProtocols);if(ok)closeModal();};}
  drawAtt();drawItems();
}
async function exportProtocolPDF(p,proj){
  const {jsPDF}=window.jspdf;const doc=new jsPDF();
  let y=pdfDocHead(doc,p.title||'Protokoll',[
    {l:proj.name,proj:true},
    {l:`Protokoll-Nr. ${p.number||'—'}`}
  ]);
  // Kopf-Infozeilen
  doc.setTextColor(40);doc.setFontSize(10);
  doc.text(`Datum: ${fmtDate(p.date)}`,PDF.ML,y);doc.text(`Ort: ${p.location||'—'}`,90,y);y+=6;
  const teil=pdfTextHeight(doc,`Teilnehmer: ${(p.attendees||[]).map(a=>a.name).join(', ')||'—'}`,182,5);
  doc.text(teil.lines,PDF.ML,y);y+=teil.h+3;
  doc.setDrawColor(200);doc.setLineWidth(0.3);doc.line(PDF.ML,y,PDF.MR,y);y+=7;
  (p.items||[]).forEach((it,i)=>{
    const numTxt=(i+1)+'.';
    const titleBlock=pdfTextHeight(doc,it.topic||'',160,5.4);
    const textBlock=it.text?pdfTextHeight(doc,it.text,180,PDF.LH_S):null;
    const blockH=titleBlock.h+(textBlock?textBlock.h+2:0)+5+4;
    y=pdfEnsureSpace(doc,y,blockH,()=>20);
    doc.setTextColor(26,26,26);doc.setFontSize(11);doc.setFont(undefined,'bold');
    doc.text(titleBlock.lines,PDF.ML,y+4);
    doc.text(numTxt,PDF.MR,y+4,{align:'right'}); // Nummer rechts, gleiche Darstellung (fett, gleiche Größe)
    doc.setFont(undefined,'normal');
    let yy=y+4+titleBlock.h-1;
    if(textBlock){doc.setTextColor(70);doc.setFontSize(9);doc.text(textBlock.lines,PDF.ML,yy+1);yy+=textBlock.h+1;}
    doc.setTextColor(120);doc.setFontSize(8);
    doc.text(`Zuständig: ${it.responsible||'—'}    Termin: ${fmtDate(it.due)}    Status: ${it.status||'Offen'}`,PDF.ML,yy+3);
    const lineY=y+blockH-1.5;
    doc.setDrawColor(232,227,219);doc.setLineWidth(0.2);doc.line(PDF.ML,lineY,PDF.MR,lineY);
    y+=blockH;
  });
  pdfFooterAllPages(doc);
  doc.save(`Protokoll_${(p.number||p.date)}.pdf`);toast('Protokoll-PDF erstellt',true);
}

/* ============================================================
   MODULE: ABNAHMEPROTOKOLL SIA 118
   ============================================================ */
async function renderAcceptance(){
  const stage=document.getElementById('stage');
  const accs=(await byProject('acceptances')).sort((a,b)=>b.date.localeCompare(a.date));
  const countDefs=a=>(a.units||[]).reduce((s,u)=>s+(u.rooms||[]).reduce((s2,r)=>s2+(r.defects||[]).length,0),0);
  stage.innerHTML=`
    <div class="module">
      <div class="mod-head"><div><h1>Abnahmeprotokoll</h1><div class="sub">Angelehnt an SIA 118 (Art. 157 ff.) · Zimmer-für-Zimmer-Rundgang · Unterschrift</div></div>
        <div class="spacer"></div><button class="btn btn-primary btn-sm" id="newAccBtn">＋ Neue Abnahme</button></div>
      <div class="mod-body">
        ${accs.length?`<div class="cards">${accs.map(a=>`<div class="card" data-id="${a.id}"><button class="card-del" data-del="${a.id}" title="Abnahme löschen">×</button><h4>${esc(a.object||'Abnahme')}</h4>
          <div class="meta">📅 ${fmtDate(a.date)}<br>Unternehmer: ${esc(a.contractor||'—')}<br>🏠 ${(a.units||[]).length} Bereich(e) · ⚠ ${countDefs(a)} Mängel<br>${a.signed?'✓ unterzeichnet':'offen'}</div></div>`).join('')}</div>`
        :`<div class="empty"><div class="big">✓</div><h3>Keine Abnahmen</h3><p>Erstelle ein Abnahmeprotokoll und erfasse Mängel direkt beim Rundgang, Zimmer für Zimmer.</p></div>`}
      </div>
    </div>`;
  document.getElementById('newAccBtn').onclick=()=>openAcceptanceEditor();
  document.querySelectorAll('.card[data-id]').forEach(c=>c.onclick=async e=>{if(e.target.closest('.card-del'))return;openAcceptanceEditor(await get('acceptances',c.dataset.id));});
  document.querySelectorAll('.card-del[data-del]').forEach(b=>b.onclick=async e=>{e.stopPropagation();const a=await get('acceptances',b.dataset.del);await confirmDelete('acceptances',b.dataset.del,a?(a.object||'Abnahme'):'Abnahme',renderAcceptance);});
}
// Migriert alte, flache Mängellisten (vor der Zimmer-Struktur) in einen "Allgemein"-Bereich, ohne Daten zu verlieren.
function _acceptanceNormalize(a){
  if(!Array.isArray(a.units))a.units=[];
  if(Array.isArray(a.defects)&&a.defects.length){
    a.units.push({id:uid(),label:'Allgemein (übernommen)',rooms:[{id:uid(),name:'Allgemein',defects:a.defects.map(d=>({
      id:uid(),text:d.title||'',photos:[],severity:'optisch',due:d.due||'',fixed:false
    }))}]});
    delete a.defects;
  }
  return a;
}
async function openAcceptanceEditor(a){
  const proj=await get('projects',state.projectId);
  const contacts=await byProject('contacts');
  const isNew=!a;
  a=a?_acceptanceNormalize(JSON.parse(JSON.stringify(a))):{id:uid(),projectId:state.projectId,object:proj.name,date:todayISO(),contractor:'',contractorId:'',
    type:'Gemeinsame Prüfung',result:'Abnahme unter Vorbehalt',units:[],remarks:'',signed:false,sigBuilder:'',sigContractor:''};
  const draftKeyId=isNew?'new':a.id;
  const draft=_draftLoad('acc',draftKeyId);
  let restored=false;
  if(draft){a=draft;restored=true;}
  modal(`<div class="modal-head"><h3>${isNew?'Neues':''} Abnahmeprotokoll <span style="color:var(--muted);font-weight:400">SIA 118</span></h3><p>${restored?'<b style="color:var(--brand-red)">Nicht gespeicherter Entwurf wiederhergestellt.</b> ':''}Zimmer für Zimmer erfassen – jeder Mangel mit Foto, Einschätzung und Behebungstermin.</p></div>
    <div class="modal-body">
      <div class="field-row">
        <div class="field"><label>Bauobjekt</label><input id="a-object" value="${esc(a.object)}"></div>
        <div class="field" style="max-width:150px"><label>Datum</label><input type="date" id="a-date" value="${a.date}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Unternehmer</label><select id="a-contractor"><option value="">— wählen —</option>${contacts.map(c=>`<option value="${c.id}" ${c.id===a.contractorId?'selected':''}>${esc(c.company)}</option>`).join('')}</select></div>
        <div class="field"><label>Art der Abnahme</label><select id="a-type">${['Gemeinsame Prüfung (Art. 158)','Abnahme (Art. 157)','Nachkontrolle'].map(t=>`<option ${a.type===t?'selected':''}>${t}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Ergebnis</label><select id="a-result">${['Abnahme ohne Vorbehalt','Abnahme unter Vorbehalt','Abnahme verweigert'].map(r=>`<option ${a.result===r?'selected':''}>${r}</option>`).join('')}</select></div>

      <div class="field" style="border-top:1px solid var(--line);padding-top:12px;margin-top:8px">
        <label>Rundgang <span style="font-weight:400;color:var(--muted);font-size:12px">– Bereich frei benennen (z.B. "Wohnung 3.OG links", "Erdgeschoss", "Einfamilienhaus")</span></label>
        <div id="accUnits" style="display:flex;flex-direction:column;gap:12px;margin-top:8px"></div>
        <button class="btn btn-steel btn-sm" id="addUnitBtn" type="button" style="margin-top:10px">＋ Bereich (Wohnung/Geschoss/Haus)</button>
      </div>

      <div class="field" style="margin-top:14px"><label>Bemerkungen</label><textarea id="a-remarks">${esc(a.remarks)}</textarea></div>
      <div class="field-row">
        <div class="field"><label>Unterschrift Bauleitung</label><canvas class="sign-pad" id="sigB" width="300" height="90"></canvas><button class="btn btn-ghost btn-sm" id="clrB" style="margin-top:4px" type="button">Löschen</button></div>
        <div class="field"><label>Unterschrift Unternehmer</label><canvas class="sign-pad" id="sigC" width="300" height="90"></canvas><button class="btn btn-ghost btn-sm" id="clrC" style="margin-top:4px" type="button">Löschen</button></div>
      </div>
    </div>
    <div class="modal-foot">
      ${isNew?'':'<button class="btn btn-danger" id="accDelBtn">Löschen</button>'}
      <button class="btn btn-ghost" id="accCancelBtn">Abbrechen</button>
      <button class="btn btn-steel" id="accPdfBtn">⬇ Als PDF</button>
      <button class="btn btn-primary" id="accSaveBtn">Speichern</button>
    </div>`,{wide:true});

  function collect(){
    const objEl=document.getElementById('a-object');if(!objEl)return a;
    a.object=objEl.value;a.date=document.getElementById('a-date').value;
    a.contractorId=document.getElementById('a-contractor').value;
    const c=contacts.find(x=>x.id===a.contractorId);a.contractor=c?c.company:'';
    a.type=document.getElementById('a-type').value;a.result=document.getElementById('a-result').value;
    a.remarks=document.getElementById('a-remarks').value;
    return a;
  }
  const saveDraftDebounced=_debounce(()=>{collect();_draftSave('acc',draftKeyId,a);},500);
  document.querySelector('.modal-body').addEventListener('input',saveDraftDebounced);

  const SEV=[{v:'erheblich',l:'⚠ Erheblich',c:'#c8481c'},{v:'optisch',l:'◯ Optisch',c:'#8a8378'}];
  function drawUnits(){
    document.getElementById('accUnits').innerHTML=a.units.map((u,ui)=>`
      <div style="border:1px solid var(--line-2);border-radius:10px;padding:10px;background:var(--paper-2)">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <input data-uk="label" data-ui="${ui}" value="${esc(u.label)}" placeholder="Bereich, z.B. Wohnung 2.OG" style="flex:1;border:none;background:transparent;font-weight:700;font-size:14px">
          <button class="row-del" data-rmunit="${ui}" type="button" title="Bereich entfernen">×</button>
        </div>
        <div data-rooms="${ui}" style="display:flex;flex-direction:column;gap:8px;margin-left:4px"></div>
        <button class="btn btn-ghost btn-sm" data-addroom="${ui}" type="button" style="margin-top:8px">＋ Zimmer</button>
      </div>`).join('');
    a.units.forEach((u,ui)=>drawRooms(ui));
    document.querySelectorAll('[data-uk="label"]').forEach(inp=>inp.oninput=()=>{a.units[+inp.dataset.ui].label=inp.value;saveDraftDebounced();});
    document.querySelectorAll('[data-rmunit]').forEach(b=>b.onclick=()=>{a.units.splice(+b.dataset.rmunit,1);drawUnits();saveDraftDebounced();});
    document.querySelectorAll('[data-addroom]').forEach(b=>b.onclick=()=>{a.units[+b.dataset.addroom].rooms.push({id:uid(),name:'Neues Zimmer',defects:[]});drawUnits();saveDraftDebounced();});
  }
  function drawRooms(ui){
    const u=a.units[ui];
    const box=document.querySelector(`[data-rooms="${ui}"]`);if(!box)return;
    box.innerHTML=(u.rooms||[]).map((r,ri)=>`
      <div style="border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--paper)">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
          <input data-rk="name" data-ui="${ui}" data-ri="${ri}" value="${esc(r.name)}" placeholder="Zimmer, z.B. Wohnzimmer" style="flex:1;border:none;background:transparent;font-weight:600;font-size:13px">
          <button class="row-del" data-rmroom="${ui}:${ri}" type="button" title="Zimmer entfernen">×</button>
        </div>
        <div data-defs="${ui}:${ri}" style="display:flex;flex-direction:column;gap:6px"></div>
        <button class="btn btn-ghost btn-sm" data-adddef="${ui}:${ri}" type="button" style="margin-top:4px">＋ Mangel</button>
      </div>`).join('');
    (u.rooms||[]).forEach((r,ri)=>drawDefs(ui,ri));
    document.querySelectorAll(`[data-rk="name"][data-ui="${ui}"]`).forEach(inp=>inp.oninput=()=>{a.units[+inp.dataset.ui].rooms[+inp.dataset.ri].name=inp.value;saveDraftDebounced();});
    box.querySelectorAll('[data-rmroom]').forEach(b=>b.onclick=()=>{const[uu,rr]=b.dataset.rmroom.split(':').map(Number);a.units[uu].rooms.splice(rr,1);drawUnits();saveDraftDebounced();});
    box.querySelectorAll('[data-adddef]').forEach(b=>b.onclick=()=>{const[uu,rr]=b.dataset.adddef.split(':').map(Number);a.units[uu].rooms[rr].defects.push({id:uid(),text:'',photos:[],severity:'optisch',due:'',fixed:false});drawUnits();saveDraftDebounced();});
  }
  function drawDefs(ui,ri){
    const r=a.units[ui].rooms[ri];
    const box=document.querySelector(`[data-defs="${ui}:${ri}"]`);if(!box)return;
    box.innerHTML=(r.defects||[]).map((d,di)=>`
      <div style="border:1px solid var(--line);border-radius:6px;padding:7px;background:var(--paper-2)">
        <div style="display:flex;gap:6px;align-items:flex-start">
          <textarea data-dk="text" data-ui="${ui}" data-ri="${ri}" data-di="${di}" placeholder="Mangel beschreiben…" style="flex:1;min-height:34px;border:1px solid var(--line);border-radius:5px;padding:5px;font-size:12px">${esc(d.text)}</textarea>
          <button class="row-del" data-rmdef="${ui}:${ri}:${di}" type="button" title="Mangel entfernen">×</button>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
          <select data-dk="severity" data-ui="${ui}" data-ri="${ri}" data-di="${di}" style="font-size:11.5px">
            ${SEV.map(s=>`<option value="${s.v}" ${d.severity===s.v?'selected':''}>${s.l}</option>`).join('')}
          </select>
          <label style="font-size:11px;color:var(--muted)">Behebung bis</label>
          <input type="date" data-dk="due" data-ui="${ui}" data-ri="${ri}" data-di="${di}" value="${d.due||''}" style="font-size:11.5px">
          <label style="display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--muted)"><input type="checkbox" data-dk="fixed" data-ui="${ui}" data-ri="${ri}" data-di="${di}" ${d.fixed?'checked':''}> behoben</label>
          <div style="margin-left:auto;display:flex;gap:5px;align-items:center">
            ${(d.photos||[]).map((p,pi)=>`<img src="${p}" data-photoview="${ui}:${ri}:${di}:${pi}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;cursor:pointer;border:1px solid var(--line)">`).join('')}
            <button class="btn btn-ghost btn-sm" data-addphoto="${ui}:${ri}:${di}" type="button" title="Foto hinzufügen" style="padding:4px 8px">📷</button>
          </div>
        </div>
      </div>`).join('')||'<div style="font-size:11.5px;color:var(--muted)">Noch keine Mängel in diesem Zimmer.</div>';
    box.querySelectorAll('[data-dk="text"]').forEach(el=>el.oninput=()=>{a.units[+el.dataset.ui].rooms[+el.dataset.ri].defects[+el.dataset.di].text=el.value;saveDraftDebounced();});
    box.querySelectorAll('[data-dk="severity"]').forEach(el=>el.onchange=()=>{a.units[+el.dataset.ui].rooms[+el.dataset.ri].defects[+el.dataset.di].severity=el.value;saveDraftDebounced();});
    box.querySelectorAll('[data-dk="due"]').forEach(el=>el.oninput=()=>{a.units[+el.dataset.ui].rooms[+el.dataset.ri].defects[+el.dataset.di].due=el.value;saveDraftDebounced();});
    box.querySelectorAll('[data-dk="fixed"]').forEach(el=>el.onchange=()=>{a.units[+el.dataset.ui].rooms[+el.dataset.ri].defects[+el.dataset.di].fixed=el.checked;saveDraftDebounced();});
    box.querySelectorAll('[data-rmdef]').forEach(b=>b.onclick=()=>{const[uu,rr,dd]=b.dataset.rmdef.split(':').map(Number);a.units[uu].rooms[rr].defects.splice(dd,1);drawUnits();saveDraftDebounced();});
    box.querySelectorAll('[data-addphoto]').forEach(b=>b.onclick=()=>openPhotoSource(async(b64)=>{
      const[uu,rr,dd]=b.dataset.addphoto.split(':').map(Number);
      a.units[uu].rooms[rr].defects[dd].photos=a.units[uu].rooms[rr].defects[dd].photos||[];
      a.units[uu].rooms[rr].defects[dd].photos.push(b64);
      drawUnits();saveDraftDebounced();
    }));
    box.querySelectorAll('[data-photoview]').forEach(img=>img.onclick=()=>window.open(img.src,'_blank'));
  }
  drawUnits();
  document.getElementById('addUnitBtn').onclick=()=>{a.units.push({id:uid(),label:'Neuer Bereich',rooms:[]});drawUnits();saveDraftDebounced();};

  const padB=attachSignPad(document.getElementById('sigB')), padC=attachSignPad(document.getElementById('sigC'));
  if(a.sigBuilder){const img=new Image();img.onload=()=>document.getElementById('sigB').getContext('2d').drawImage(img,0,0);img.src=a.sigBuilder;}
  if(a.sigContractor){const img=new Image();img.onload=()=>document.getElementById('sigC').getContext('2d').drawImage(img,0,0);img.src=a.sigContractor;}
  document.getElementById('clrB').onclick=()=>padB.clear();document.getElementById('clrC').onclick=()=>padC.clear();
  function collectFinal(){ collect(); a.sigBuilder=padB.data();a.sigContractor=padC.data();a.signed=true; return a; }
  document.getElementById('accSaveBtn').onclick=async(ev)=>{if(guardBusy(ev.currentTarget))return;saveDraftDebounced.cancel();await put('acceptances',collectFinal());_draftClear('acc',draftKeyId);closeModal();toast('Abnahmeprotokoll gespeichert',true);renderAcceptance();};
  document.getElementById('accPdfBtn').onclick=()=>exportAcceptancePDF(collectFinal(),proj);
  document.getElementById('accCancelBtn').onclick=()=>{saveDraftDebounced.cancel();_draftClear('acc',draftKeyId);closeModal();};
  if(!isNew){const ad=document.getElementById('accDelBtn');if(ad)ad.onclick=async()=>{const ok=await confirmDelete('acceptances',a.id,a.object||'Abnahme',renderAcceptance);if(ok){saveDraftDebounced.cancel();_draftClear('acc',draftKeyId);closeModal();}};}
}
async function exportAcceptancePDF(a,proj){
  const {jsPDF}=window.jspdf;const doc=new jsPDF();
  pdfHeaderLogo(doc);
  doc.setTextColor(168,57,42);doc.setFontSize(15);doc.setFont(undefined,'bold');doc.text('Abnahmeprotokoll',PDF.ML,16);doc.setFont(undefined,'normal');
  doc.setTextColor(120);doc.setFontSize(8);doc.text('gemäss SIA 118, Art. 157 ff.',PDF.ML,21);
  doc.setDrawColor(168,57,42);doc.setLineWidth(0.4);doc.line(PDF.ML,24,PDF.ML+doc.getTextWidth('Abnahmeprotokoll')*1.42,24);
  doc.setTextColor(40);doc.setFontSize(10);let y=34;
  const row=(k,v,bold)=>{doc.setTextColor(120);doc.text(k,PDF.ML,y);
    if(bold){doc.setFont(undefined,'bold');doc.setTextColor(20,20,20);}else doc.setTextColor(30);
    const vl=pdfTextHeight(doc,String(v||'—'),125,5);doc.text(vl.lines,65,y);
    if(bold){const w=doc.getTextWidth(String(v||'—'));doc.setDrawColor(20,20,20);doc.setLineWidth(0.25);doc.line(65,y+1,65+w,y+1);doc.setFont(undefined,'normal');}
    y+=Math.max(vl.h,7);};
  row('Bauobjekt:',a.object);row('Projekt:',proj.name,true);row('Datum:',fmtDate(a.date));
  row('Unternehmer:',a.contractor);row('Art:',a.type);row('Ergebnis:',a.result);
  // Zusammenfassung
  const units=a.units||[];
  let total=0,erheblich=0;
  units.forEach(u=>(u.rooms||[]).forEach(r=>(r.defects||[]).forEach(d=>{total++;if(d.severity==='erheblich')erheblich++;})));
  row('Mängel total:',`${total}  (davon ${erheblich} erheblich, ${total-erheblich} optisch)`);
  y+=3;doc.setDrawColor(200);doc.setLineWidth(0.3);doc.line(PDF.ML,y,PDF.MR,y);y+=8;

  if(!units.length || total===0){
    doc.setTextColor(26,26,26);doc.setFontSize(12);doc.setFont(undefined,'bold');doc.text('Rundgang',PDF.ML,y);doc.setFont(undefined,'normal');y+=7;
    doc.setTextColor(120);doc.setFontSize(9);doc.text('Keine Mängel festgestellt.',PDF.ML+2,y);y+=8;
  }
  units.forEach(u=>{
    if(!(u.rooms||[]).length)return;
    y=pdfEnsureSpace(doc,y,14,()=>20);
    doc.setTextColor(168,57,42);doc.setFontSize(12.5);doc.setFont(undefined,'bold');doc.text(u.label||'Bereich',PDF.ML,y+2);doc.setFont(undefined,'normal');
    doc.setDrawColor(168,57,42);doc.setLineWidth(0.35);doc.line(PDF.ML,y+4,PDF.ML+doc.getTextWidth(u.label||'Bereich'),y+4);
    y+=10;
    (u.rooms||[]).forEach(r=>{
      y=pdfEnsureSpace(doc,y,10,()=>20);
      doc.setTextColor(26,26,26);doc.setFontSize(10.5);doc.setFont(undefined,'bold');doc.text(r.name||'Zimmer',PDF.ML+3,y+2);doc.setFont(undefined,'normal');
      y+=7;
      if(!(r.defects||[]).length){
        doc.setTextColor(150);doc.setFontSize(8.5);doc.text('Keine Mängel.',PDF.ML+6,y);y+=6;
      }
      (r.defects||[]).forEach(d=>{
        const THUMB=18;
        const textBlock=pdfTextHeight(doc,d.text||'(ohne Beschreibung)',(d.photos&&d.photos.length)?150:170,4.4);
        const imgH=(d.photos&&d.photos.length)?THUMB+2:0;
        const blockH=Math.max(textBlock.h+9,imgH+6)+4;
        y=pdfEnsureSpace(doc,y,blockH,()=>20);
        const sevColor=d.severity==='erheblich'?[200,72,28]:[138,131,120];
        const sevLabel=d.severity==='erheblich'?'ERHEBLICH':'OPTISCH';
        doc.setFillColor(...sevColor);doc.roundedRect(PDF.ML+6,y,22,5,1,1,'F');
        doc.setTextColor(255);doc.setFontSize(6.5);doc.setFont(undefined,'bold');doc.text(sevLabel,PDF.ML+17,y+3.4,{align:'center'});doc.setFont(undefined,'normal');
        if(d.fixed){doc.setFillColor(60,140,90);doc.roundedRect(PDF.ML+30,y,20,5,1,1,'F');doc.setTextColor(255);doc.setFontSize(6.5);doc.text('BEHOBEN',PDF.ML+40,y+3.4,{align:'center'});}
        doc.setTextColor(40);doc.setFontSize(8.7);doc.text(textBlock.lines,PDF.ML+6,y+11);
        doc.setTextColor(120);doc.setFontSize(7.8);doc.text('Behebung bis: '+(d.due?fmtDate(d.due):'—'),PDF.ML+6,y+11+textBlock.h+3);
        if(d.photos&&d.photos.length){
          try{
            const props=doc.getImageProperties(d.photos[0]);
            const ratio=props.width/props.height;
            let w=THUMB,h=THUMB/ratio;if(h>THUMB){h=THUMB;w=THUMB*ratio;}
            doc.addImage(d.photos[0],PDF.MR-w-2,y+1,w,h);
            doc.setDrawColor(215);doc.setLineWidth(0.2);doc.rect(PDF.MR-w-2,y+1,w,h);
            if(d.photos.length>1){doc.setTextColor(150);doc.setFontSize(6.5);doc.text('+'+(d.photos.length-1)+' weitere',PDF.MR,y+1+h+3,{align:'right'});}
          }catch(e){}
        }
        doc.setDrawColor(232,227,219);doc.setLineWidth(0.2);doc.line(PDF.ML+3,y+blockH-1.5,PDF.MR,y+blockH-1.5);
        y+=blockH;
      });
    });
    y+=3;
  });
  y+=4;
  if(a.remarks){
    const rl=pdfTextHeight(doc,a.remarks,180,PDF.LH_S);
    y=pdfEnsureSpace(doc,y,rl.h+10,()=>20);
    doc.setTextColor(26,26,26);doc.setFontSize(11);doc.setFont(undefined,'bold');doc.text('Bemerkungen',PDF.ML,y);doc.setFont(undefined,'normal');y+=6;
    doc.setTextColor(70);doc.setFontSize(9);doc.text(rl.lines,PDF.ML,y);y+=rl.h+6;
  }
  // Unterschriften – sicher platzieren (neue Seite, wenn kein Platz)
  const sigBlockH=40;
  y=pdfEnsureSpace(doc,y,sigBlockH,()=>20);
  y+=8;
  try{if(a.sigBuilder)doc.addImage(a.sigBuilder,'PNG',16,y,70,21);if(a.sigContractor)doc.addImage(a.sigContractor,'PNG',116,y,70,21);}catch(e){}
  y+=24;doc.setDrawColor(120);doc.setLineWidth(0.3);doc.line(16,y,86,y);doc.line(116,y,186,y);y+=5;
  doc.setTextColor(90);doc.setFontSize(8);doc.text('Bauleitung',16,y);doc.text('Unternehmer',116,y);
  pdfFooterAllPages(doc);
  doc.save(`Abnahmeprotokoll_${(a.object||'').replace(/\s+/g,'_')}.pdf`);toast('Abnahme-PDF erstellt',true);
}

/* ============================================================
   MODULE: PRÜFPLÄNE / CHECKLISTEN
   ============================================================ */
const CHECK_TEMPLATES={
  'Rohbau-Abnahme':['Fundamente gemäss Plan','Bewehrung kontrolliert','Betonqualität dokumentiert','Masse/Achsen geprüft','Aussparungen vollständig'],
  'Wohnungsabnahme':['Wände/Decken ohne Mängel','Bodenbeläge sauber verlegt','Türen schliessen einwandfrei','Sanitär funktionsfähig','Elektro/Steckdosen geprüft','Reinigung erfolgt'],
  'Sicherheit Baustelle':['Absturzsicherungen vorhanden','Gerüst abgenommen','Fluchtwege frei','PSA getragen','Erste-Hilfe-Material vorhanden']
};
async function renderChecklists(){
  const stage=document.getElementById('stage');
  const lists=(await byProject('checklists')).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  stage.innerHTML=`
    <div class="module">
      <div class="mod-head"><div><h1>Prüfpläne & Checklisten</h1><div class="sub">Qualitätsziel · Prüfpunkte abarbeiten · Erfüllungsgrad</div></div>
        <div class="spacer"></div><button class="btn btn-primary btn-sm" id="newChkBtn">＋ Neue Checkliste</button></div>
      <div class="mod-body">
        ${lists.length?`<div class="cards">${lists.map(l=>{const done=l.items.filter(i=>i.done).length;const pct=l.items.length?Math.round(done/l.items.length*100):0;
          return `<div class="card" data-id="${l.id}"><button class="card-del" data-del="${l.id}" title="Checkliste löschen">×</button><h4>${esc(l.title)}</h4>
            <div class="meta">Ziel: ${esc(l.goal||'—')}<br>${done}/${l.items.length} erfüllt</div>
            <div class="bar"><i style="width:${pct}%;background:${pct===100?'var(--ok)':'var(--signal)'}"></i></div>
            <div style="text-align:right;font-size:12px;font-weight:700;margin-top:4px;color:${pct===100?'var(--ok)':'var(--steel)'}">${pct}%</div></div>`;}).join('')}</div>`
        :`<div class="empty"><div class="big">☑</div><h3>Keine Checklisten</h3><p>Erstelle einen Prüfplan aus einer Vorlage oder von Grund auf.</p></div>`}
      </div>
    </div>`;
  document.getElementById('newChkBtn').onclick=()=>openChecklistEditor();
  document.querySelectorAll('.card[data-id]').forEach(c=>c.onclick=async e=>{if(e.target.closest('.card-del'))return;openChecklistEditor(await get('checklists',c.dataset.id));});
  document.querySelectorAll('.card-del[data-del]').forEach(b=>b.onclick=async e=>{e.stopPropagation();const l=await get('checklists',b.dataset.del);await confirmDelete('checklists',b.dataset.del,l?l.title:'Checkliste',renderChecklists);});
}
async function openChecklistEditor(l){
  const isNew=!l;
  l=l||{id:uid(),projectId:state.projectId,title:'',goal:'',items:[],createdAt:nowISO()};
  modal(`<div class="modal-head"><h3>${isNew?'Neue Checkliste':esc(l.title)}</h3></div>
    <div class="modal-body">
      <div class="field"><label>Titel</label><input id="c-title" value="${esc(l.title)}" placeholder="z.B. Wohnungsabnahme 3.OG"></div>
      <div class="field"><label>Qualitätsziel</label><input id="c-goal" value="${esc(l.goal)}" placeholder="z.B. Mängelfreie Übergabe"></div>
      ${isNew?`<div class="field"><label>Vorlage importieren</label><select id="c-tpl"><option value="">— ohne Vorlage —</option>${Object.keys(CHECK_TEMPLATES).map(t=>`<option>${t}</option>`).join('')}</select></div>`:''}
      <div class="field"><label>Prüfpunkte</label><div id="chkItems"></div>
        <div style="display:flex;gap:6px;margin-top:8px"><input id="newChkItem" placeholder="Neuer Prüfpunkt…" style="flex:1;padding:8px;border:1px solid var(--line);border-radius:7px;background:var(--paper)"><button class="btn btn-ghost btn-sm" id="addChkItem">＋</button></div>
      </div>
    </div>
    <div class="modal-foot">${isNew?'':'<button class="btn btn-danger" id="chkDel">Löschen</button>'}<button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button><button class="btn btn-primary" id="chkSave">Speichern</button></div>`,{wide:true});
  let items=JSON.parse(JSON.stringify(l.items||[]));
  function draw(){
    document.getElementById('chkItems').innerHTML=items.map((it,i)=>`
      <div class="checkrow ${it.done?'done':''}"><div class="cb ${it.done?'on':''}" data-i="${i}">${it.done?'✓':''}</div><span class="ct">${esc(it.text)}</span><b data-del="${i}" style="cursor:pointer;color:var(--signal)">×</b></div>`).join('')||'<div style="font-size:12.5px;color:var(--muted)">Noch keine Prüfpunkte</div>';
    document.querySelectorAll('#chkItems .cb').forEach(cb=>cb.onclick=()=>{items[+cb.dataset.i].done=!items[+cb.dataset.i].done;draw();});
    document.querySelectorAll('#chkItems [data-del]').forEach(b=>b.onclick=()=>{items.splice(+b.dataset.del,1);draw();});
  }
  const tpl=document.getElementById('c-tpl');
  if(tpl)tpl.onchange=e=>{if(e.target.value){items=CHECK_TEMPLATES[e.target.value].map(t=>({text:t,done:false}));if(!document.getElementById('c-title').value)document.getElementById('c-title').value=e.target.value;draw();}};
  document.getElementById('addChkItem').onclick=()=>{const v=document.getElementById('newChkItem').value.trim();if(v){items.push({text:v,done:false});document.getElementById('newChkItem').value='';draw();}};
  document.getElementById('newChkItem').onkeydown=e=>{if(e.key==='Enter')document.getElementById('addChkItem').click();};
  document.getElementById('chkSave').onclick=async(ev)=>{if(guardBusy(ev.currentTarget))return;l.title=document.getElementById('c-title').value.trim()||'Checkliste';l.goal=document.getElementById('c-goal').value.trim();l.items=items;await put('checklists',l);closeModal();toast('Checkliste gespeichert',true);renderChecklists();};
  if(!isNew){const cd=document.getElementById('chkDel');if(cd)cd.onclick=async()=>{const ok=await confirmDelete('checklists',l.id,l.title||'Checkliste',renderChecklists);if(ok)closeModal();};}
  draw();
}

/* ============================================================
   MODULE: REGIEAUFTRÄGE (mit Belastungsanzeige)
   ============================================================ */
async function renderWorkorders(){
  const stage=document.getElementById('stage');
  const wos=(await byProject('workorders')).sort((a,b)=>b.date.localeCompare(a.date));
  stage.innerHTML=`
    <div class="module">
      <div class="mod-head"><div><h1>Regieaufträge</h1><div class="sub">Kosten · MwSt · Kostenaufteilung · Belastungsanzeige generieren</div></div>
        <div class="spacer"></div><button class="btn btn-primary btn-sm" id="newWoBtn">＋ Neuer Regieauftrag</button></div>
      <div class="mod-body">
        ${wos.length?`<table class="tbl"><thead><tr><th>Nr.</th><th>Titel</th><th>Unternehmer</th><th>Datum</th><th>Betrag</th><th>Status</th><th></th></tr></thead>
          <tbody>${wos.map(w=>`<tr class="click" data-id="${w.id}"><td><b>${esc(w.number)}</b></td><td>${esc(w.title)}</td><td>${esc(w.contractor||'—')}</td><td>${fmtDate(w.date)}</td><td><b>${money(woTotal(w))}</b></td><td><span class="status-tag status-${statusKey(w.status)}">${w.status}</span></td><td><button class="row-del" data-del="${w.id}" title="Löschen">×</button></td></tr>`).join('')}</tbody></table>`
        :`<div class="empty"><div class="big">🧾</div><h3>Keine Regieaufträge</h3><p>Erfasse Regiearbeiten mit Kosten und erzeuge daraus eine Belastungsanzeige.</p></div>`}
      </div>
    </div>`;
  document.getElementById('newWoBtn').onclick=()=>openWorkorderEditor();
  document.querySelectorAll('.tbl tr.click').forEach(tr=>tr.onclick=async e=>{if(e.target.closest('.row-del'))return;openWorkorderEditor(await get('workorders',tr.dataset.id));});
  document.querySelectorAll('.row-del[data-del]').forEach(b=>b.onclick=async e=>{e.stopPropagation();const w=await get('workorders',b.dataset.del);await confirmDelete('workorders',b.dataset.del,w?w.number:'Regieauftrag',renderWorkorders);});
}
function woTotal(w){const net=(w.positions||[]).reduce((s,p)=>s+(Number(p.qty)||0)*(Number(p.price)||0),0);return net*(1+(Number(w.vat)||0)/100);}
async function openWorkorderEditor(w){
  const contacts=await byProject('contacts');const proj=await get('projects',state.projectId);
  const isNew=!w;
  const cnt=(await byProject('workorders')).length;
  w=w||{id:uid(),projectId:state.projectId,number:'RA-'+String(cnt+1).padStart(3,'0'),title:'',contractor:'',contractorId:'',date:todayISO(),vat:8.1,status:'Offen',positions:[{desc:'',qty:1,unit:'h',price:0}],split:'',remarks:''};
  modal(`<div class="modal-head"><h3>${isNew?'Neuer Regieauftrag':esc(w.number)}</h3></div>
    <div class="modal-body">
      <div class="field-row"><div class="field" style="max-width:130px"><label>Nr.</label><input id="w-number" value="${esc(w.number)}"></div>
        <div class="field"><label>Titel</label><input id="w-title" value="${esc(w.title)}" placeholder="z.B. Zusätzliche Aushubarbeiten"></div>
        <div class="field" style="max-width:140px"><label>Datum</label><input type="date" id="w-date" value="${w.date}"></div></div>
      <div class="field-row"><div class="field"><label>Unternehmer</label><select id="w-contractor"><option value="">— wählen —</option>${contacts.map(c=>`<option value="${c.id}" ${c.id===w.contractorId?'selected':''}>${esc(c.company)}</option>`).join('')}</select></div>
        <div class="field" style="max-width:120px"><label>MwSt %</label><input type="number" step="0.1" id="w-vat" value="${w.vat}"></div>
        <div class="field" style="max-width:150px"><label>Status</label><select id="w-status">${['Offen','In Arbeit','Erledigt'].map(s=>`<option ${w.status===s?'selected':''}>${s}</option>`).join('')}</select></div></div>
      <div class="field"><label>Positionen</label><div id="woPos"></div><button class="btn btn-ghost btn-sm" id="addPos" style="margin-top:6px">＋ Position</button></div>
      <div class="field"><label>Kostenaufteilung (Parteien)</label><input id="w-split" value="${esc(w.split)}" placeholder="z.B. Bauherr 50% / Unternehmer 50%"></div>
      <div class="field"><label>Bemerkungen</label><textarea id="w-remarks">${esc(w.remarks)}</textarea></div>
      <div style="text-align:right;font-size:16px;font-weight:800" id="woTotalDisp"></div>
    </div>
    <div class="modal-foot">${isNew?'':'<button class="btn btn-danger" id="woDelBtn">Löschen</button>'}<button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-steel" id="woBelastBtn">⬇ Belastungsanzeige</button>
      <button class="btn btn-primary" id="woSaveBtn">Speichern</button></div>`,{wide:true});
  let positions=JSON.parse(JSON.stringify(w.positions||[]));
  function drawPos(){
    document.getElementById('woPos').innerHTML=`<table class="tbl" style="box-shadow:none"><thead><tr><th>Beschreibung</th><th style="width:70px">Menge</th><th style="width:70px">Einheit</th><th style="width:100px">Preis</th><th style="width:100px">Total</th><th style="width:30px"></th></tr></thead><tbody>
      ${positions.map((p,i)=>`<tr>
        <td><input data-i="${i}" data-k="desc" value="${esc(p.desc)}" style="width:100%;border:none;background:transparent"></td>
        <td><input data-i="${i}" data-k="qty" type="number" step="0.25" value="${p.qty}" style="width:100%;border:none;background:transparent"></td>
        <td><input data-i="${i}" data-k="unit" value="${esc(p.unit)}" style="width:100%;border:none;background:transparent"></td>
        <td><input data-i="${i}" data-k="price" type="number" step="0.05" value="${p.price}" style="width:100%;border:none;background:transparent"></td>
        <td><b>${money((Number(p.qty)||0)*(Number(p.price)||0))}</b></td>
        <td><b data-del="${i}" style="cursor:pointer;color:var(--signal)">×</b></td></tr>`).join('')}</tbody></table>`;
    document.querySelectorAll('#woPos [data-k]').forEach(el=>el.oninput=()=>{positions[+el.dataset.i][el.dataset.k]=el.value;drawPos();updTotal();});
    document.querySelectorAll('#woPos [data-del]').forEach(b=>b.onclick=()=>{positions.splice(+b.dataset.del,1);drawPos();updTotal();});
  }
  function updTotal(){const vat=Number(document.getElementById('w-vat').value)||0;const net=positions.reduce((s,p)=>s+(Number(p.qty)||0)*(Number(p.price)||0),0);document.getElementById('woTotalDisp').textContent=`Netto ${money(net)} · inkl. ${vat}% MwSt: ${money(net*(1+vat/100))}`;}
  document.getElementById('addPos').onclick=()=>{positions.push({desc:'',qty:1,unit:'h',price:0});drawPos();};
  document.getElementById('w-vat').oninput=updTotal;
  function collect(){w.number=document.getElementById('w-number').value;w.title=document.getElementById('w-title').value;w.date=document.getElementById('w-date').value;w.contractorId=document.getElementById('w-contractor').value;const c=contacts.find(x=>x.id===w.contractorId);w.contractor=c?c.company:'';w.vat=Number(document.getElementById('w-vat').value)||0;w.status=document.getElementById('w-status').value;w.positions=positions;w.split=document.getElementById('w-split').value;w.remarks=document.getElementById('w-remarks').value;return w;}
  document.getElementById('woSaveBtn').onclick=async(ev)=>{if(guardBusy(ev.currentTarget))return;await put('workorders',collect());closeModal();toast('Regieauftrag gespeichert',true);renderWorkorders();};
  document.getElementById('woBelastBtn').onclick=()=>exportBelastung(collect(),proj);
  if(!isNew){const wd=document.getElementById('woDelBtn');if(wd)wd.onclick=async()=>{const ok=await confirmDelete('workorders',w.id,w.number||'Regieauftrag',renderWorkorders);if(ok)closeModal();};}
  drawPos();updTotal();
}
async function exportBelastung(w,proj){
  const {jsPDF}=window.jspdf;const doc=new jsPDF();
  pdfHeaderLogo(doc);
  doc.setTextColor(168,57,42);doc.setFontSize(15);doc.setFont(undefined,'bold');doc.text('Belastungsanzeige',PDF.ML,16);doc.setFont(undefined,'normal');
  doc.setTextColor(120);doc.setFontSize(8);doc.text('aus Regieauftrag '+w.number,PDF.ML,21);
  doc.setDrawColor(168,57,42);doc.setLineWidth(0.4);doc.line(PDF.ML,24,90,24);
  doc.setTextColor(40);doc.setFontSize(10);let y=34;
  doc.text('Projekt: ',PDF.ML,y);
  {const pw=doc.getTextWidth('Projekt: ');doc.setFont(undefined,'bold');doc.setTextColor(20,20,20);doc.text(proj.name,PDF.ML+pw,y);
   const tw=doc.getTextWidth(proj.name);doc.setDrawColor(20,20,20);doc.setLineWidth(0.25);doc.line(PDF.ML+pw,y+1,PDF.ML+pw+tw,y+1);
   doc.setFont(undefined,'normal');doc.setTextColor(40);}
  doc.text(`Datum: ${fmtDate(w.date)}`,150,y);y+=6;
  doc.text(doc.splitTextToSize(`Titel: ${w.title||'—'}`,130),PDF.ML,y);y+=6;
  doc.text(`Unternehmer: ${w.contractor||'—'}`,PDF.ML,y);y+=10;
  // Tabellenkopf
  const drawHead=(yy)=>{doc.setFillColor(240,236,229);doc.rect(PDF.ML,yy,182,7,'F');doc.setTextColor(107,98,88);doc.setFontSize(8);doc.setFont(undefined,'bold');
    doc.text('Beschreibung',PDF.ML+2,yy+4.7);doc.text('Menge',108,yy+4.7);doc.text('Preis',138,yy+4.7);doc.text('Total',172,yy+4.7);doc.setFont(undefined,'normal');return yy+10;};
  y=drawHead(y);
  let net=0;doc.setTextColor(40);doc.setFontSize(9);
  (w.positions||[]).forEach(p=>{
    const t=(Number(p.qty)||0)*(Number(p.price)||0);net+=t;
    const dl=pdfTextHeight(doc,p.desc||'—',88,PDF.LH_S);
    const rowH=Math.max(dl.h,5)+2;
    y=pdfEnsureSpace(doc,y,rowH,()=>drawHead(20));
    const top=y+3.5;
    doc.setTextColor(40);doc.text(dl.lines,PDF.ML+2,top);
    doc.text(`${p.qty} ${p.unit||''}`,108,top);
    doc.text(money(p.price).replace('CHF ',''),138,top);
    doc.text(money(t).replace('CHF ',''),168,top);
    doc.setDrawColor(238,234,228);doc.setLineWidth(0.15);doc.line(PDF.ML,y+rowH-1,PDF.MR,y+rowH-1);
    y+=rowH;
  });
  y+=3;doc.setDrawColor(200);doc.setLineWidth(0.3);doc.line(108,y,PDF.MR,y);y+=6;
  doc.setTextColor(40);doc.setFontSize(9);
  doc.text('Netto',138,y);doc.text(money(net).replace('CHF ',''),168,y);y+=6;
  const vat=net*(w.vat/100);doc.text(`MwSt ${w.vat}%`,138,y);doc.text(money(vat).replace('CHF ',''),168,y);y+=6;
  doc.setFontSize(11);doc.setTextColor(168,57,42);doc.setFont(undefined,'bold');doc.text('Total CHF',138,y);doc.text(money(net+vat).replace('CHF ',''),168,y);doc.setFont(undefined,'normal');y+=12;
  if(w.split){doc.setFontSize(9);doc.setTextColor(70);doc.text(doc.splitTextToSize('Kostenaufteilung: '+w.split,180),PDF.ML,y);y+=8;}
  if(w.remarks){doc.setTextColor(120);doc.setFontSize(8);doc.text(doc.splitTextToSize(w.remarks,180),PDF.ML,y);}
  pdfFooterAllPages(doc);
  doc.save(`Belastungsanzeige_${w.number}.pdf`);toast('Belastungsanzeige erstellt',true);
}

/* ============================================================
   MODULE: BAUJOURNAL (1 Eintrag/Tag, Wetter)
   ============================================================ */
const WEATHER=['☀ Sonnig','⛅ Bewölkt','🌧 Regen','⛈ Gewitter','🌨 Schnee','🌫 Nebel'];
async function renderJournal(){
  const stage=document.getElementById('stage');
  const entries=(await byProject('journal')).sort((a,b)=>b.date.localeCompare(a.date));
  stage.innerHTML=`
    <div class="module">
      <div class="mod-head"><div><h1>Baujournal</h1><div class="sub">Tageseinträge · Wetter · Personal · Bilder</div></div>
        <div class="spacer"></div><button class="btn btn-ghost btn-sm" id="jAllPdfBtn">⬇ Gesamt-PDF</button><button class="btn btn-primary btn-sm" id="newJBtn">＋ Eintrag heute</button></div>
      <div class="mod-body">
        ${entries.length?entries.map(j=>`<div class="card" style="cursor:pointer;margin-bottom:12px;max-width:100%" data-id="${j.id}">
          <button class="card-del" data-del="${j.id}" title="Eintrag löschen">×</button>
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-right:30px"><b style="font-size:15px">${fmtDate(j.date)}</b><span class="pill">${esc(j.weather||'')}</span><span class="pill">${esc(j.temp||'')}°C</span><span style="margin-left:auto;font-size:12px;color:var(--muted)">${esc(j.author)}</span></div>
          <div style="margin-top:8px;font-size:13.5px;line-height:1.6;overflow-wrap:anywhere">${esc(j.text).slice(0,180)}${j.text.length>180?'…':''}</div>
          ${j.workers?`<div style="margin-top:6px;font-size:12px;color:var(--muted)">👷 ${esc(j.workers)}</div>`:''}</div>`).join('')
        :`<div class="empty"><div class="big">📕</div><h3>Kein Journal</h3><p>Dokumentiere täglich Wetter, Personal und Geschehen auf der Baustelle.</p></div>`}
      </div>
    </div>`;
  document.getElementById('newJBtn').onclick=()=>openJournalEditor();
  const allBtn=document.getElementById('jAllPdfBtn');if(allBtn)allBtn.onclick=()=>exportJournalPDF(entries);
  document.querySelectorAll('.card[data-id]').forEach(c=>c.onclick=async e=>{if(e.target.closest('.card-del'))return;openJournalEditor(await get('journal',c.dataset.id));});
  document.querySelectorAll('.card-del[data-del]').forEach(b=>b.onclick=async e=>{e.stopPropagation();const j=await get('journal',b.dataset.del);await confirmDelete('journal',b.dataset.del,j?('Eintrag '+fmtDate(j.date)):'Eintrag',renderJournal);});
}
// PDF-Export: einzelner Eintrag ODER Liste (gesamthaft)
async function exportJournalPDF(entries){
  const {jsPDF}=window.jspdf;const doc=new jsPDF();
  const proj=await get('projects',state.projectId);
  const list=Array.isArray(entries)?entries:[entries];
  const single=list.length===1;
  let y=pdfDocHead(doc, single?('Baujournal – '+fmtDate(list[0].date)):'Baujournal – Gesamtübersicht', [{l:proj.name,proj:true}]);
  list.sort((a,b)=>a.date.localeCompare(b.date)).forEach(j=>{
    const textBlock=pdfTextHeight(doc,j.text||'—',182,PDF.LH);
    const blockH=8+textBlock.h+(j.workers?5:0)+4;
    y=pdfEnsureSpace(doc,y,blockH,()=>20);
    doc.setTextColor(26,26,26);doc.setFontSize(11);doc.setFont(undefined,'bold');
    doc.text(fmtDate(j.date),PDF.ML,y+4);
    doc.setFont(undefined,'normal');doc.setTextColor(110);doc.setFontSize(8.5);
    doc.text(`${j.weather||''}   ${j.temp?j.temp+'°C':''}   ${j.author||''}`,PDF.MR,y+4,{align:'right'});
    let yy=y+9;
    if(j.workers){doc.setTextColor(90);doc.setFontSize(8.5);doc.text('Personal: '+j.workers,PDF.ML,yy);yy+=5;}
    doc.setTextColor(50);doc.setFontSize(9);doc.text(textBlock.lines,PDF.ML,yy);
    const lineY=y+blockH-1.5;
    doc.setDrawColor(232,227,219);doc.setLineWidth(0.2);doc.line(PDF.ML,lineY,PDF.MR,lineY);
    y+=blockH;
  });
  pdfFooterAllPages(doc);
  doc.save(single?`Journal_${list[0].date}.pdf`:`Baujournal_Gesamt.pdf`);
  toast('Journal-PDF erstellt',true);
}
async function openJournalEditor(j){
  const isNew=!j;
  j=j||{id:uid(),projectId:state.projectId,date:todayISO(),weather:'☀ Sonnig',temp:'18',workers:'',text:'',author:CURRENT_USER.name,photos:[],createdAt:nowISO()};
  modal(`<div class="modal-head"><h3>${isNew?'Neuer Journaleintrag':'Eintrag '+fmtDate(j.date)}</h3></div>
    <div class="modal-body">
      <div class="field-row"><div class="field"><label>Datum</label><input type="date" id="j-date" value="${j.date}"></div>
        <div class="field"><label>Wetter</label><select id="j-weather">${WEATHER.map(w=>`<option ${j.weather===w?'selected':''}>${w}</option>`).join('')}</select></div>
        <div class="field" style="max-width:100px"><label>Temp °C</label><input id="j-temp" value="${esc(j.temp)}"></div></div>
      <div class="field"><label>Anwesendes Personal / Firmen</label><input id="j-workers" value="${esc(j.workers)}" placeholder="z.B. 4 Maurer, Elektriker (2)"></div>
      <div class="field"><label id="j-text-label">Geschehen / Bemerkungen</label><textarea id="j-text" style="min-height:120px" placeholder="Was geschah heute auf der Baustelle…">${esc(j.text)}</textarea></div>
    </div>
    <div class="modal-foot">${isNew?'':'<button class="btn btn-danger" id="jDel">Löschen</button>'}<button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>${isNew?'':'<button class="btn btn-steel" id="jPdf">⬇ Als PDF</button>'}<button class="btn btn-primary" id="jSave">Speichern</button></div>`);
  const jp=document.getElementById('jPdf');if(jp)jp.onclick=()=>exportJournalPDF(j);
  attachDictateButton(document.getElementById('j-text-label'),document.getElementById('j-text'));
  document.getElementById('jSave').onclick=async(ev)=>{if(guardBusy(ev.currentTarget))return;j.date=document.getElementById('j-date').value;j.weather=document.getElementById('j-weather').value;j.temp=document.getElementById('j-temp').value;j.workers=document.getElementById('j-workers').value;j.text=document.getElementById('j-text').value;await put('journal',j);closeModal();toast('Journaleintrag gespeichert',true);renderJournal();};
  if(!isNew){const jd=document.getElementById('jDel');if(jd)jd.onclick=async()=>{const ok=await confirmDelete('journal',j.id,'Eintrag '+fmtDate(j.date),renderJournal);if(ok)closeModal();};}
}

/* ============================================================
   MODULE: AKTENNOTIZEN
   ============================================================ */
async function renderNotes(){
  const stage=document.getElementById('stage');
  const notes=(await byProject('notes')).sort((a,b)=>b.date.localeCompare(a.date));
  stage.innerHTML=`
    <div class="module">
      <div class="mod-head"><div><h1>Aktennotizen</h1><div class="sub">Besprechungen · Telefonate · Lieferungen festhalten</div></div>
        <div class="spacer"></div><button class="btn btn-primary btn-sm" id="newNoteBtn">＋ Neue Notiz</button></div>
      <div class="mod-body">
        ${notes.length?notes.map(n=>`<div class="card" style="cursor:pointer;margin-bottom:12px;max-width:100%" data-id="${n.id}">
          <button class="card-del" data-del="${n.id}" title="Notiz löschen">×</button>
          <div style="display:flex;gap:10px;align-items:center;padding-right:30px"><b style="overflow-wrap:anywhere">${esc(n.title)}</b><span class="pill">${esc(n.category)}</span><span style="margin-left:auto;font-size:12px;color:var(--muted);white-space:nowrap">${fmtDate(n.date)}</span></div>
          <div style="margin-top:7px;font-size:13.5px;line-height:1.6;overflow-wrap:anywhere">${esc(n.text).slice(0,200)}${n.text.length>200?'…':''}</div></div>`).join('')
        :`<div class="empty"><div class="big">📝</div><h3>Keine Aktennotizen</h3><p>Halte Besprechungen und Vereinbarungen fest – auf Wunsch direkt als Pendenz.</p></div>`}
      </div>
    </div>`;
  document.getElementById('newNoteBtn').onclick=()=>openNoteEditor();
  document.querySelectorAll('.card[data-id]').forEach(c=>c.onclick=async e=>{if(e.target.closest('.card-del'))return;openNoteEditor(await get('notes',c.dataset.id));});
  document.querySelectorAll('.card-del[data-del]').forEach(b=>b.onclick=async e=>{e.stopPropagation();const n=await get('notes',b.dataset.del);await confirmDelete('notes',b.dataset.del,n?n.title:'Notiz',renderNotes);});
}
async function openNoteEditor(n){
  const isNew=!n;
  n=n||{id:uid(),projectId:state.projectId,title:'',category:'Besprechung',date:todayISO(),text:'',assignee:'',assigneeId:'',due:'',photos:[],author:CURRENT_USER.name,createdAt:nowISO()};
  if(!n.photos)n.photos=[];
  const contacts=await byProject('contacts');
  const photos=(n.photos||[]).map((p,i)=>`<img src="${p}" data-i="${i}">`).join('');
  modal(`<div class="modal-head"><h3>${isNew?'Neue Aktennotiz':esc(n.title)}</h3></div>
    <div class="modal-body">
      <div class="field-row"><div class="field"><label>Titel</label><input id="n-title" value="${esc(n.title)}"></div>
        <div class="field" style="max-width:170px"><label>Kategorie</label><select id="n-cat">${['Besprechung','Telefonat','Lieferung','Quittung','Sonstiges'].map(c=>`<option ${n.category===c?'selected':''}>${c}</option>`).join('')}</select></div>
        <div class="field" style="max-width:150px"><label>Datum</label><input type="date" id="n-date" value="${n.date}"></div></div>
      <div class="field"><label id="n-text-label">Inhalt</label><textarea id="n-text" style="min-height:110px">${esc(n.text)}</textarea></div>
      <div class="field-row">
        <div class="field"><label>Zuständiger Unternehmer (für Pendenzenliste)</label>
          <select id="n-assignee"><option value="">— keiner —</option>${contacts.map(c=>`<option value="${c.id}" ${c.id===n.assigneeId?'selected':''}>${esc(c.company)}</option>`).join('')}</select></div>
        <div class="field" style="max-width:160px"><label>Frist</label><input type="date" id="n-due" value="${n.due||''}"></div>
      </div>
      <div class="field"><label>Fotos</label><div class="photo-grid" id="notePhotoGrid">${photos}<button class="photo-add" id="notePhotoAdd">＋</button></div></div>
    </div>
    <div class="modal-foot">
      ${isNew?'':'<button class="btn btn-danger" id="nDel">Löschen</button>'}
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-steel" id="noteToPend">⚠ Als Pendenz</button>
      <button class="btn btn-primary" id="nSave">Speichern</button></div>`,{wide:true});
  attachDictateButton(document.getElementById('n-text-label'),document.getElementById('n-text'));
  const collectNote=()=>{
    n.title=document.getElementById('n-title').value.trim()||'Notiz';n.category=document.getElementById('n-cat').value;
    n.date=document.getElementById('n-date').value;n.text=document.getElementById('n-text').value;
    n.due=document.getElementById('n-due').value;
    const aid=document.getElementById('n-assignee').value;n.assigneeId=aid;
    const c=contacts.find(x=>x.id===aid);n.assignee=c?c.company:'';
    return n;
  };
  document.getElementById('notePhotoAdd').onclick=()=>{collectNote();openPhotoSource(async(b64)=>{n.photos.push(b64);await put('notes',n);openNoteEditor(await get('notes',n.id));});};
  document.querySelectorAll('#notePhotoGrid img').forEach(img=>img.onclick=()=>window.open(img.src,'_blank'));
  document.getElementById('nSave').onclick=async()=>{await put('notes',collectNote());closeModal();toast('Notiz gespeichert',true);renderNotes();};
  if(!isNew){const nd=document.getElementById('nDel');if(nd)nd.onclick=async()=>{const ok=await confirmDelete('notes',n.id,n.title||'Notiz',renderNotes);if(ok)closeModal();};}
  document.getElementById('noteToPend').onclick=async(ev)=>{
    const btn=ev.currentTarget;
    if(guardBusy(btn))return; // Doppelklick-Schutz gegen Duplikate
    collectNote();
    if(n.pendenzId && await get('defects',n.pendenzId)){
      releaseBusy(btn);
      toast('Aus dieser Notiz wurde bereits eine Pendenz erstellt');return;
    }
    const defs=await byProject('defects');const num=defs.reduce((m,d)=>Math.max(m,d.num),0)+1;
    const plans=await byProject('plans');
    const newId=uid();
    await put('defects',{id:newId,projectId:state.projectId,planId:plans[0]?.id||'',num,title:n.title||'Aus Aktennotiz',desc:n.text,status:'Offen',assignee:n.assignee,assigneeId:n.assigneeId,due:n.due,trade:'',rx:0.5,ry:0.5,page:1,photos:[...(n.photos||[])],createdAt:nowISO(),createdBy:CURRENT_USER.name,history:[{at:nowISO(),by:CURRENT_USER.name,action:'Aus Aktennotiz erstellt'}]});
    n.pendenzId=newId;await put('notes',n);
    closeModal();toast('Pendenz erstellt – im Modul „Pläne & Mängel" sichtbar',true);await renderRail();
  };
}

/* ============================================================
   MODULE: ADRESSLISTE
   ============================================================ */
async function renderContacts(){
  const stage=document.getElementById('stage');
  let contacts=await byProject('contacts');
  // Sortierung: Bauleitung/Architektur immer zuoberst, danach nach BKP-Code, dann Firma
  const bkpSort=c=>{ const b=c.bkp||c.trade||''; const m=b.match(/^(\d+)/); return m?parseInt(m[1]):9999; };
  contacts=contacts.sort((a,b)=>{
    const aTop=a.list==='Bauleitung/Architektur'?0:1, bTop=b.list==='Bauleitung/Architektur'?0:1;
    if(aTop!==bTop)return aTop-bTop;
    const bs=bkpSort(a)-bkpSort(b); if(bs)return bs;
    return (a.company||'').localeCompare(b.company||'');
  });
  const personRow=(name,role,phone,email)=>name?`<div class="ct-p">
    <div class="ct-p-name">${esc(name)}${role?` <span class="ct-p-role">· ${esc(role)}</span>`:''}</div>
    ${phone?`<a href="tel:${esc(phone)}" onclick="event.stopPropagation()">📞 ${esc(phone)}</a>`:''}
    ${email?`<a href="mailto:${esc(email)}" onclick="event.stopPropagation()">✉ ${esc(email)}</a>`:''}
  </div>`:'';
  stage.innerHTML=`
    <div class="module">
      <div class="mod-head"><div><h1>Unternehmerliste</h1><div class="sub">Bauleitung/Architektur zuoberst · sortiert nach BKP · anrufen / mailen</div></div>
        <div class="spacer"></div><button class="btn btn-ghost btn-sm" id="contPdfBtn">⬇ PDF</button><button class="btn btn-primary btn-sm" id="newContBtn">＋ Kontakt</button></div>
      <div class="mod-body">
        ${contacts.length?`<div class="unt-list">${contacts.map(c=>`
          <div class="unt-card" data-id="${c.id}">
            <div class="unt-bkp">${esc(c.bkp||c.trade||'—')}</div>
            <div class="unt-main">
              <div class="unt-title">${esc(c.company)}${c.list==='Bauleitung/Architektur'?' <span class="pill">Bauleitung/Architektur</span>':''}</div>
              <div class="ct-persons-row">${personRow(c.contact,c.role1,c.phone,c.email)}${personRow(c.contact2,c.role2,c.phone2,c.email2)}</div>
              ${(c.contact3||c.contact4)?`<div class="ct-persons-row">${personRow(c.contact3,c.role3,c.phone3,c.email3)}${personRow(c.contact4,c.role4,c.phone4,c.email4)}</div>`:''}
            </div>
            <button class="row-del" data-del="${c.id}" title="Kontakt löschen">×</button>
          </div>`).join('')}</div>`
        :`<div class="empty"><div class="big">👥</div><h3>Keine Kontakte</h3><p>Erfasse Planer und Unternehmer für Zuweisungen und Massenversand.</p></div>`}
      </div>
    </div>`;
  document.getElementById('newContBtn').onclick=()=>openContactEditor();
  document.getElementById('contPdfBtn').onclick=()=>exportContactsPDF(contacts);
  document.querySelectorAll('.unt-card').forEach(card=>card.onclick=async e=>{if(e.target.closest('.row-del')||e.target.closest('a'))return;openContactEditor(await get('contacts',card.dataset.id));});
  document.querySelectorAll('.row-del[data-del]').forEach(b=>b.onclick=async e=>{e.stopPropagation();const c=await get('contacts',b.dataset.del);await confirmDelete('contacts',b.dataset.del,c?c.company:'Kontakt',renderContacts);});
}
async function openContactEditor(c){
  const isNew=!c;
  c=c||{id:uid(),projectId:state.projectId,list:'Unternehmer',company:'',contact:'',role1:'',phone:'',email:'',contact2:'',role2:'',phone2:'',email2:'',contact3:'',role3:'',phone3:'',email3:'',contact4:'',role4:'',phone4:'',email4:'',bkp:'',trade:''};
  const LISTS=['Bauleitung/Architektur','Unternehmer','Planer','Bauherr','Behörde','Sonstige'];
  const personBlock=(n,visible)=>`
    <div class="ct-person" data-person="${n}" style="${visible?'':'display:none'}">
      <div style="border-top:1px solid var(--line);margin:10px 0 4px;padding-top:10px;display:flex;align-items:center;justify-content:space-between">
        <div style="font-weight:700;font-size:13px">Ansprechperson ${n}</div>
        ${n>2?`<button type="button" class="row-del" data-rmperson="${n}" title="Entfernen">×</button>`:''}
      </div>
      <div class="field-row"><div class="field"><label>Name</label><input id="ct-contact${n>1?n:''}" value="${esc(n===1?c.contact:(c['contact'+n]||''))}"></div>
        <div class="field"><label>Funktion</label><input id="ct-role${n>1?n:'1'}" value="${esc(n===1?(c.role1||''):(c['role'+n]||''))}" placeholder="z.B. Bauführer"></div></div>
      <div class="field-row"><div class="field"><label>Telefon</label><input id="ct-phone${n>1?n:''}" value="${esc(n===1?c.phone:(c['phone'+n]||''))}"></div>
        <div class="field"><label>E-Mail</label><input id="ct-email${n>1?n:''}" value="${esc(n===1?c.email:(c['email'+n]||''))}"></div></div>
    </div>`;
  const has3=!!(c.contact3), has4=!!(c.contact4);
  modal(`<div class="modal-head"><h3>${isNew?'Neuer Kontakt':esc(c.company)}</h3></div>
    <div class="modal-body">
      <div class="field-row"><div class="field"><label>Liste</label><select id="ct-list">${LISTS.map(l=>`<option ${c.list===l?'selected':''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>Firma</label><input id="ct-company" value="${esc(c.company)}"></div></div>
      <div class="field"><label>BKP / Gewerk</label>
        <select id="ct-bkp" style="width:100%"><option value="">— BKP wählen —</option>${BKP.map(b=>`<option ${(c.bkp===b||c.trade===b)?'selected':''}>${b}</option>`).join('')}</select>
        <div style="font-size:11.5px;color:var(--muted);margin-top:4px">Nicht in der Liste? Freitext im Feld darunter.</div>
        <input id="ct-trade" value="${esc(c.trade&&!BKP.includes(c.trade)?c.trade:'')}" placeholder="Eigene Bezeichnung (optional)" style="margin-top:6px">
      </div>
      ${personBlock(1,true)}
      ${personBlock(2,true)}
      ${personBlock(3,has3)}
      ${personBlock(4,has4)}
      <div id="addPersonRow" style="margin-top:12px">
        <select id="addPersonPick" style="max-width:260px">
          <option value="">＋ Weitere Ansprechperson…</option>
          ${!has3?'<option value="3">3. Ansprechperson</option>':''}
          ${!has4?'<option value="4">4. Ansprechperson</option>':''}
        </select>
      </div>
    </div>
    <div class="modal-foot">${isNew?'':'<button class="btn btn-danger" id="ctDel">Löschen</button>'}<button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button><button class="btn btn-primary" id="ctSave">Speichern</button></div>`,{wide:true});
  const pick=document.getElementById('addPersonPick');
  if(pick)pick.onchange=()=>{
    const n=pick.value;if(!n)return;
    document.querySelector(`.ct-person[data-person="${n}"]`).style.display='';
    pick.querySelector(`option[value="${n}"]`).remove();
    if(pick.options.length<=1) document.getElementById('addPersonRow').style.display='none';
  };
  document.querySelectorAll('[data-rmperson]').forEach(b=>b.onclick=()=>{
    const n=b.dataset.rmperson;
    const blk=document.querySelector(`.ct-person[data-person="${n}"]`);
    blk.querySelectorAll('input').forEach(i=>i.value='');
    blk.style.display='none';
    if(pick){const opt=document.createElement('option');opt.value=n;opt.textContent=n+'. Ansprechperson';pick.appendChild(opt);document.getElementById('addPersonRow').style.display='';}
  });
  document.getElementById('ctSave').onclick=async()=>{
    c.list=document.getElementById('ct-list').value;
    c.company=document.getElementById('ct-company').value.trim();
    c.bkp=document.getElementById('ct-bkp').value;
    const freeTrade=document.getElementById('ct-trade').value.trim();
    c.trade=freeTrade||c.bkp;
    c.contact=document.getElementById('ct-contact').value.trim();
    c.role1=document.getElementById('ct-role1').value.trim();
    c.phone=document.getElementById('ct-phone').value.trim();
    c.email=document.getElementById('ct-email').value.trim();
    for(const n of [2,3,4]){
      const blk=document.querySelector(`.ct-person[data-person="${n}"]`);
      const active=blk&&blk.style.display!=='none';
      c['contact'+n]=active?document.getElementById('ct-contact'+n).value.trim():'';
      c['role'+n]=active?document.getElementById('ct-role'+n).value.trim():'';
      c['phone'+n]=active?document.getElementById('ct-phone'+n).value.trim():'';
      c['email'+n]=active?document.getElementById('ct-email'+n).value.trim():'';
    }
    await put('contacts',c);closeModal();toast('Kontakt gespeichert',true);renderContacts();
  };
  if(!isNew)document.getElementById('ctDel').onclick=async()=>{const ok=await confirmDelete('contacts',c.id,c.company||'Kontakt',renderContacts);if(ok)closeModal();};
}
async function exportContactsPDF(contacts){
  const {jsPDF}=window.jspdf;const doc=new jsPDF();const proj=await get('projects',state.projectId);
  // Sortierung wie in der App: Bauleitung/Architektur zuoberst, dann nach BKP-Code
  const bkpSort=c=>{ const b=c.bkp||c.trade||''; const m=b.match(/^(\d+)/); return m?parseInt(m[1]):9999; };
  contacts=[...contacts].sort((a,b)=>{
    const aTop=a.list==='Bauleitung/Architektur'?0:1, bTop=b.list==='Bauleitung/Architektur'?0:1;
    if(aTop!==bTop)return aTop-bTop;
    const bs=bkpSort(a)-bkpSort(b); if(bs)return bs;
    return (a.company||'').localeCompare(b.company||'');
  });
  let y=pdfDocHead(doc,'Unternehmerliste',[{l:proj.name,proj:true}]);
  const BKP_W=38, PERSON_W=70;
  contacts.forEach(c=>{
    const persons=[[c.contact,c.role1,c.phone,c.email],[c.contact2,c.role2,c.phone2,c.email2],[c.contact3,c.role3,c.phone3,c.email3],[c.contact4,c.role4,c.phone4,c.email4]].filter(p=>p[0]);
    const rows=Math.max(1,Math.ceil(persons.length/2));
    const blockH=8+rows*10+3;
    y=pdfEnsureSpace(doc,y,blockH,()=>20);
    // BKP-Spalte
    doc.setFontSize(7.5);doc.setTextColor(107,98,88);
    const bkpLines=doc.splitTextToSize(c.bkp||c.trade||'—',BKP_W-2);
    doc.text(bkpLines,PDF.ML,y+4);
    // Titel = Firma
    doc.setTextColor(26,26,26);doc.setFontSize(10.5);doc.setFont(undefined,'bold');
    doc.text(c.company||'—',PDF.ML+BKP_W,y+4);doc.setFont(undefined,'normal');
    let py=y+9;
    for(let i=0;i<persons.length;i+=2){
      const p1=persons[i], p2=persons[i+1];
      const drawP=(p,x)=>{ if(!p)return;
        doc.setFontSize(8.5);doc.setTextColor(40);doc.setFont(undefined,'bold');
        doc.text(p[0]+(p[1]?'  ·  '+p[1]:''),x,py);doc.setFont(undefined,'normal');
        doc.setFontSize(7.8);doc.setTextColor(100);
        let ly=py+4;
        if(p[2]){doc.text('Tel: '+p[2],x,ly);ly+=3.6;}
        if(p[3]){doc.text(p[3],x,ly);}
      };
      drawP(p1,PDF.ML+BKP_W);drawP(p2,PDF.ML+BKP_W+PERSON_W);
      py+=10;
    }
    doc.setDrawColor(232,227,219);doc.setLineWidth(0.2);doc.line(PDF.ML,y+blockH-1,PDF.MR,y+blockH-1);
    y+=blockH;
  });
  pdfFooterAllPages(doc);
  doc.save('Unternehmerliste.pdf');toast('Unternehmerliste exportiert',true);
}

/* ============================================================
   MODUL: HONORAROFFERTE NACH SIA 102
   ------------------------------------------------------------
   Phasen-Kostenrechner (Stunden × Stundenansatz, frei überschreibbar),
   inkl./exkl. MwSt., freie Texteingabe, editierbare Stundenansatztabelle
   auf der letzten PDF-Seite.
   ============================================================ */
const SIA102_PHASES=[
  {num:'0', name:'Machbarkeitsstudie (zusätzliche Leistung)', desc:'Gemäss Absprache mit Bauherrschaft'},
  {num:'1', name:'Vorprojekt', desc:'Studium und Lösungsmöglichkeiten\nGrobkostenschätzung'},
  {num:'2', name:'Bauprojekt', desc:'Bauprojekt\nDetailstudien\nKostenvoranschlag'},
  {num:'3', name:'Baubewilligung', desc:'Bewilligungsverfahren'},
  {num:'4', name:'Ausschreibung', desc:'Ausschreibungspläne\nAusschreibung und Vergabe'},
  {num:'5.1', name:'Ausführungsprojekt', desc:'Ausführungspläne\nWerkverträge'},
  {num:'5.2', name:'Ausführung', desc:'Gestalterische Leitung\nBauleitung und Kostenkontrolle'},
  {num:'5.3', name:'Inbetriebnahme, Abschluss', desc:'Inbetriebnahme\nDokumentation über das Bauwerk\nLeitung der Garantiearbeiten\nSchlussabrechnungen'}
];
const HONORAR_EXCLUSIONS_DEFAULT=[
  'Planung Heizung, Lüftung, Klima, Kälte, Elektro, Beleuchtung, Druckluft (allg. Haustechnik)',
  'Gelände- oder Liegenschaftsaufnahme',
  'Unvorhergesehene Arbeiten durch Nachbaren, Einsprachen oder Ämter (z.B. Ortsbild, Denkmalpflege)',
  'Unvorhergesehene Arbeiten durch Geologie',
  'Kosten durch externe Unternehmer',
  'Plan-, Fotokopien, Spesen & Gebühren sowie MWST.'
].map(l=>'- '+l).join('\n');
function _honorarNew(){
  return {id:uid(),projectId:state.projectId,
    recipientName:'',recipientStreet:'',recipientPlace:'',
    place:'',date:todayISO(),refNumber:'',
    object:'',offerNumber:'',
    basis:'- Vorprojekt vom \n- Grobkostenschätzung vom \n- Annahme honorarberechtigte Bausumme: ',
    baseSum:0, globalRate:180,
    phases:SIA102_PHASES.map(p=>({id:uid(),num:p.num,name:p.name,desc:p.desc,hours:0,amount:0})),
    mwstMode:'exkl', mwstRate:8.1, notes:HONORAR_EXCLUSIONS_DEFAULT,
    signerName:CURRENT_USER.name||'', signature:'', signed:false,
    createdAt:nowISO()};
}
async function renderHonorar(){
  const stage=document.getElementById('stage');
  const list=(await byProject('honorars')).sort((a,b)=>b.date.localeCompare(a.date));
  stage.innerHTML=`
    <div class="module">
      <div class="mod-head"><div><h1>Honorarofferte SIA 102</h1><div class="sub">Phasen-Kostenrechner · inkl./exkl. MwSt. · frei bearbeitbar</div></div>
        <div class="spacer"></div><button class="btn btn-primary btn-sm" id="newHonBtn">＋ Neue Offerte</button></div>
      <div class="mod-body">
        ${list.length?list.map(h=>{
          const total=(h.phases||[]).reduce((s,p)=>s+(Number(p.amount)||0),0);
          const gross=h.mwstMode==='exkl'?total*(1+h.mwstRate/100):total;
          return `<div class="card" style="cursor:pointer;margin-bottom:12px;max-width:100%" data-id="${h.id}">
          <button class="card-del" data-del="${h.id}" title="Offerte löschen">×</button>
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-right:30px"><b style="font-size:15px">${esc(h.object||'Ohne Bezeichnung')}</b><span style="margin-left:auto;font-size:12px;color:var(--muted)">${fmtDate(h.date)}</span></div>
          <div style="margin-top:6px;font-size:13px;color:var(--muted)">${esc(h.recipientName||'—')}</div>
          <div style="margin-top:8px;font-weight:700;color:var(--brand-red)">${money(gross)} (inkl. MwSt.)</div>
          </div>`;
        }).join(''):`<div class="empty"><div class="big">🧮</div><h3>Keine Honorarofferten</h3><p>Erstelle eine Honorarofferte nach SIA 102 mit Phasen, Stundenansätzen und MwSt.-Berechnung.</p></div>`}
      </div>
    </div>`;
  document.getElementById('newHonBtn').onclick=()=>openHonorarEditor();
  document.querySelectorAll('.card[data-id]').forEach(c=>c.onclick=async e=>{if(e.target.closest('.card-del'))return;openHonorarEditor(await get('honorars',c.dataset.id));});
  document.querySelectorAll('.card-del[data-del]').forEach(b=>b.onclick=async e=>{e.stopPropagation();const h=await get('honorars',b.dataset.del);await confirmDelete('honorars',b.dataset.del,h?h.object:'Offerte',renderHonorar);});
}
async function openHonorarEditor(h){
  const isNew=!h;
  h=h?JSON.parse(JSON.stringify(h)):_honorarNew();
  // Migration: ältere Offerten (vor der Layout-Überarbeitung) ergänzen –
  // verhindert stille Fehler beim PDF-Export durch fehlende Felder.
  h.recipientName=h.recipientName||h.client||'';
  h.recipientStreet=h.recipientStreet||'';
  h.recipientPlace=h.recipientPlace||'';
  h.place=h.place||'';
  h.refNumber=h.refNumber||'';
  h.offerNumber=h.offerNumber||'';
  h.basis=h.basis||'';
  h.baseSum=h.baseSum||0;
  h.globalRate=h.globalRate||(h.phases&&h.phases[0]&&h.phases[0].rate)||180;
  h.signerName=h.signerName||'';
  h.signature=h.signature||'';
  h.phases=(h.phases||[]).map((p,i)=>({
    id:p.id||uid(),
    num:p.num!==undefined?p.num:String(i+1),
    name:p.name||'',
    desc:p.desc||'',
    hours:p.hours||0,
    amount:p.amount!==undefined?p.amount:((p.hours||0)*(p.rate||h.globalRate||0))
  }));
  const proj=await get('projects',state.projectId);
  if(isNew&&!h.object)h.object=proj.name||'';
  if(isNew&&!h.place)h.place='';
  modal(`<div class="modal-head"><h3>${isNew?'Neue Honorarofferte':esc(h.object)}</h3><p>Layout nach Vorlage · Zahlen (Stunden/Ansatz) sind nur Rechenhilfe im Hintergrund und erscheinen nicht im PDF.</p></div>
    <div class="modal-body">
      <div style="font-weight:700;font-size:13px;margin-bottom:6px">Empfänger</div>
      <div class="field"><label>Name</label><input id="ho-rname" value="${esc(h.recipientName)}" placeholder="z.B. Flavia & Thomas Koller"></div>
      <div class="field-row"><div class="field"><label>Strasse</label><input id="ho-rstreet" value="${esc(h.recipientStreet)}"></div>
        <div class="field"><label>PLZ / Ort</label><input id="ho-rplace" value="${esc(h.recipientPlace)}"></div></div>
      <div class="field-row"><div class="field" style="max-width:160px"><label>Ort (Absender)</label><input id="ho-place" value="${esc(h.place)}" placeholder="z.B. Engelburg"></div>
        <div class="field" style="max-width:160px"><label>Datum</label><input type="date" id="ho-date" value="${h.date}"></div>
        <div class="field"><label>Referenz (klein, optional)</label><input id="ho-ref" value="${esc(h.refNumber)}" placeholder="z.B. 695.02 – Honorarberechnung gemäss SIA"></div></div>
      <div class="field-row"><div class="field"><label>Bauvorhaben / Objekt (Titelzeile)</label><input id="ho-object" value="${esc(h.object)}"></div>
        <div class="field" style="max-width:180px"><label>Offerten-Nr.</label><input id="ho-offnr" value="${esc(h.offerNumber)}"></div></div>
      <div class="field"><label>Grundlage <span style="font-weight:400;color:var(--muted);font-size:12px">(je Zeile ein Punkt, „- " wird als Aufzählung dargestellt)</span></label>
        <textarea id="ho-basis" style="min-height:70px">${esc(h.basis||'')}</textarea></div>

      <div style="border-top:1px solid var(--line);margin:14px 0 10px;padding-top:12px;font-weight:700;font-size:13px">Rechenhilfe (nur im Hintergrund – erscheint NICHT im PDF)</div>
      <div class="field-row">
        <div class="field" style="max-width:220px"><label>Honorarberechtigte Bausumme CHF</label><input id="ho-basesum" type="number" step="1000" value="${h.baseSum||0}"></div>
        <div class="field" style="max-width:180px"><label>Stundenansatz CHF/h <span style="font-weight:400;color:var(--muted);font-size:11px">(1× für alle Phasen)</span></label><input id="ho-rate" type="number" step="5" value="${h.globalRate||0}"></div>
        <div class="field" style="max-width:160px"><label>MwSt.-Darstellung</label><select id="ho-mwstmode"><option value="exkl" ${h.mwstMode==='exkl'?'selected':''}>exkl. MwSt.</option><option value="inkl" ${h.mwstMode==='inkl'?'selected':''}>inkl. MwSt.</option></select></div>
        <div class="field" style="max-width:100px"><label>MwSt. %</label><input id="ho-mwstrate" type="number" step="0.1" value="${h.mwstRate}"></div>
      </div>

      <div class="field"><label>Leistungsphasen</label>
        <div style="overflow-x:auto"><table class="tbl" style="font-size:12.5px" id="phaseTbl">
          <thead><tr><th style="width:52px">Nr.</th><th>Bezeichnung</th><th style="width:64px">Std.</th><th style="width:110px">Betrag CHF</th><th style="width:30px"></th></tr></thead>
          <tbody id="phaseBody"></tbody>
        </table></div>
        <button class="btn btn-ghost btn-sm" id="addPhaseBtn" type="button" style="margin-top:8px">＋ Phase</button>
      </div>
      <div id="honTotals" style="margin-top:10px;padding:12px;background:var(--paper-2);border-radius:8px;font-size:13.5px"></div>

      <div class="field" style="margin-top:14px"><label>In den Leistungen nicht inbegriffen <span style="font-weight:400;color:var(--muted);font-size:12px">(je Zeile ein Punkt)</span></label>
        <textarea id="ho-notes" style="min-height:100px">${esc(h.notes||'')}</textarea></div>

      <div style="border-top:1px solid var(--line);margin:14px 0 10px;padding-top:12px;font-weight:700;font-size:13px">Unterschrift</div>
      <div class="field" style="max-width:280px"><label>Name der unterzeichnenden Person</label><input id="ho-signer" value="${esc(h.signerName||'')}"></div>
      <div class="field" style="max-width:300px"><label>Unterschrift (digital)</label><canvas class="sign-pad" id="hoSig" width="300" height="90"></canvas><button class="btn btn-ghost btn-sm" id="hoSigClr" style="margin-top:4px">Löschen</button></div>
    </div>
    <div class="modal-foot">
      ${isNew?'':'<button class="btn btn-danger" id="hoDel">Löschen</button>'}
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-steel" id="hoPdf">⬇ Als PDF</button>
      <button class="btn btn-primary" id="hoSave">Speichern</button>
    </div>`,{wide:true});

  const padSig=attachSignPad(document.getElementById('hoSig'));
  if(h.signature){const img=new Image();img.onload=()=>document.getElementById('hoSig').getContext('2d').drawImage(img,0,0);img.src=h.signature;}
  document.getElementById('hoSigClr').onclick=()=>padSig.clear();

  function calcTotals(){
    const withoutZero=h.phases.filter(p=>p.num!=='0').reduce((s,p)=>s+(Number(p.amount)||0),0);
    const all=h.phases.reduce((s,p)=>s+(Number(p.amount)||0),0);
    const hasZero=h.phases.some(p=>p.num==='0');
    const rate=Number(h.mwstRate)||0;
    let netAmt,mwstAmt,grossAmt;
    if(h.mwstMode==='inkl'){grossAmt=all;netAmt=all/(1+rate/100);mwstAmt=grossAmt-netAmt;}
    else{netAmt=all;mwstAmt=all*rate/100;grossAmt=netAmt+mwstAmt;}
    const pct=h.baseSum>0?(withoutZero/h.baseSum*100):null;
    document.getElementById('honTotals').innerHTML=`
      <div style="display:flex;justify-content:space-between;padding:3px 0"><span>Kosten exkl. MwSt.${pct!=null?` (Honorar ${pct.toFixed(1)}%)`:''}</span><b>${money(withoutZero)}</b></div>
      ${hasZero?`<div style="display:flex;justify-content:space-between;padding:3px 0"><span>Kosten exkl. MwSt. (ab Machbarkeitsstudie)</span><b>${money(all)}</b></div>`:''}
      <div style="display:flex;justify-content:space-between;padding:3px 0;color:var(--muted);border-top:1px dashed var(--line);margin-top:4px;padding-top:6px"><span>MwSt. (${rate}%)</span><span>${money(mwstAmt)}</span></div>
      <div style="display:flex;justify-content:space-between;padding:5px 0 0;font-size:15px;color:var(--brand-red)"><b>Total inkl. MwSt.</b><b>${money(grossAmt)}</b></div>`;
  }
  function recalcAmount(i){
    const rate=Number(h.globalRate)||0;
    h.phases[i].amount=Math.round((h.phases[i].hours||0)*rate*100)/100;
  }
  function drawPhases(){
    document.getElementById('phaseBody').innerHTML=h.phases.map((p,i)=>`
      <tr data-i="${i}" style="border-top:2px solid var(--paper)">
        <td><input data-k="num" data-i="${i}" value="${esc(p.num)}" style="width:44px;border:none;background:transparent;font-weight:700;color:var(--brand-red)"></td>
        <td><input data-k="name" data-i="${i}" value="${esc(p.name)}" style="width:100%;border:none;background:transparent;font-weight:600"></td>
        <td><input data-k="hours" data-i="${i}" type="number" step="0.5" value="${p.hours||0}" style="width:56px"></td>
        <td><input data-k="amount" data-i="${i}" type="number" step="1" value="${p.amount||0}" style="width:100px;font-weight:700"></td>
        <td><button class="row-del" data-rmphase="${i}" type="button">×</button></td>
      </tr>
      <tr data-i="${i}"><td></td><td colspan="4" style="padding-top:0">
        <textarea data-k="desc" data-i="${i}" placeholder="Beschreibung – je Zeile ein Aufzählungspunkt (erscheint im PDF)…" style="width:100%;min-height:38px;border:1px solid var(--line);border-radius:6px;padding:6px 8px;background:var(--paper-2);font-size:12px;color:var(--muted)">${esc(p.desc||'')}</textarea>
      </td></tr>`).join('');
    document.querySelectorAll('#phaseBody [data-k="num"]').forEach(inp=>inp.oninput=()=>{h.phases[+inp.dataset.i].num=inp.value;});
    document.querySelectorAll('#phaseBody [data-k="name"]').forEach(inp=>inp.oninput=()=>{h.phases[+inp.dataset.i].name=inp.value;});
    document.querySelectorAll('#phaseBody [data-k="desc"]').forEach(inp=>inp.oninput=()=>{h.phases[+inp.dataset.i].desc=inp.value;});
    document.querySelectorAll('#phaseBody [data-k="hours"]').forEach(inp=>inp.oninput=()=>{
      const i=+inp.dataset.i; h.phases[i].hours=Number(inp.value)||0; recalcAmount(i);
      const amtEl=document.querySelector(`#phaseBody [data-k="amount"][data-i="${i}"]`); if(amtEl)amtEl.value=h.phases[i].amount;
      calcTotals();
    });
    document.querySelectorAll('#phaseBody [data-k="amount"]').forEach(inp=>inp.oninput=()=>{
      h.phases[+inp.dataset.i].amount=Number(inp.value)||0; calcTotals();
    });
    document.querySelectorAll('[data-rmphase]').forEach(b=>b.onclick=()=>{h.phases.splice(+b.dataset.rmphase,1);drawPhases();calcTotals();});
  }
  drawPhases();calcTotals();
  document.getElementById('addPhaseBtn').onclick=()=>{h.phases.push({id:uid(),num:'',name:'Neue Phase',desc:'',hours:0,amount:0});drawPhases();calcTotals();};
  document.getElementById('ho-mwstmode').onchange=e=>{h.mwstMode=e.target.value;calcTotals();};
  document.getElementById('ho-mwstrate').oninput=e=>{h.mwstRate=Number(e.target.value)||0;calcTotals();};
  document.getElementById('ho-basesum').oninput=e=>{h.baseSum=Number(e.target.value)||0;calcTotals();};
  document.getElementById('ho-rate').oninput=e=>{
    h.globalRate=Number(e.target.value)||0;
    h.phases.forEach((p,i)=>recalcAmount(i));
    drawPhases();calcTotals();
  };

  function collect(){
    h.recipientName=document.getElementById('ho-rname').value.trim();
    h.recipientStreet=document.getElementById('ho-rstreet').value.trim();
    h.recipientPlace=document.getElementById('ho-rplace').value.trim();
    h.place=document.getElementById('ho-place').value.trim();
    h.date=document.getElementById('ho-date').value;
    h.refNumber=document.getElementById('ho-ref').value.trim();
    h.object=document.getElementById('ho-object').value.trim();
    h.offerNumber=document.getElementById('ho-offnr').value.trim();
    h.basis=document.getElementById('ho-basis').value;
    h.notes=document.getElementById('ho-notes').value;
    h.signerName=document.getElementById('ho-signer').value.trim();
    h.signature=padSig.data();h.signed=!!h.signature;
    return h;
  }
  document.getElementById('hoSave').onclick=async()=>{collect();await put('honorars',h);closeModal();toast('Honorarofferte gespeichert',true);renderHonorar();};
  document.getElementById('hoPdf').onclick=()=>{collect();exportHonorarPDF(h,proj);};
  if(!isNew)document.getElementById('hoDel').onclick=async()=>{const ok=await confirmDelete('honorars',h.id,h.object||'Offerte',renderHonorar);if(ok)closeModal();};
}
// Zeichnet einen Bullet-Text-Block (Zeilen mit "- " werden als Aufzählung dargestellt)
function pdfBulletBlock(doc,text,x,y,w,lh){
  const lines=(text||'').split('\n').filter(l=>l.trim());
  let ty=y;
  lines.forEach(line=>{
    const clean=line.replace(/^[-•]\s*/,'');
    const wrapped=doc.splitTextToSize(clean,w-6);
    doc.text('-',x,ty);
    doc.text(wrapped,x+5,ty);
    ty+=wrapped.length*(lh||4.6);
  });
  return ty;
}
function pdfBulletHeight(doc,text,w,lh){
  const lines=(text||'').split('\n').filter(l=>l.trim());
  let h=0;
  lines.forEach(line=>{
    const clean=line.replace(/^[-•]\s*/,'');
    const wrapped=doc.splitTextToSize(clean,w-6);
    h+=wrapped.length*(lh||4.6);
  });
  return h;
}
async function exportHonorarPDF(h,proj){
  const {jsPDF}=window.jspdf;const doc=new jsPDF();
  pdfHeaderLogo(doc);
  // Empfänger-Adresse
  doc.setTextColor(30);doc.setFontSize(10);let y=42;
  if(h.recipientName){doc.text(h.recipientName,PDF.ML,y);y+=5;}
  if(h.recipientStreet){doc.text(h.recipientStreet,PDF.ML,y);y+=5;}
  if(h.recipientPlace){doc.text(h.recipientPlace,PDF.ML,y);y+=5;}
  y+=13;
  // Ort, Datum + Referenz
  doc.setFontSize(9.5);doc.setTextColor(60);
  doc.text(`${h.place?h.place+', ':''}${fmtDate(h.date)}`,PDF.ML,y);y+=4;
  if(h.refNumber){doc.setFontSize(7.5);doc.setTextColor(140);doc.text(h.refNumber,PDF.ML,y);y+=4;}
  y+=9;
  // Titel – ruhig gehalten: dunkel, mit schmaler roter Akzentlinie (statt durchgehend rot)
  doc.setTextColor(26,26,26);doc.setFontSize(14);doc.setFont(undefined,'bold');
  doc.text('Honorarberechnung gemäss SIA 102',PDF.ML,y);
  doc.setDrawColor(168,57,42);doc.setLineWidth(0.6);doc.line(PDF.ML,y+2,PDF.ML+16,y+2);
  y+=7.5;
  doc.setFont(undefined,'normal');doc.setTextColor(70);doc.setFontSize(10);
  if(h.object){const ol=pdfTextHeight(doc,h.object,182,5.2);doc.text(ol.lines,PDF.ML,y);y+=ol.h;}
  doc.setFontSize(9);doc.setTextColor(120);
  if(h.offerNumber){doc.text('Offerten-Nr. '+h.offerNumber,PDF.ML,y);y+=8;}else y+=5;

  // Grundlage – dezente Überschrift (Kapitälchen-Stil), keine Farbe nötig
  if(h.basis&&h.basis.trim()){
    y=pdfEnsureSpace(doc,y,pdfBulletHeight(doc,h.basis,182)+10,()=>20);
    doc.setTextColor(26,26,26);doc.setFontSize(9.5);doc.setFont(undefined,'bold');doc.text('GRUNDLAGE',PDF.ML,y);doc.setFont(undefined,'normal');y+=5.5;
    doc.setTextColor(60);doc.setFontSize(9);
    y=pdfBulletBlock(doc,h.basis,PDF.ML,y,182);y+=7;
  }

  // Leistungsphasen – ruhige Tabellenoptik: dünne Trennlinie, Phasennummer klein in Rot,
  // Bezeichnung dunkel fett, Beschreibung gedeckt, Betrag rechtsbündig auf gleicher Höhe.
  doc.setDrawColor(210);doc.setLineWidth(0.3);doc.line(PDF.ML,y,PDF.MR,y);y+=7;
  let netWithoutZero=0, netAll=0, hasZero=false;
  h.phases.forEach(p=>{
    const amt=Number(p.amount)||0; netAll+=amt; if(p.num==='0')hasZero=true; else netWithoutZero+=amt;
    const descH=p.desc&&p.desc.trim()?pdfBulletHeight(doc,p.desc,168,4.4):0;
    const blockH=5.5+descH+6;
    y=pdfEnsureSpace(doc,y,blockH,()=>20);
    doc.setTextColor(168,57,42);doc.setFontSize(9.5);doc.setFont(undefined,'bold');
    doc.text(String(p.num||''),PDF.ML,y+3.6);
    doc.setTextColor(26,26,26);
    doc.text(String(p.name||''),PDF.ML+14,y+3.6);
    doc.setFont(undefined,'normal');doc.setTextColor(30);doc.setFontSize(9.5);
    doc.text(money(amt),PDF.MR,y+3.6,{align:'right'});
    let ty=y+8;
    if(descH){doc.setTextColor(110);doc.setFontSize(8.3);ty=pdfBulletBlock(doc,p.desc,PDF.ML+14,ty,168,4.4);}
    doc.setDrawColor(232,229,224);doc.setLineWidth(0.2);doc.line(PDF.ML,y+blockH-1,PDF.MR,y+blockH-1);
    y=y+blockH;
  });

  // Total – EIN klar dominanter Betrag, Details klein und gedeckt darunter
  y=pdfEnsureSpace(doc,y,32,()=>20);
  y+=2;doc.setDrawColor(26,26,26);doc.setLineWidth(0.4);doc.line(120,y,PDF.MR,y);y+=6;
  const pct=h.baseSum>0?(netWithoutZero/h.baseSum*100):null;
  doc.setTextColor(26,26,26);doc.setFontSize(11);doc.setFont(undefined,'bold');
  doc.text('Kosten, exkl. MwSt.',120,y);doc.text(money(netWithoutZero),PDF.MR,y,{align:'right'});doc.setFont(undefined,'normal');y+=5.5;
  doc.setTextColor(120);doc.setFontSize(8);
  if(pct!=null){doc.text(`entspricht Honorar von ${pct.toFixed(1)}% der Bausumme`,120,y,{align:'left'});y+=4.2;}
  if(hasZero){doc.text(`inkl. Machbarkeitsstudie: ${money(netAll)}`,120,y);y+=4.2;}
  const rate=Number(h.mwstRate)||0; let netAmt,mwstAmt,grossAmt;
  if(h.mwstMode==='inkl'){grossAmt=netAll;netAmt=netAll/(1+rate/100);mwstAmt=grossAmt-netAmt;}else{netAmt=netAll;mwstAmt=netAll*rate/100;grossAmt=netAmt+mwstAmt;}
  doc.text(`inkl. MwSt. (${rate}%): ${money(grossAmt)}`,120,y);y+=10;

  // In den Leistungen nicht inbegriffen
  if(h.notes&&h.notes.trim()){
    y=pdfEnsureSpace(doc,y,pdfBulletHeight(doc,h.notes,182,4.4)+10,()=>20);
    doc.setTextColor(26,26,26);doc.setFontSize(9.5);doc.setFont(undefined,'bold');
    doc.text('IN DEN LEISTUNGEN NICHT INBEGRIFFEN',PDF.ML,y);doc.setFont(undefined,'normal');y+=5.5;
    doc.setTextColor(110);doc.setFontSize(8.3);
    y=pdfBulletBlock(doc,h.notes,PDF.ML,y,182,4.4);y+=10;
  }

  // Unterschrift (digital, wie Abnahmeprotokoll)
  y=pdfEnsureSpace(doc,y,42,()=>20);
  doc.setTextColor(40);doc.setFontSize(9.5);
  doc.text('Freundliche Grüsse',PDF.ML,y);y+=5;
  doc.text(h.signerName||'',PDF.ML,y);y+=4;
  try{ if(h.signature) doc.addImage(h.signature,'PNG',PDF.ML-2,y,60,20); }catch(e){}
  y+=24;

  pdfFooterAllPages(doc);
  doc.save(`Honorarofferte_${(h.object||'').replace(/\s+/g,'_')||'Offerte'}.pdf`);
  toast('Honorarofferte-PDF erstellt',true);
}

/* ============================================================
   MODUL: BAUBESCHRIEB
   ------------------------------------------------------------
   Standard-Kapitel eines Baubeschriebs, frei bearbeit-/ergänzbar.
   Pflicht-Hinweise (Änderungsvorbehalt etc.) erscheinen im PDF
   automatisch auf der letzten Seite.
   ============================================================ */
const BAUBESCHRIEB_SECTIONS_DEFAULT=[
  {title:'Baugrube / Fundation', content:''},
  {title:'Rohbau / Konstruktion', content:''},
  {title:'Fassade', content:''},
  {title:'Dach / Bedachung', content:''},
  {title:'Fenster und Aussentüren', content:''},
  {title:'Bodenbeläge', content:''},
  {title:'Wandbeläge', content:''},
  {title:'Deckenverkleidungen / Malerarbeiten', content:''},
  {title:'Innentüren', content:''},
  {title:'Küche', content:''},
  {title:'Sanitäranlagen', content:''},
  {title:'Elektroinstallationen', content:''},
  {title:'Heizung / Lüftung', content:''},
  {title:'Storen / Sonnenschutz', content:''},
  {title:'Aussenanlagen / Garten', content:''}
];
// 10 marktübliche Formulierungen je Kapitel (aktueller Schweizer Wohnbau-Standard) –
// werden im Editor als Dropdown angeboten, damit man nicht bei Null anfangen muss.
const BAUBESCHRIEB_SUGGESTIONS={
  'baugrube':[
    'Fundation als Streifenfundament auf tragfähigem Baugrund gemäss Geotechnischem Bericht.',
    'Baugrubensicherung mittels Spundwand oder Bohrpfahlwand je nach Bodenverhältnissen.',
    'Fundationsplatte in wasserundurchlässigem Beton (Weisse Wanne) gemäss Norm SIA 262.',
    'Radonschutzmassnahmen gemäss kantonalen Vorgaben (Radonfolie unter Bodenplatte).',
    'Perimeterdämmung Untergeschoss mit XPS-Hartschaumplatten, druckfest.',
    'Baugrubenaushub inkl. Bodenuntersuchung und Entsorgung gemäss Altlastenverordnung.',
    'Drainageleitung rund um Fundament gemäss SIA 431 zur Ableitung von Sickerwasser.',
    'Fundation als Einzelfundamente mit Bodenplatte in Ortbeton, Betonqualität C25/30.',
    'Baugrubenabschluss mit Rüttelverdichtung und Frostschürze gemäss statischen Vorgaben.',
    'Unterkellerung vollflächig in Ortbeton, wasserdicht ausgeführt (Weisse-Wanne-Bauweise).'
  ],
  'rohbau':[
    'Tragkonstruktion in Ortbeton, Wände und Decken gemäss Statik-Berechnung.',
    'Aussenwände als zweischaliges Mauerwerk mit Kerndämmung, U-Wert gemäss MuKEn.',
    'Holzelementbau mit vorgefertigten Wand- und Deckenelementen (Holzrahmenbauweise).',
    'Innenwände tragend in Beton, nichttragende Trennwände in Kalksandstein oder Gips.',
    'Massivbauweise mit Backsteinmauerwerk und Betondecken, schallschutzoptimiert.',
    'Deckenkonstruktion als Betonhohldielen-Decke, statisch nach SIA 262 dimensioniert.',
    'Hybridbauweise: Untergeschoss in Beton, Aufbauten in Holzsystembau (Minergie-P-Eco).',
    'Treppenhaus und Liftschacht in Ortbeton als aussteifender Kern.',
    'Attikageschoss in Leichtbauweise (Metallständerkonstruktion) auf Massivbau.',
    'Tragkonstruktion Systembau (Beton-Fertigteile) mit Ortbetonergänzungen an Knotenpunkten.'
  ],
  'fassade':[
    'Kompaktfassade verputzt, mineralischer Edelputz, Farbton gemäss Farbkonzept Architekt.',
    'Hinterlüftete Fassade mit Faserzementplatten (z.B. Eternit) in verschiedenen Formaten.',
    'Holzfassade aus vorvergrauter Weisstanne oder Lärche, sägeroh oder gehobelt.',
    'Verblendmauerwerk aus Klinker, changierend, im Läuferverband gemauert.',
    'Metallfassade aus Aluminium-Verbundplatten, pulverbeschichtet, RAL nach Wahl.',
    'Putzfassade mit Wärmedämmverbundsystem (WDVS), Dämmstärke gemäss Energienachweis.',
    'Sichtbetonfassade, Schalungsbild glatt, mit Fugenplan gemäss Architekturplänen.',
    'Naturstein-Vorsatzschale (z.B. Tessiner Gneis) auf hinterlüfteter Unterkonstruktion.',
    'Fassadenbegrünung als Rankgerüst mit Kletterpflanzen im Erdgeschossbereich.',
    'Kombinierte Fassade: Sockelbereich Naturstein, Obergeschosse verputzt.'
  ],
  'dach':[
    'Flachdach als Warmdach mit Kiesschüttung, Abdichtung 2-lagig Bitumen.',
    'Steildach mit Tonziegeln (Doppelfalzziegel), Unterdach diffusionsoffen.',
    'Extensiv begrüntes Flachdach mit Sedum-Bepflanzung, Retention für Regenwasser.',
    'Photovoltaikanlage indachintegriert, netzgekoppelt, Leistung gemäss Energiekonzept.',
    'Attikadach mit Terrassennutzung, Belag auf Stelzlager, Abdichtung wurzelfest.',
    'Blechdach mit Stehfalz-Eindeckung (Titanzink oder Aluminium), Neigung gemäss Plan.',
    'Steildach mit Solarziegeln vollintegriert (z.B. System Solrif oder Ergosun).',
    'Kaltdach mit Faserzement-Wellplatten, hinterlüftet, für Ökonomiegebäude/Anbauten.',
    'Attika-Abschluss mit Blechverkleidung, Wärmedämmung gemäss Minergie-Standard.',
    'Flachdach als Umkehrdach mit Foamglas-Dämmung, druckfest, für Terrassennutzung.'
  ],
  'fenster':[
    'Kunststoff-Fenster, 3-fach verglast, Uw-Wert ≤ 0.9 W/m²K, weiss oder farbig.',
    'Holz-Metall-Fenster mit Aluminium-Aussenschale, wartungsarm, 3-fach-Isolierverglasung.',
    'Kunststoff-Aluminium-Fenster, Farbton aussen nach RAL, innen weiss.',
    'Holzfenster aus Fichte oder Eiche, lasiert oder deckend gestrichen.',
    'Hebeschiebetür aus Aluminium für Terrassenzugang, schwellenlos, einbruchhemmend.',
    'Fenster mit integriertem Sonnen- und Sichtschutz (Raffstore in Blendrahmen integriert).',
    'Haustüre Aluminium wärmegedämmt, mit elektronischem Schliesssystem (Fingerprint/Code).',
    'Fenster Passivhaus-zertifiziert, Uw-Wert ≤ 0.8 W/m²K, für Minergie-P-Bauten.',
    'Fenstersimse aussen in Aluminium-Blech, innen in Naturstein oder Kunststein.',
    'Kellerfenster Kunststoff mit Lichtschacht, teilweise als Fluchtwegfenster ausgebildet.'
  ],
  'bodenbeläge':[
    'Feinsteinzeug-Platten grossformatig (z.B. 60x60cm oder 30x60cm), Feuchträume rutschfest R10.',
    'Eichenparkett Landhausdiele, geölt oder lackiert, in Wohn- und Schlafbereichen.',
    'Vinylboden (Designboden) in Klick- oder Klebeausführung, Holz- oder Steinoptik.',
    'Anhydrit- oder Zementunterlagsboden, schwimmend verlegt, mit Fussbodenheizung.',
    'Naturstein-Bodenbelag (z.B. Jura-Kalkstein) im Eingangsbereich und auf Terrassen.',
    'Teppichboden Schlinge oder Velours in Schlafzimmern, Aufbauhöhe nach Norm.',
    'Sichtbeton geschliffen und versiegelt als Bodenbelag in Loft-/Industriestil-Wohnungen.',
    'Feinsteinzeug in Holzoptik (Fliese) für pflegeleichte, robuste Wohnräume.',
    'Betonwerkstein-Platten für Balkone und Terrassen, frostsicher verlegt.',
    'Kork-Parkett als ökologische, trittschalldämmende Bodenbelagsvariante.'
  ],
  'wandbeläge':[
    'Wände gestrichen mit Dispersionsfarbe, weiss, 2-lagiger Anstrich auf Grundputz.',
    'Feuchtraum: Wandfliesen Feinsteinzeug im Duschbereich, restliche Wände gestrichen.',
    'Tapeten (Vlies- oder Strukturtapete) in ausgewählten Wohnräumen nach Bauherrenwunsch.',
    'Sichtbacksteinwände (Verblendsteine) als gestalterisches Element im Wohnbereich.',
    'Holzverkleidung (z.B. Eiche oder Fichte) als Akzentwand im Wohn- oder Schlafbereich.',
    'Betonwände sichtbar belassen, geschliffen und mit Lasur behandelt (Loft-Charakter).',
    'Kalkputz (Streichputz) für ökologisches, diffusionsoffenes Wohnklima.',
    'Rückwand Küche in Glas (Rückwandpaneel) hinter Kochbereich, farblich abgestimmt.',
    'Wandfliesen im Duschbereich bodentief, restliche Nasszelle wasserfester Anstrich.',
    'Akustikpaneele an Decke/Wand in stark genutzten Räumen zur Schallreduktion.'
  ],
  'decken':[
    'Decken gestrichen mit Dispersionsfarbe weiss, Untergrund gespachtelt und geschliffen.',
    'Abgehängte Gipskartondecke mit integrierter LED-Beleuchtung, im Feuchtraum feuchtraumresistent.',
    'Akustikdecke (perforierte Gipskartonplatten) in Wohn-/Arbeitsräumen zur Schallreduktion.',
    'Deckenverkleidung Holz (Fichte/Tanne) im Dachgeschoss, sichtbare Balkenlage.',
    'Rohbeton-Sichtdecke geschliffen, ohne zusätzliche Verkleidung (Industrial-Stil).',
    'Spanndecke (z.B. Barrisol) als moderne, wartungsarme Deckenlösung mit Beleuchtung.',
    'Malerarbeiten Innentüren und Zargen lackiert, Farbton weiss RAL 9010.',
    'Deckenuntersicht Balkone/Vordächer verputzt und gestrichen, wetterfest.',
    'Gipsdecke mit Vouten/Abschattungsfugen als gestalterisches Element im Wohnbereich.',
    'Rauhfasertapete gestrichen als robuste, kostengünstige Deckenvariante.'
  ],
  'innentüren':[
    'Innentüren als weissfarbige Türblätter, glatt, mit verdeckten Bändern (CPL-Oberfläche).',
    'Zimmertüren furniert (Eiche oder Nussbaum), mit Edelstahl-Drückergarnitur.',
    'Schiebetüren in Wandtaschen integriert für platzsparende Raumaufteilung.',
    'Glastüren (ESG-Sicherheitsglas) für lichtdurchflutete Raumübergänge.',
    'Zargen aus Metall (Stahlzargen) für erhöhte Robustheit, RAL-Farbton nach Wahl.',
    'Brandschutztüren EI30 zu Technik-/Kellerräumen gemäss Brandschutzkonzept.',
    'Innentüren akustisch gedämmt (Schallschutztüren) zu Schlaf-/Arbeitsräumen.',
    'Schrankraum-/Ankleide-Türen als Systemschranklösung mit Spiegelfront.',
    'Wohnungseingangstüre mit erhöhtem Einbruchschutz (RC2) und Mehrfachverriegelung.',
    'Falttüren/Raumteiler für flexible Grundrissgestaltung in offenen Wohnbereichen.'
  ],
  'küche':[
    'Küchenkombination nach Bauherrenwahl (z.B. Marken SchmidtLine, Piatti oder V-ZUG Kitchen).',
    'Kochapparate Einbaugeräte V-ZUG oder Miele (Glaskeramik- oder Induktionskochfeld).',
    'Küchenabdeckung Naturstein (Granit) oder Kunststein (Silestone/Dekton).',
    'Kühl-/Gefrierkombination und Geschirrspüler als Einbaugeräte, energieeffizient (A+++).',
    'Kücheninsel mit integriertem Sitzbereich und Dunstabzug (Kopffreihaube oder Tischlüftung).',
    'Fronten Küche Melamin oder Lack matt, Griffe grifflos (Push-to-open) oder Massivholz.',
    'Wasserhahn Küche mit Boiler oder Durchlauferhitzer, Ausführung Chrom oder Edelstahl.',
    'Vorratsraum/Speisekammer angrenzend an Küche mit Regalsystem.',
    'Küchenrückwand in Glas oder Feinsteinzeug, farblich auf Fronten abgestimmt.',
    'Reduzierte Küchenzeile (Kochnische) für kompakte Wohnungen/Studios.'
  ],
  'sanitär':[
    'Sanitärapparate Keramik weiss (z.B. Marken Laufen, Geberit, Similor), Standardausführung.',
    'Duschabtrennung Glas (ESG), bodenebene Dusche mit Punkt- oder Linienentwässerung.',
    'WC wandhängend mit Geberit-Spülkasten (UP-Spülkasten), Betätigungsplatte Sigma.',
    'Badewanne freistehend (Acryl oder Mineralguss) im Hauptbad.',
    'Armaturen Chrom (z.B. Similor, Hansgrohe), Einhebelmischer für Lavabo und Dusche.',
    'Waschtischunterschrank mit Doppelwaschtisch im Hauptbad, Spiegelschrank beleuchtet.',
    'Warmwasseraufbereitung zentral über Wärmepumpe/Boiler, dezentral wo erforderlich.',
    'Gäste-WC mit reduzierter Ausstattung (Lavabo, WC), platzsparend.',
    'Waschmaschinen-/Tumbleranschluss im Bad oder separatem Waschraum.',
    'Fussbodenheizung in Nasszellen, zusätzlich Handtuchheizkörper im Hauptbad.'
  ],
  'elektro':[
    'Elektroinstallation gemäss NIN (Niederspannungs-Installationsnorm) und lokalem EW.',
    'Steckdosen und Schalter Serie Feller Edizio due oder gleichwertig, weiss oder farbig.',
    'LED-Beleuchtung durchgehend, dimmbar, in Wohn- und Nasszellen wassergeschützt (IP44).',
    'Smart-Home-Vorinstallation (KNX oder vergleichbar) für Storen, Licht, Heizung.',
    'Photovoltaikanlage mit Eigenverbrauchsoptimierung und Batteriespeicher (Option).',
    'Ladestation Elektrofahrzeug (Wallbox) in Einstellhalle/Garage vorbereitet oder installiert.',
    'Multimediaverkabelung (CAT7/Glasfaser) in allen Hauptwohnräumen vorbereitet.',
    'Video-Sprechanlage mit Kamera am Hauseingang, Monitor in der Wohnung.',
    'Elektrische Schliessanlage/Zutrittskontrolle für Haupteingang und Tiefgarage.',
    'Notbeleuchtung und Rauchmelder gemäss Brandschutzvorschriften (VKF) in allen Geschossen.'
  ],
  'heizung':[
    'Wärmepumpe Luft/Wasser als Hauptwärmeerzeuger, Aussenaufstellung schallgedämmt.',
    'Erdsonden-Wärmepumpe (Sole/Wasser) mit Erdwärmesonden, für Minergie-Bauten.',
    'Fussbodenheizung in allen Wohnräumen, raumweise regelbar (Einzelraumregelung).',
    'Komfortlüftung mit Wärmerückgewinnung (Minergie-Anforderung), Zu-/Abluft zentral.',
    'Fernwärmeanschluss ans lokale Wärmenetz, Übergabestation im Technikraum.',
    'Radiatorenheizung als Ergänzung zur Fussbodenheizung in Bad/Ankleide (Handtuchwärmer).',
    'Holzpellet-Heizung mit Pelletlager, alternativ Stückholz-Kombikessel.',
    'Gas-Brennwertheizung als Übergangslösung (falls Fernwärme/Wärmepumpe nicht möglich).',
    'Klimatisierung/Kühlung über die Fussbodenheizung im Sommerbetrieb (passive Kühlung).',
    'Cheminée/Kachelofen als Zusatzheizung im Wohnbereich (raumluftunabhängig).'
  ],
  'storen':[
    'Raffstoren elektrisch (Lamellenstoren) aussen, Aluminium, mit Windwächter.',
    'Senkrechtmarkise für Balkon-/Terrassenbereich, textiler Behang, elektrisch bedienbar.',
    'Rollläden Kunststoff oder Aluminium, elektrisch mit Zeitschaltung/Automatik.',
    'Aussenmarkise (Gelenkarmmarkise) für Terrasse, mit Sonnen-/Windsensor.',
    'Sonnenschutzverglasung (Sonnenschutzglas) zusätzlich zu Raffstoren an Südfassade.',
    'Innenliegender Blend-/Sichtschutz (Plissee oder Vorhang) in Schlafräumen.',
    'Fixe Beschattung durch Vordach/Auskragung an Südfassade (baulicher Sonnenschutz).',
    'Insektenschutzgitter an allen öffenbaren Fenstern und Terrassentüren.',
    'Zentral steuerbare Storensteuerung (Smart-Home-Integration), astronomische Schaltuhr.',
    'Faltstore/Raffstore im Wintergarten-/Verglasungsbereich zum Hitzeschutz.'
  ],
  'aussenanlagen':[
    'Umgebungsarbeiten gemäss Umgebungsplan Landschaftsarchitekt, Rasenflächen und Bepflanzung.',
    'Gartensitzplatz/Terrasse mit Plattenbelag (Beton- oder Naturstein), frostsicher verlegt.',
    'Einfriedung als Zaun (Holz oder Metall) oder Hecke gemäss kommunalen Vorschriften.',
    'Zufahrt/Vorplatz befestigt mit Pflastersteinen oder wassergebundener Decke.',
    'Aussenbeleuchtung Garten/Weg mit LED-Leuchten, teils bewegungsgesteuert.',
    'Regenwasserversickerung über Sickerschacht/Mulde gemäss kantonalen Vorgaben.',
    'Veloabstellplätze überdacht gemäss kommunalem Reglement (Anzahl nach Wohnungsmix).',
    'Spielplatz/Spielrasen für Mehrfamilienhäuser gemäss kommunalen Auflagen.',
    'Bepflanzung mit einheimischen, standortgerechten Sträuchern und Bäumen.',
    'Briefkastenanlage und Aussenmöblierung (Sitzbänke) im Eingangsbereich.'
  ]
};
// Findet die passenden Textvorschläge zu einem (auch frei umbenannten) Kapiteltitel via Schlagwort-Suche.
function _bbSuggestionsFor(title){
  const t=(title||'').toLowerCase();
  const map=[
    ['baugrube',['baugrube','fundament','fundation']],
    ['rohbau',['rohbau','konstruktion','tragwerk']],
    ['fassade',['fassade']],
    ['dach',['dach','bedachung']],
    ['fenster',['fenster','aussentür']],
    ['bodenbeläge',['boden']],
    ['wandbeläge',['wandbelag','wandbeläge']],
    ['decken',['decke','malerarbeit']],
    ['innentüren',['innentür','zimmertür']],
    ['küche',['küche']],
    ['sanitär',['sanitär','bad','dusche','wc']],
    ['elektro',['elektro','strom']],
    ['heizung',['heizung','lüftung','klima']],
    ['storen',['store','sonnenschutz','markise','rollladen','rollläden']],
    ['aussenanlagen',['aussenanlage','garten','umgebung']]
  ];
  for(const [key,words] of map){ if(words.some(w=>t.includes(w))) return BAUBESCHRIEB_SUGGESTIONS[key]; }
  return null;
}
const BAUBESCHRIEB_NOTES_DEFAULT=[
  'Änderungen aus bautechnischen, gestalterischen oder gesetzlichen Gründen bleiben vorbehalten.',
  'Material- und Farbmuster können bei Naturprodukten (Holz, Stein, etc.) geringfügig von der Originalausführung abweichen.',
  'Verbindlich sind die genehmigten Baupläne und der Werkvertrag; bei Widersprüchen zum Baubeschrieb gelten die Pläne.',
  'Mehrpreise für Sonderwünsche und Änderungen ausserhalb dieses Baubeschriebs werden separat vereinbart.',
  'Bei Nichtverfügbarkeit genannter Produkte/Marken werden gleichwertige Produkte verwendet.',
  'Angaben zu Mengen, Massen und Ausstattungen sind approximativ und können projektbedingt variieren.'
].map(l=>'- '+l).join('\n');
function _baubeschriebNew(){
  return {id:uid(),projectId:state.projectId,
    object:'',bauherr:'',address:'',date:todayISO(),
    sections:JSON.parse(JSON.stringify(BAUBESCHRIEB_SECTIONS_DEFAULT)).map(s=>({...s,id:uid()})),
    notes:BAUBESCHRIEB_NOTES_DEFAULT,
    createdAt:nowISO()};
}
async function renderBaubeschrieb(){
  const stage=document.getElementById('stage');
  const list=(await byProject('baubeschriebe')).sort((a,b)=>b.date.localeCompare(a.date));
  stage.innerHTML=`
    <div class="module">
      <div class="mod-head"><div><h1>Baubeschrieb</h1><div class="sub">Kapitel frei bearbeit- und ergänzbar · Hinweise auf der letzten Seite</div></div>
        <div class="spacer"></div><button class="btn btn-primary btn-sm" id="newBbBtn">＋ Neuer Baubeschrieb</button></div>
      <div class="mod-body">
        ${list.length?list.map(bb=>`<div class="card" style="cursor:pointer;margin-bottom:12px;max-width:100%" data-id="${bb.id}">
          <button class="card-del" data-del="${bb.id}" title="Baubeschrieb löschen">×</button>
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-right:30px"><b style="font-size:15px">${esc(bb.object||'Ohne Bezeichnung')}</b><span style="margin-left:auto;font-size:12px;color:var(--muted)">${fmtDate(bb.date)}</span></div>
          <div style="margin-top:6px;font-size:13px;color:var(--muted)">${esc(bb.bauherr||'—')}</div>
          <div style="margin-top:8px;font-size:12px;color:var(--muted)">${(bb.sections||[]).filter(s=>s.content&&s.content.trim()).length} von ${(bb.sections||[]).length} Kapiteln ausgefüllt</div>
        </div>`).join(''):`<div class="empty"><div class="big">📖</div><h3>Kein Baubeschrieb</h3><p>Erstelle einen Baubeschrieb mit den üblichen Kapiteln – Rohbau, Fassade, Böden, Küche, Sanitär, Elektro und mehr.</p></div>`}
      </div>
    </div>`;
  document.getElementById('newBbBtn').onclick=()=>openBaubeschriebEditor();
  document.querySelectorAll('.card[data-id]').forEach(c=>c.onclick=async e=>{if(e.target.closest('.card-del'))return;openBaubeschriebEditor(await get('baubeschriebe',c.dataset.id));});
  document.querySelectorAll('.card-del[data-del]').forEach(b=>b.onclick=async e=>{e.stopPropagation();const bb=await get('baubeschriebe',b.dataset.del);await confirmDelete('baubeschriebe',b.dataset.del,bb?bb.object:'Baubeschrieb',renderBaubeschrieb);});
}
async function openBaubeschriebEditor(bb){
  const isNew=!bb;
  bb=bb?JSON.parse(JSON.stringify(bb)):_baubeschriebNew();
  const draftKeyId=isNew?'new':bb.id; // Neu-Anlagen bekommen jedes Mal eine neue id – Entwurf daher unter fixem "new"-Schlüssel
  const proj=await get('projects',state.projectId);
  if(isNew&&!bb.object)bb.object=proj.name||'';
  if(isNew&&!bb.bauherr)bb.bauherr=proj.client||'';
  if(isNew&&!bb.address)bb.address=proj.address||'';
  // Nicht gespeicherten Entwurf wiederherstellen, falls das Fenster zuvor unerwartet geschlossen wurde
  const draft=_draftLoad('bb',draftKeyId);
  let restoredDraft=false;
  if(draft){ bb=draft; restoredDraft=true; }
  modal(`<div class="modal-head"><h3>${isNew?'Neuer Baubeschrieb':esc(bb.object)}</h3><p>${restoredDraft?'<b style="color:var(--brand-red)">Nicht gespeicherter Entwurf wiederhergestellt.</b> ':''}Übliche Kapitel eines Baubeschriebs – ausfüllen, ergänzen oder entfernen.</p></div>
    <div class="modal-body">
      <div class="field-row"><div class="field"><label>Bauvorhaben / Objekt</label><input id="bb-object" value="${esc(bb.object)}"></div>
        <div class="field" style="max-width:160px"><label>Datum</label><input type="date" id="bb-date" value="${bb.date}"></div></div>
      <div class="field-row"><div class="field"><label>Bauherrschaft</label><input id="bb-bauherr" value="${esc(bb.bauherr)}"></div>
        <div class="field"><label>Adresse / Parzelle</label><input id="bb-address" value="${esc(bb.address)}"></div></div>

      <div class="field" style="border-top:1px solid var(--line);padding-top:12px;margin-top:6px">
        <label>Titelbild <span style="font-weight:400;color:var(--muted);font-size:12px">(optional – erscheint oben auf der ersten PDF-Seite; ohne Bild bleibt der Platz einfach weg)</span></label>
        <div id="bbTitleImgBox" style="margin-top:6px"></div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-steel btn-sm" id="bbImgAddBtn" type="button">📷 Titelbild wählen</button>
          <button class="btn btn-ghost btn-sm" id="bbImgRmBtn" type="button" style="display:none">Entfernen</button>
        </div>
      </div>

      <div class="field" style="border-top:1px solid var(--line);padding-top:12px;margin-top:6px">
        <label>Kapitel</label>
        <div id="bbSections" style="display:flex;flex-direction:column;gap:10px"></div>
        <button class="btn btn-ghost btn-sm" id="addSectionBtn" type="button" style="margin-top:8px">＋ Kapitel</button>
      </div>

      <div class="field" style="margin-top:14px"><label>Hinweise <span style="font-weight:400;color:var(--muted);font-size:12px">(erscheinen im PDF auf der letzten Seite – je Zeile ein Punkt)</span></label>
        <textarea id="bb-notes" style="min-height:110px">${esc(bb.notes||'')}</textarea></div>
    </div>
    <div class="modal-foot">
      ${isNew?'':'<button class="btn btn-danger" id="bbDel">Löschen</button>'}
      <button class="btn btn-ghost" id="bbCancel">Abbrechen</button>
      <button class="btn btn-steel" id="bbPdf">⬇ Als PDF</button>
      <button class="btn btn-primary" id="bbSave">Speichern</button>
    </div>`,{wide:true});

  function collect(){
    const objEl=document.getElementById('bb-object');
    if(!objEl)return bb; // Fenster wurde bereits geschlossen – nichts mehr zu sammeln
    bb.object=objEl.value.trim();
    bb.date=document.getElementById('bb-date').value;
    bb.bauherr=document.getElementById('bb-bauherr').value.trim();
    bb.address=document.getElementById('bb-address').value.trim();
    bb.notes=document.getElementById('bb-notes').value;
    return bb;
  }
  // Laufende Entwurfs-Sicherung: jede Eingabe im Fenster wird (leicht verzögert) zwischengespeichert,
  // damit bei einem unerwarteten Schliessen nichts verloren geht. "Speichern" bleibt zusätzlich bestehen.
  const saveDraftDebounced=_debounce(()=>{ collect(); _draftSave('bb',draftKeyId,bb); },500);
  document.querySelector('.modal-body').addEventListener('input',saveDraftDebounced);

  function drawTitleImg(){
    const box=document.getElementById('bbTitleImgBox');
    const rm=document.getElementById('bbImgRmBtn');
    if(bb.titleImage){
      box.innerHTML=`<img src="${bb.titleImage}" style="max-width:280px;max-height:160px;border-radius:8px;border:1px solid var(--line);display:block">`;
      rm.style.display='';
    }else{
      box.innerHTML=`<div style="font-size:12px;color:var(--muted)">Kein Titelbild gewählt.</div>`;
      rm.style.display='none';
    }
    saveDraftDebounced();
  }
  drawTitleImg();
  document.getElementById('bbImgAddBtn').onclick=()=>openPhotoSource(async(b64)=>{ bb.titleImage=b64; drawTitleImg(); });
  document.getElementById('bbImgRmBtn').onclick=()=>{ bb.titleImage=null; drawTitleImg(); };

  function drawSections(){
    document.getElementById('bbSections').innerHTML=bb.sections.map((s,i)=>{
      const sugg=_bbSuggestionsFor(s.title);
      return `
      <div style="border:1px solid var(--line-2);border-radius:8px;padding:10px;background:var(--paper-2)">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
          <input data-k="title" data-i="${i}" value="${esc(s.title)}" placeholder="Kapitelname" style="flex:1;border:none;background:transparent;font-weight:700">
          <button class="row-del" data-rmsec="${i}" type="button" title="Kapitel entfernen">×</button>
        </div>
        <textarea data-k="content" data-i="${i}" placeholder="Beschreibung / Ausführung…" style="width:100%;min-height:56px;border:1px solid var(--line);border-radius:6px;padding:7px;background:var(--paper);font-size:12.5px">${esc(s.content||'')}</textarea>
        ${sugg?`<select data-suggest="${i}" style="margin-top:6px;font-size:12px;max-width:100%">
          <option value="">💡 Marktüblichen Vorschlag einfügen…</option>
          ${sugg.map((txt,si)=>`<option value="${si}">${esc(txt.length>90?txt.slice(0,90)+'…':txt)}</option>`).join('')}
        </select>`:''}
      </div>`;
    }).join('');
    document.querySelectorAll('#bbSections [data-k="title"]').forEach(inp=>{
      inp.oninput=()=>{bb.sections[+inp.dataset.i].title=inp.value;saveDraftDebounced();};
      inp.onblur=()=>drawSections(); // Vorschlagsliste erst NACH dem Tippen aktualisieren (sonst springt der Fokus raus)
    });
    document.querySelectorAll('#bbSections [data-k="content"]').forEach(inp=>inp.oninput=()=>{bb.sections[+inp.dataset.i].content=inp.value;saveDraftDebounced();});
    document.querySelectorAll('[data-rmsec]').forEach(b=>b.onclick=()=>{bb.sections.splice(+b.dataset.rmsec,1);drawSections();saveDraftDebounced();});
    document.querySelectorAll('[data-suggest]').forEach(sel=>sel.onchange=()=>{
      const i=+sel.dataset.suggest; if(sel.value==='')return;
      const sugg=_bbSuggestionsFor(bb.sections[i].title);
      const txt=sugg[+sel.value];
      const cur=bb.sections[i].content;
      bb.sections[i].content = cur&&cur.trim() ? cur.replace(/\n+$/,'')+'\n'+txt : txt;
      drawSections();saveDraftDebounced();
    });
  }
  drawSections();
  document.getElementById('addSectionBtn').onclick=()=>{bb.sections.push({id:uid(),title:'Neues Kapitel',content:''});drawSections();saveDraftDebounced();};

  document.getElementById('bbSave').onclick=async()=>{saveDraftDebounced.cancel();collect();await put('baubeschriebe',bb);_draftClear('bb',draftKeyId);closeModal();toast('Baubeschrieb gespeichert',true);renderBaubeschrieb();};
  document.getElementById('bbPdf').onclick=()=>{collect();saveDraftDebounced();exportBaubeschriebPDF(bb,proj);};
  document.getElementById('bbCancel').onclick=()=>{ saveDraftDebounced.cancel(); _draftClear('bb',draftKeyId); closeModal(); };
  if(!isNew)document.getElementById('bbDel').onclick=async()=>{const ok=await confirmDelete('baubeschriebe',bb.id,bb.object||'Baubeschrieb',renderBaubeschrieb);if(ok){saveDraftDebounced.cancel();_draftClear('bb',draftKeyId);closeModal();}};
}
async function exportBaubeschriebPDF(bb,proj){
  const {jsPDF}=window.jspdf;const doc=new jsPDF();
  let y=pdfDocHead(doc,'Baubeschrieb',[
    {l:proj.name,proj:true},
    {l:'Bauvorhaben: '+(bb.object||'—')},
    {l:'Bauherrschaft: '+(bb.bauherr||'—')},
    {l:'Adresse: '+(bb.address||'—')},
    {l:'Datum: '+fmtDate(bb.date)}
  ]);
  // Titelbild – nur wenn hochgeladen, sonst bleibt der Platz einfach weg (kein Platzhalter)
  if(bb.titleImage){
    try{
      const props=doc.getImageProperties(bb.titleImage);
      const maxW=182, maxH=90;
      let w=maxW,h=maxW*props.height/props.width;
      if(h>maxH){h=maxH;w=maxH*props.width/props.height;}
      y=pdfEnsureSpace(doc,y,h+6,()=>20);
      doc.addImage(bb.titleImage,PDF.ML,y,w,h);
      doc.setDrawColor(220);doc.setLineWidth(0.2);doc.rect(PDF.ML,y,w,h);
      y+=h+8;
    }catch(e){ console.warn('[Baubeschrieb] Titelbild konnte nicht eingefügt werden:',e.message); }
  }
  (bb.sections||[]).forEach(s=>{
    if(!s.title&&!s.content)return;
    const titleH=6;
    const contentBlock=s.content?pdfTextHeight(doc,s.content,182,4.8):null;
    const blockH=titleH+(contentBlock?contentBlock.h+2:4)+5;
    y=pdfEnsureSpace(doc,y,blockH,()=>20);
    doc.setTextColor(168,57,42);doc.setFontSize(11);doc.setFont(undefined,'bold');
    doc.text(s.title||'(ohne Titel)',PDF.ML,y+4);doc.setFont(undefined,'normal');
    let ty=y+9;
    if(contentBlock){doc.setTextColor(50);doc.setFontSize(9.5);doc.text(contentBlock.lines,PDF.ML,ty);ty+=contentBlock.h;}
    else{doc.setTextColor(160);doc.setFontSize(9);doc.text('(keine Angaben)',PDF.ML,ty);ty+=4;}
    doc.setDrawColor(232,227,219);doc.setLineWidth(0.2);doc.line(PDF.ML,y+blockH-1.5,PDF.MR,y+blockH-1.5);
    y=y+blockH;
  });
  // Hinweise IMMER auf einer neuen, letzten Seite
  if(bb.notes&&bb.notes.trim()){
    doc.addPage();
    let ny=pdfDocHead(doc,'Hinweise zum Baubeschrieb',[{l:proj.name,proj:true},{l:bb.object||''}]);
    doc.setTextColor(40);doc.setFontSize(9.5);
    ny=pdfBulletBlock(doc,bb.notes,PDF.ML,ny,182,5.2);
  }
  pdfFooterAllPages(doc);
  doc.save(`Baubeschrieb_${(bb.object||'').replace(/\s+/g,'_')||'Objekt'}.pdf`);
  toast('Baubeschrieb-PDF erstellt',true);
}

/* ============================================================
   MODULE: BILDERGALERIE
   ============================================================ */
async function renderGallery(){
  const stage=document.getElementById('stage');
  const defs=await byProject('defects');
  const notes=await byProject('notes');
  const protos=await byProject('protocols');
  const imgs=[];
  defs.forEach(d=>(d.photos||[]).forEach(p=>imgs.push({src:p,ref:`Mangel #${String(d.num).padStart(3,'0')}`})));
  notes.forEach(n=>(n.photos||[]).forEach(p=>imgs.push({src:p,ref:`Notiz: ${n.title||''}`})));
  protos.forEach(pr=>(pr.items||[]).forEach(it=>(it.photos||[]).forEach(p=>imgs.push({src:p,ref:`Protokoll: ${pr.title||''}`}))));
  stage.innerHTML=`
    <div class="module">
      <div class="mod-head"><div><h1>Bildergalerie</h1><div class="sub">${imgs.length} Bilder aus Mängeln, Notizen & Protokollen</div></div></div>
      <div class="mod-body">
        ${imgs.length?`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">
          ${imgs.map(im=>`<div style="position:relative;cursor:pointer" class="galimg"><img src="${im.src}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;border:1px solid var(--line)"><div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,.7));color:#fff;font-size:11px;padding:6px 8px;border-radius:0 0 8px 8px">${esc(im.ref)}</div></div>`).join('')}</div>`
        :`<div class="empty"><div class="big">🖼</div><h3>Keine Bilder</h3><p>Füge Fotos zu Mängeln, Notizen oder Protokollen hinzu – sie erscheinen automatisch hier.</p></div>`}
      </div>
    </div>`;
  document.querySelectorAll('.galimg').forEach((el,i)=>el.onclick=()=>window.open(imgs[i].src,'_blank'));
}

/* ============================================================
   MODULE: STATISTIK
   ============================================================ */
async function renderStats(){
  const stage=document.getElementById('stage');
  const defs=await byProject('defects');
  const open=defs.filter(d=>d.status==='Offen').length, work=defs.filter(d=>d.status==='In Arbeit').length, done=defs.filter(d=>d.status==='Erledigt').length;
  const overdue=defs.filter(d=>d.status!=='Erledigt'&&d.due&&d.due<todayISO()).length;
  const byTrade={};defs.forEach(d=>{const t=d.trade||'Ohne Gewerk';byTrade[t]=(byTrade[t]||0)+1;});
  const byAssignee={};defs.forEach(d=>{if(d.status!=='Erledigt'){const a=d.assignee||'Nicht zugewiesen';byAssignee[a]=(byAssignee[a]||0)+1;}});
  const pct=defs.length?Math.round(done/defs.length*100):0;
  stage.innerHTML=`
    <div class="module">
      <div class="mod-head"><div><h1>Statistik</h1><div class="sub">Auswertung Mängel & Fortschritt</div></div></div>
      <div class="mod-body">
        <div class="stat-grid">
          <div class="stat-card"><div class="num" style="color:var(--open)">${open}</div><div class="lbl">Offen</div></div>
          <div class="stat-card"><div class="num" style="color:var(--warn)">${work}</div><div class="lbl">In Arbeit</div></div>
          <div class="stat-card"><div class="num" style="color:var(--ok)">${done}</div><div class="lbl">Erledigt</div></div>
          <div class="stat-card"><div class="num" style="color:#b3261e">${overdue}</div><div class="lbl">Überfällig</div></div>
          <div class="stat-card"><div class="num">${pct}%</div><div class="lbl">Erledigungsgrad</div><div class="bar"><i style="width:${pct}%;background:var(--ok)"></i></div></div>
        </div>
        <h3 style="font-size:14px;margin:8px 0 12px">Mängel nach Gewerk</h3>
        ${Object.keys(byTrade).length?Object.entries(byTrade).sort((a,b)=>b[1]-a[1]).map(([t,n])=>{const w=Math.round(n/defs.length*100);return `<div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px"><span>${esc(t)}</span><b>${n}</b></div><div class="bar"><i style="width:${w}%;background:var(--steel)"></i></div></div>`;}).join(''):'<p style="color:var(--muted);font-size:13px">Keine Daten</p>'}
        <h3 style="font-size:14px;margin:22px 0 12px">Offene Mängel pro Unternehmer</h3>
        ${Object.keys(byAssignee).length?Object.entries(byAssignee).sort((a,b)=>b[1]-a[1]).map(([a,n])=>`<div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--paper-2);border:1px solid var(--line-2);border-radius:8px;margin-bottom:6px;font-size:13.5px"><span>${esc(a)}</span><b>${n}</b></div>`).join(''):'<p style="color:var(--muted);font-size:13px">Keine offenen Mängel</p>'}
      </div>
    </div>`;
}

/* ============================================================
   MODULE: DASHBOARD
   ============================================================ */
async function renderDashboard(){
  const stage=document.getElementById('stage');
  const proj=await get('projects',state.projectId);
  if(!proj){
    stage.innerHTML=`<div class="module"><div class="mod-body">
      <div class="empty" style="margin-top:60px">
        <div class="big">🏗</div>
        <h3>Willkommen bei BauView</h3>
        <p>Es ist noch kein Projekt vorhanden. Eröffne dein erstes Bauprojekt, um Pläne hochzuladen, Mängel zu erfassen und Protokolle zu erstellen.</p>
        <button class="btn btn-primary" id="welcomeNewProj" style="margin-top:18px">＋ Erstes Projekt eröffnen</button>
      </div></div></div>`;
    document.getElementById('welcomeNewProj').onclick=()=>openProjectEditor();
    return;
  }
  const defs=await byProject('defects');const plans=await byProject('plans');
  const open=defs.filter(d=>d.status!=='Erledigt').length;
  const overdue=defs.filter(d=>d.status!=='Erledigt'&&d.due&&d.due<todayISO()).length;
  const recent=defs.slice().sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).slice(0,5);
  stage.innerHTML=`
    <div class="module">
      <div class="mod-head"><div><h1>${esc(proj.name)}</h1><div class="sub">${esc(proj.client||'')} ${proj.client&&proj.address?'· ':''}${esc(proj.address||'')}</div></div><div class="spacer"></div><button class="btn btn-ghost btn-sm" id="editProjBtn">⚙ Projekt bearbeiten</button></div>
      <div class="mod-body">
        <div class="stat-grid">
          <div class="stat-card" data-go="defects" style="cursor:pointer"><div class="num" style="color:var(--signal)">${open}</div><div class="lbl">Offene Mängel</div></div>
          <div class="stat-card" data-go="defects" style="cursor:pointer"><div class="num" style="color:#b3261e">${overdue}</div><div class="lbl">Überfällig</div></div>
          <div class="stat-card" data-go="plans" style="cursor:pointer"><div class="num">${plans.length}</div><div class="lbl">Pläne</div></div>
          <div class="stat-card" data-go="contacts" style="cursor:pointer"><div class="num">${(await byProject('contacts')).length}</div><div class="lbl">Kontakte</div></div>
        </div>
        <h3 style="font-size:14px;margin:8px 0 12px">Schnellzugriff</h3>
        <div class="cards" style="margin-bottom:24px">
          <div class="card" data-go="plans"><h4>📐 Mangel erfassen</h4><div class="meta">Marker direkt im Plan setzen</div></div>
          <div class="card" data-go="defects"><h4>✉ Mängelliste versenden</h4><div class="meta">Automatische Mails pro Unternehmer</div></div>
          <div class="card" data-go="protocols"><h4>📋 Protokoll erstellen</h4><div class="meta">Mängel als Pendenzen übernehmen</div></div>
          <div class="card" data-go="acceptance"><h4>✓ Abnahme SIA 118</h4><div class="meta">Mit Mängelübertrag & Unterschrift</div></div>
        </div>
        <h3 style="font-size:14px;margin:8px 0 12px">Zuletzt erfasste Mängel</h3>
        ${recent.length?`<table class="tbl"><tbody>${recent.map(d=>`<tr class="click" data-def="${d.id}"><td style="width:60px"><b>#${String(d.num).padStart(3,'0')}</b></td><td>${esc(d.title||'—')}</td><td>${esc(d.assignee||'—')}</td><td style="text-align:right"><span class="status-tag status-${statusKey(d.status)}">${d.status}</span></td></tr>`).join('')}</tbody></table>`:'<p style="color:var(--muted);font-size:13px">Noch keine Mängel erfasst.</p>'}
      </div>
    </div>`;
  document.querySelectorAll('[data-go]').forEach(el=>el.onclick=()=>navigate(el.dataset.go));
  document.querySelectorAll('[data-def]').forEach(el=>el.onclick=()=>jumpToDefect(el.dataset.def));
  document.getElementById('editProjBtn').onclick=async()=>openProjectEditor(await get('projects',state.projectId));
}

/* ============================================================
   BENUTZERVERWALTUNG  (anmelden / erstellen / Rollen)
   ============================================================ */
const ROLES=['Noch nicht zugewiesen','Bauleitung','Architekt/in','Projektleitung','Zeichner/in','Bauherr','Unternehmer','Praktikant/in','Sekretariat'];
// Frei definierbare Rollen + Rechte (im Admin-Bereich verwaltet, in 'app'-Store gespeichert)
let CUSTOM_ROLES=null;
async function loadRoles(){
  try{ const r=await get('app','roleConfig'); CUSTOM_ROLES = r&&Array.isArray(r.roles) ? r.roles : null; }catch(e){ CUSTOM_ROLES=null; }
  return CUSTOM_ROLES;
}
function allRoleNames(){
  if(CUSTOM_ROLES&&CUSTOM_ROLES.length) return ['Noch nicht zugewiesen',...CUSTOM_ROLES.filter(r=>r.name&&r.name!=='Noch nicht zugewiesen').map(r=>r.name)];
  return ROLES;
}
function initials(name){
  const parts=(name||'').trim().split(/\s+/).filter(Boolean);
  if(!parts.length)return '?';
  if(parts.length===1)return parts[0].slice(0,2).toUpperCase();
  return (parts[0][0]+parts[parts.length-1][0]).toUpperCase();
}
async function getAppVal(key){const v=await get('app',key);return v?v.value:null;}
async function setAppVal(key,value){await put('app',{id:key,value});}

async function loadCurrentUser(){
  const users=await all('users');
  // Wenn per Cloud angemeldet: Benutzer automatisch anhand der Konto-E-Mail wählen/anlegen
  if(typeof CURRENT_AUTH!=='undefined' && CURRENT_AUTH && CURRENT_AUTH.email){
    const mail=CURRENT_AUTH.email.toLowerCase();
    let u=users.find(x=>(x.email||'').toLowerCase()===mail) || users.find(x=>x.id===CURRENT_AUTH.id);
    if(!u){
      // Kein passender Benutzer vorhanden → automatisch aus dem Konto anlegen
      u={id:CURRENT_AUTH.id||uid(), name:(CURRENT_AUTH.email.split('@')[0]||'Benutzer'), role:'Bauleitung', email:mail, authId:CURRENT_AUTH.id, createdAt:nowISO()};
      await put('users',u);
    }
    setCurrentUser(u);
    return;
  }
  if(!users.length){CURRENT_USER={name:'',initials:'?',email:'',role:'',id:null};return;}
  const savedId=await getAppVal('currentUserId');
  let u=users.find(x=>x.id===savedId)||users[0];
  setCurrentUser(u);
}
function setCurrentUser(u){
  CURRENT_USER={id:u.id,name:u.name,initials:initials(u.name),email:u.email||'',role:u.role||'',avatar:u.avatar||null};
  setAppVal('currentUserId',u.id);
  renderUserChip();
}
function renderUserChip(){
  const av=document.getElementById('userAvatar'), nm=document.getElementById('userName'), rl=document.getElementById('userRole');
  if(CURRENT_USER&&CURRENT_USER.name){
    if(CURRENT_USER.avatar){av.innerHTML=`<img src="${CURRENT_USER.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;av.style.padding='0';av.style.overflow='hidden';}
    else{av.textContent=CURRENT_USER.initials;av.style.padding='';}
    nm.textContent=CURRENT_USER.name;rl.textContent=CURRENT_USER.role||'';
  }else{
    av.textContent='?';nm.textContent='Anmelden';rl.textContent='kein Benutzer';
  }
}
document.getElementById('userChip').onclick=openUserMenu;
async function openUserMenu(){
  const ex=document.getElementById('userMenuPop');if(ex){ex.remove();return;}
  const cloudOn = typeof cloudEnabled==='function' && cloudEnabled() && CURRENT_AUTH;
  const isAdmin = cloudOn && typeof cloudIsAdmin==='function' && cloudIsAdmin(CURRENT_AUTH.email);
  const users=(await all('users')).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  const pop=document.createElement('div');pop.className='user-menu';pop.id='userMenuPop';

  if(cloudOn){
    // CLOUD-MODUS: kein Wechseln. Eigenes Konto oben, Team nur zur Ansicht.
    pop.innerHTML=`
      <div class="um-head">Angemeldet als</div>
      <div class="um-item active" style="cursor:default">
        <div class="av">${initials(CURRENT_USER.name)}</div>
        <div class="um-meta"><div class="nm">${esc(CURRENT_USER.name)}</div><div class="rl">${esc(CURRENT_USER.role||'—')} · ${esc(CURRENT_AUTH.email||'')}</div></div>
        <button class="um-edit" id="umEditSelf" title="Eigenes Profil bearbeiten" style="color:var(--muted);font-size:15px;padding:4px">✎</button>
      </div>
      ${users.length>1?`<div class="um-head" style="margin-top:4px">Team (${users.length})</div>
        <div style="max-height:180px;overflow:auto">${users.filter(u=>u.id!==CURRENT_USER.id).map(u=>`
        <div class="um-item" style="cursor:default;opacity:.85">
          <div class="av" style="background:var(--steel-light);color:var(--steel)">${initials(u.name)}</div>
          <div class="um-meta"><div class="nm">${esc(u.name)}</div><div class="rl">${esc(u.role||'—')}</div></div>
        </div>`).join('')}</div>`:''}
      ${isAdmin?'<div class="um-foot"><button class="btn btn-steel" id="umAdmin" style="width:100%;font-size:12.5px">🛡 Admin-Bereich</button></div>':''}
      <div class="um-foot" style="padding-top:0"><button class="btn btn-ghost" id="umSettings" style="width:100%;font-size:12.5px">⚙ Einstellungen</button></div>
      <div class="um-foot" style="padding-top:0"><button class="btn btn-ghost" id="umLogout" style="width:100%;font-size:12.5px">🔒 Abmelden</button></div>`;
    document.body.appendChild(pop);
    setTimeout(()=>{document.addEventListener('click',closeUserMenuOnOutside);},10);
    const es=document.getElementById('umEditSelf');
    if(es)es.onclick=async e=>{e.stopPropagation();pop.remove();document.removeEventListener('click',closeUserMenuOnOutside);openUserEditor(await get('users',CURRENT_USER.id));};
  }else{
    // LOKAL-MODUS: wie bisher, Wechseln erlaubt
    pop.innerHTML=`
      <div class="um-head">Benutzer wählen</div>
      ${users.length?users.map(u=>`
        <div class="um-item ${u.id===CURRENT_USER.id?'active':''}" data-uid="${u.id}">
          <div class="av">${initials(u.name)}</div>
          <div class="um-meta"><div class="nm">${esc(u.name)}</div><div class="rl">${esc(u.role||'—')}</div></div>
          <button class="um-edit" data-edit="${u.id}" title="Bearbeiten" style="color:var(--muted);font-size:15px;padding:4px">✎</button>
        </div>`).join(''):'<div style="padding:16px;font-size:13px;color:var(--muted)">Noch kein Benutzer angelegt.</div>'}
      <div class="um-foot"><button class="btn btn-primary" id="umNew">＋ Benutzer erstellen</button></div>`;
    document.body.appendChild(pop);
    setTimeout(()=>{document.addEventListener('click',closeUserMenuOnOutside);},10);
    pop.querySelectorAll('.um-item').forEach(el=>el.onclick=async e=>{
      if(e.target.classList.contains('um-edit'))return;
      const u=await get('users',el.dataset.uid);setCurrentUser(u);pop.remove();document.removeEventListener('click',closeUserMenuOnOutside);
      toast('Angemeldet als '+u.name,true);
    });
    pop.querySelectorAll('.um-edit').forEach(b=>b.onclick=async e=>{e.stopPropagation();pop.remove();document.removeEventListener('click',closeUserMenuOnOutside);openUserEditor(await get('users',b.dataset.edit));});
    const nb=document.getElementById('umNew');if(nb)nb.onclick=()=>{pop.remove();document.removeEventListener('click',closeUserMenuOnOutside);openUserEditor();};
  }
  const ab=document.getElementById('umAdmin');
  if(ab)ab.onclick=()=>{pop.remove();document.removeEventListener('click',closeUserMenuOnOutside);openAdminPanel();};
  const stg=document.getElementById('umSettings');
  if(stg)stg.onclick=()=>{pop.remove();document.removeEventListener('click',closeUserMenuOnOutside);openUserSettings();};
  const lo=document.getElementById('umLogout');
  if(lo)lo.onclick=async()=>{
    pop.remove();document.removeEventListener('click',closeUserMenuOnOutside);
    if(!confirm('Abmelden? Die App lädt danach neu.'))return;
    try{ await cloudSignOut(); }catch(e){}
    location.reload();
  };
}
function closeUserMenuOnOutside(e){
  const pop=document.getElementById('userMenuPop');
  if(pop && !pop.contains(e.target) && !document.getElementById('userChip').contains(e.target)){pop.remove();document.removeEventListener('click',closeUserMenuOnOutside);}
}

/* ---------- ADMIN-BEREICH: alle Konten einsehen + Rollen steuern ---------- */
async function openAdminPanel(){
  if(!(typeof cloudIsAdmin==='function'&&CURRENT_AUTH&&cloudIsAdmin(CURRENT_AUTH.email))){toast('Nur für Admin');return;}
  modal(`<div class="modal-head"><h3>🛡 Admin-Bereich</h3></div>
    <div style="display:flex;gap:6px;padding:0 18px;border-bottom:1px solid var(--line)">
      <button class="admtab active" data-tab="accounts" style="background:none;border:none;border-bottom:2px solid var(--brand-red);padding:9px 12px;font-weight:600;font-size:13px;cursor:pointer">Konten</button>
      <button class="admtab" data-tab="roles" style="background:none;border:none;border-bottom:2px solid transparent;padding:9px 12px;font-weight:600;font-size:13px;color:var(--muted);cursor:pointer">Rollen & Rechte</button>
    </div>
    <div class="modal-body" id="adminBody"><div style="padding:20px;color:var(--muted)">Wird geladen…</div></div>
    <div class="modal-foot"><button class="btn btn-ghost" id="adminReload" style="margin-right:auto">↻ Aktualisieren</button><button class="btn btn-ghost" onclick="closeModal()">Schließen</button></div>`,{wide:true});
  const tabs=document.querySelectorAll('.admtab');
  tabs.forEach(t=>t.onclick=()=>{
    tabs.forEach(x=>{x.classList.remove('active');x.style.borderBottomColor='transparent';x.style.color='var(--muted)';});
    t.classList.add('active');t.style.borderBottomColor='var(--brand-red)';t.style.color='';
    if(t.dataset.tab==='accounts')_loadAdminAccounts();else _loadRoleRights();
  });
  const reload=document.getElementById('adminReload');if(reload)reload.onclick=()=>{const active=document.querySelector('.admtab.active');if(active&&active.dataset.tab==='roles')_loadRoleRights();else _loadAdminAccounts();};
  await _loadAdminAccounts();
}
// ---- Rollen & Rechte verwalten (app-seitig: steuert Modul-Sichtbarkeit) ----
async function _loadRoleRights(){
  const body=document.getElementById('adminBody');if(!body)return;
  await loadRoles();
  // Aktuelle Rollen (entweder Custom oder Standard als Startpunkt)
  let roles = (CUSTOM_ROLES&&CUSTOM_ROLES.length) ? JSON.parse(JSON.stringify(CUSTOM_ROLES)) :
    ROLES.filter(r=>r!=='Noch nicht zugewiesen').map(r=>({name:r,perms:{}}));
  // Module, deren Sichtbarkeit gesteuert werden kann
  const mods=MODULES.map(m=>({id:m.id,label:m.label.replace(/\n/g,' ')}));
  const render=()=>{
    body.innerHTML=`
      <div style="font-size:12.5px;color:var(--muted);margin-bottom:10px">Lege fest, welche Rolle welche Bereiche sieht. Ein Häkchen = sichtbar. „Noch nicht zugewiesen" sieht nur das Dashboard. <b>Hinweis:</b> Diese Steuerung betrifft die Menü-Sichtbarkeit (app-seitig).</div>
      <div style="overflow-x:auto"><table class="tbl" style="font-size:12px"><thead><tr><th style="position:sticky;left:0;background:var(--paper-2)">Modul</th>
        ${roles.map((r,i)=>`<th style="text-align:center;min-width:70px"><input data-rolename="${i}" value="${esc(r.name)}" style="width:74px;font-size:11px;padding:3px 4px;border:1px solid var(--line);border-radius:5px;text-align:center"><br><button class="row-del" data-delrole="${i}" title="Rolle löschen" style="margin-top:3px">×</button></th>`).join('')}
        <th style="min-width:40px"></th></tr></thead>
        <tbody>${mods.map(m=>`<tr><td style="position:sticky;left:0;background:var(--paper-2);font-weight:600">${esc(m.label)}</td>
          ${roles.map((r,i)=>`<td style="text-align:center"><input type="checkbox" data-perm="${i}|${m.id}" ${r.perms&&r.perms[m.id]!==false?'checked':''}></td>`).join('')}
          <td></td></tr>`).join('')}</tbody></table></div>
      <div style="display:flex;gap:8px;margin-top:12px"><input id="newRoleName" placeholder="Neue Rolle (z.B. Subunternehmer)" style="flex:1"><button class="btn btn-steel btn-sm" id="addRoleBtn" type="button">＋ Rolle</button></div>
      <div style="margin-top:14px;display:flex;justify-content:flex-end"><button class="btn btn-primary" id="saveRolesBtn">Rollen & Rechte speichern</button></div>`;
    // Events
    body.querySelectorAll('[data-rolename]').forEach(inp=>inp.onchange=()=>{roles[+inp.dataset.rolename].name=inp.value.trim();});
    body.querySelectorAll('[data-perm]').forEach(cb=>cb.onchange=()=>{const [i,mid]=cb.dataset.perm.split('|');if(!roles[+i].perms)roles[+i].perms={};roles[+i].perms[mid]=cb.checked;});
    body.querySelectorAll('[data-delrole]').forEach(b=>b.onclick=()=>{if(confirm('Rolle entfernen?')){roles.splice(+b.dataset.delrole,1);render();}});
    document.getElementById('addRoleBtn').onclick=()=>{const n=document.getElementById('newRoleName').value.trim();if(!n)return;if(roles.some(r=>r.name===n)){toast('Rolle existiert');return;}roles.push({name:n,perms:{}});render();};
    document.getElementById('saveRolesBtn').onclick=async()=>{
      roles=roles.filter(r=>r.name);
      await put('app',{id:'roleConfig',roles});
      CUSTOM_ROLES=roles;
      toast('Rollen & Rechte gespeichert',true);
      await renderRail();
    };
  };
  render();
}
// Prüft, ob die aktuelle Benutzerrolle ein Modul sehen darf (app-seitig)
function roleCanSee(moduleId){
  if(moduleId==='dashboard')return true;
  const role=CURRENT_USER&&CURRENT_USER.role;
  if(!role||role==='Noch nicht zugewiesen')return moduleId==='dashboard';
  if(typeof cloudIsAdmin==='function'&&CURRENT_AUTH&&cloudIsAdmin(CURRENT_AUTH.email))return true;
  if(!CUSTOM_ROLES||!CUSTOM_ROLES.length)return true;
  const rc=CUSTOM_ROLES.find(r=>r.name===role);
  if(!rc||!rc.perms)return true;
  return rc.perms[moduleId]!==false;
}

/* ---------- Einstellungen (eigenes Konto) ---------- */
async function openUserSettings(){
  const u=await get('users',CURRENT_USER.id) || {id:CURRENT_USER.id,name:CURRENT_USER.name,role:CURRENT_USER.role,email:(CURRENT_AUTH&&CURRENT_AUTH.email)||''};
  const cloudOn=typeof cloudEnabled==='function'&&cloudEnabled();
  modal(`<div class="modal-head"><h3>⚙ Einstellungen</h3><p>Dein Konto und Profil.</p></div>
    <div class="modal-body">
      <div style="display:flex;gap:16px;align-items:center;margin-bottom:16px">
        <div id="avatarBox" style="width:72px;height:72px;border-radius:50%;background:var(--steel-light);display:grid;place-items:center;overflow:hidden;border:2px solid var(--line)">
          ${u.avatar?`<img src="${u.avatar}" style="width:100%;height:100%;object-fit:cover">`:`<span style="font-size:26px;font-weight:700;color:var(--steel)">${initials(u.name)}</span>`}
        </div>
        <div><button class="btn btn-steel btn-sm" id="avatarBtn" type="button">📷 Profilbild ${u.avatar?'ändern':'hinzufügen'}</button>
        ${u.avatar?'<br><button class="btn btn-ghost btn-sm" id="avatarDel" type="button" style="margin-top:6px;font-size:12px">Entfernen</button>':''}
        <input type="file" id="avatarFile" accept="image/*" style="display:none"></div>
      </div>
      <div class="field"><label>Name</label><input id="set-name" value="${esc(u.name||'')}"></div>
      <div class="field"><label>Rolle</label><input value="${esc(u.role||'Noch nicht zugewiesen')}" disabled style="background:var(--paper-2);color:var(--muted)"><div style="font-size:11.5px;color:var(--muted);margin-top:4px">Die Rolle wird vom Administrator vergeben.</div></div>
      ${cloudOn?`
      <div style="border-top:1px solid var(--line);margin:14px 0 6px;padding-top:12px;font-weight:700;font-size:13px">Anmeldedaten</div>
      <div class="field"><label>E-Mail</label><input id="set-email" value="${esc((CURRENT_AUTH&&CURRENT_AUTH.email)||u.email||'')}" type="email"><div style="font-size:11.5px;color:var(--muted);margin-top:4px">Beim Ändern senden wir eine Bestätigung an die neue Adresse.</div></div>
      <div class="field-row">
        <div class="field"><label>Neues Passwort</label><input id="set-pass" type="password" placeholder="leer lassen = unverändert"></div>
        <div class="field"><label>Wiederholen</label><input id="set-pass2" type="password"></div>
      </div>`:''}
      <div id="set-msg" style="font-size:12.5px;margin-top:8px"></div>
    </div>
    <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button><button class="btn btn-primary" id="set-save">Speichern</button></div>`,{wide:true});

  let newAvatar=u.avatar||null, avatarChanged=false;
  const msg=(t,ok)=>{const e=document.getElementById('set-msg');e.textContent=t;e.style.color=ok?'#1d6b3f':'#b3261e';};
  document.getElementById('avatarBtn').onclick=()=>document.getElementById('avatarFile').click();
  const adel=document.getElementById('avatarDel');if(adel)adel.onclick=()=>{newAvatar=null;avatarChanged=true;document.getElementById('avatarBox').innerHTML=`<span style="font-size:26px;font-weight:700;color:var(--steel)">${initials(u.name)}</span>`;};
  document.getElementById('avatarFile').onchange=async e=>{
    const f=e.target.files[0];if(!f)return;
    // verkleinern auf max 256px, als JPEG
    const dataUrl=await _resizeImage(f,256);
    newAvatar=dataUrl;avatarChanged=true;
    document.getElementById('avatarBox').innerHTML=`<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover">`;
  };
  document.getElementById('set-save').onclick=async()=>{
    msg('',true);
    u.name=document.getElementById('set-name').value.trim()||u.name;
    // Profilbild
    if(avatarChanged){
      let stored=newAvatar;
      if(newAvatar && cloudOn && typeof cloudUploadImage==='function'){
        try{ stored=await cloudUploadImage('avatars',newAvatar,'av_'); }catch(e){}
      }
      u.avatar=stored||null;
    }
    await put('users',u);
    setCurrentUser(u);renderUserChip();
    // Passwort / E-Mail
    if(cloudOn){
      const np=document.getElementById('set-pass').value, np2=document.getElementById('set-pass2').value;
      if(np||np2){
        if(np!==np2){msg('Die Passwörter stimmen nicht überein.');return;}
        if(np.length<6){msg('Das Passwort muss mindestens 6 Zeichen haben.');return;}
        try{ await cloudUpdatePassword(np); }catch(e){msg('Passwort: '+(e.message||'Fehler'));return;}
      }
      const newEmail=document.getElementById('set-email').value.trim().toLowerCase();
      if(newEmail && CURRENT_AUTH && newEmail!==(CURRENT_AUTH.email||'').toLowerCase()){
        try{ await cloudUpdateEmail(newEmail); msg('Gespeichert. Bitte bestätige die neue E-Mail über den zugesandten Link.',true); }
        catch(e){msg('E-Mail: '+(e.message||'Fehler'));return;}
        setTimeout(closeModal,2500);return;
      }
    }
    toast('Einstellungen gespeichert',true);closeModal();
  };
}
// Bild verkleinern → dataURL (JPEG)
function _resizeImage(file,maxPx){
  return new Promise((resolve,reject)=>{
    const r=new FileReader();
    r.onload=()=>{const img=new Image();img.onload=()=>{
      let{width:w,height:h}=img;const sc=Math.min(1,maxPx/Math.max(w,h));w=Math.round(w*sc);h=Math.round(h*sc);
      const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);
      resolve(c.toDataURL('image/jpeg',0.85));
    };img.onerror=reject;img.src=r.result;};
    r.onerror=reject;r.readAsDataURL(file);
  });
}
async function _loadAdminAccounts(){
  const body=document.getElementById('adminBody');
  if(!body)return;
  // Quelle 1: Konten-Register (Cloud)
  let accounts=[];
  try{ accounts=await cloudListAccounts(); }catch(e){}
  // Quelle 2: BauView-Benutzerprofile
  let users=[];
  try{ users=await all('users'); }catch(e){}
  await loadRoles();
  // Nach E-MAIL zusammenführen (eine E-Mail = ein Konto) → verhindert Duplikate
  const byEmail={}; const noEmail=[];
  const addEntry=(id,email,name,role,status)=>{
    email=(email||'').toLowerCase();
    if(!email){ noEmail.push({id,email:'',name:name||'',role:role||'',status:status||'aktiv',dupIds:[id]}); return; }
    if(byEmail[email]){
      const e=byEmail[email];
      if(name&&!e.name)e.name=name;
      if(role&&(!e.role||e.role==='Noch nicht zugewiesen'))e.role=role;
      if(status==='gesperrt')e.status='gesperrt';
      if(!e.dupIds.includes(id))e.dupIds.push(id);
      if(id.length>e.id.length)e.id=id; // auth-id (länger) bevorzugen
    }else{
      byEmail[email]={id,email,name:name||'',role:role||'',status:status||'aktiv',dupIds:[id]};
    }
  };
  accounts.forEach(a=>addEntry(a.id,a.email,a.name,a.role,a.status));
  users.forEach(u=>addEntry(u.authId||u.id,u.email,u.name,u.role,'aktiv'));
  let list=[...Object.values(byEmail),...noEmail];
  if(!list.length){ body.innerHTML='<div style="padding:20px;color:var(--muted)">Noch keine Konten sichtbar.<br><br>Konten erscheinen, sobald sich Personen mindestens einmal angemeldet haben. Falls trotzdem nichts erscheint: bitte die neueste SUPABASE-SETUP.sql ausführen.</div>'; return; }
  list.sort((a,b)=>(a.name||a.email||'').localeCompare(b.name||b.email||''));
  const roleOpts=allRoleNames();
  const dupCount=list.filter(a=>a.dupIds.length>1).length;
  body.innerHTML=`${dupCount?`<div style="background:#fff7e6;border:1px solid #f0d9a0;border-radius:8px;padding:9px 12px;font-size:12.5px;margin-bottom:10px">⚠ ${dupCount} Konto(s) waren doppelt und wurden hier zusammengeführt. „💾 Speichern" bereinigt die Duplikate endgültig.</div>`:''}
    <table class="tbl"><thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(a=>`<tr data-aid="${a.id}">
      <td><input data-name="${a.id}" value="${esc(a.name||'')}" placeholder="Name" style="width:130px;padding:5px 7px;border:1px solid var(--line);border-radius:6px;background:var(--paper)">${cloudIsAdmin(a.email)?' <span class="pill">Admin</span>':''}${a.dupIds.length>1?' <span class="pill" style="background:#f0d9a0;color:#7a5a00">2×</span>':''}</td>
      <td style="font-size:12px;color:var(--muted)">${esc(a.email||'—')}</td>
      <td><select data-role="${a.id}" style="padding:5px 8px;border:1px solid var(--line);border-radius:7px">${roleOpts.map(r=>`<option ${a.role===r?'selected':''}>${r}</option>`).join('')}</select></td>
      <td><select data-status="${a.id}" style="padding:5px 8px;border:1px solid var(--line);border-radius:7px"><option ${a.status!=='gesperrt'?'selected':''}>aktiv</option><option ${a.status==='gesperrt'?'selected':''}>gesperrt</option></select></td>
      <td style="text-align:right;white-space:nowrap"><button class="btn btn-ghost btn-sm" data-save="${a.id}" title="Speichern">💾</button> <button class="row-del" data-delacc="${a.id}" title="Konto entfernen">×</button></td>
    </tr>`).join('')}</tbody></table>
    <p style="font-size:11.5px;color:var(--muted);margin-top:12px">„💾" speichert Name, Rolle, Status und bereinigt Duplikate. „×" entfernt das Konto. Das Login in Supabase bleibt bestehen (endgültig nur im Supabase-Portal → Authentication → Users).</p>`;
  const find=id=>list.find(x=>x.id===id);
  body.querySelectorAll('[data-save]').forEach(btn=>btn.onclick=async()=>{
    const id=btn.dataset.save;const acc=find(id);if(!acc)return;
    acc.name=body.querySelector(`[data-name="${id}"]`).value.trim();
    acc.role=body.querySelector(`[data-role="${id}"]`).value;
    acc.status=body.querySelector(`[data-status="${id}"]`).value;
    for(const did of acc.dupIds){ if(did!==acc.id){ try{await cloudDeleteAccount(did);}catch(e){} try{await del('users',did);}catch(e){} } }
    try{ await cloudUpdateAccount({id:acc.id,email:acc.email,name:acc.name,role:acc.role,status:acc.status,createdAt:nowISO()}); }catch(e){}
    const lu=await get('users',acc.id);if(lu){lu.name=acc.name;lu.role=acc.role;await put('users',lu);}
    toast('Konto gespeichert',true);
    await _loadAdminAccounts();
  });
  body.querySelectorAll('[data-delacc]').forEach(btn=>btn.onclick=async()=>{
    const id=btn.dataset.delacc;const acc=find(id);if(!acc)return;
    if(cloudIsAdmin(acc.email) && acc.dupIds.length<=1){toast('Das aktive Admin-Konto kann nicht entfernt werden');return;}
    if(!confirm(`Konto „${acc.name||acc.email}" entfernen? Die Person verliert den App-Zugang.`))return;
    for(const did of acc.dupIds){ try{ await cloudDeleteAccount(did); }catch(e){} try{ await del('users',did); }catch(e){} }
    toast('Konto entfernt');
    await _loadAdminAccounts();
  });
}
async function openUserEditor(existing){
  const isNew=!existing;
  const u=existing||{id:uid(),name:'',email:'',phone:'',role:'Bauleitung'};
  modal(`<div class="modal-head"><h3>${isNew?'Benutzer erstellen':'Benutzer bearbeiten'}</h3>
      <p>${isNew?'Lege ein Benutzerprofil an. Der Name erscheint in Protokollen, im Verlauf und in E-Mails.':''}</p></div>
    <div class="modal-body">
      <div class="field"><label>Name *</label><input id="u-name" value="${esc(u.name)}" placeholder="z.B. Markus Helbling"></div>
      <div class="field"><label>Rolle</label><select id="u-role">${ROLES.map(r=>`<option ${u.role===r?'selected':''}>${r}</option>`).join('')}</select></div>
      <div class="field-row">
        <div class="field"><label>E-Mail</label><input id="u-email" value="${esc(u.email)}" placeholder="name@helbling-architektur.ch"></div>
        <div class="field"><label>Telefon</label><input id="u-phone" value="${esc(u.phone||'')}" placeholder="071 …"></div>
      </div>
    </div>
    <div class="modal-foot">
      ${isNew?'':'<button class="btn btn-danger" id="uDel">Löschen</button>'}
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" id="uSave">${isNew?'Erstellen & anmelden':'Speichern'}</button>
    </div>`);
  document.getElementById('uSave').onclick=async()=>{
    const name=document.getElementById('u-name').value.trim();
    if(!name){toast('Bitte einen Namen eingeben');document.getElementById('u-name').focus();return;}
    u.name=name;u.role=document.getElementById('u-role').value;
    u.email=document.getElementById('u-email').value.trim();u.phone=document.getElementById('u-phone').value.trim();
    await put('users',u);
    setCurrentUser(u); // neu erstellter/bearbeiteter Benutzer wird aktiv
    closeModal();toast(isNew?'Benutzer erstellt':'Benutzer gespeichert',true);
  };
  if(!isNew)document.getElementById('uDel').onclick=async()=>{
    const users=await all('users');
    if(users.length<=1){toast('Der letzte Benutzer kann nicht gelöscht werden');return;}
    if(!confirm('Benutzer „'+u.name+'" löschen?'))return;
    await del('users',u.id);
    if(CURRENT_USER.id===u.id){const rest=(await all('users'))[0];setCurrentUser(rest);}
    closeModal();toast('Benutzer gelöscht');
  };
  setTimeout(()=>document.getElementById('u-name')?.focus(),50);
}

/* ============================================================
   INIT
   ============================================================ */
if('serviceWorker' in navigator && location.protocol.startsWith('http')){window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));}
(async function init(){
  if(await tryRenderPublicShare())return; // login-freie Unternehmer-Ansicht per ?share=... – App-Start überspringen
  const bl=document.getElementById('brandLogo');if(bl&&typeof BRAND!=='undefined')bl.src=BRAND.bauviewLogo;
  await openDB();
  let cloudOn=false;
  if(typeof cloudInit==='function'){ try{ cloudOn=await cloudInit(); }catch(e){ console.warn('Cloud-Init:',e.message); } }
  if(cloudOn){
    const sessionUser = await cloudCurrentUser();
    if(!sessionUser){
      renderSyncPill('local');
      showLoginScreen();
      return;
    }
    await afterLogin(sessionUser);
    return;
  }
  renderSyncPill('local');
  await startApp();
})();

// Nach erfolgreicher Anmeldung: Sync, Live-Sync starten, App starten
async function afterLogin(sessionUser){
  renderSyncPill('syncing');
  CURRENT_AUTH = sessionUser||null;
  try{
    await cloudSyncUp();    // vorhandene lokale Daten zuerst hochladen
    await cloudSyncDown();  // dann Cloud-Daten herunterladen (zusammenführen)
    await cloudFlushQueue();
  }catch(e){ console.warn('Sync:',e.message); }
  // Konto-Register bei JEDEM Login sicherstellen (damit Admin alle Konten sieht)
  try{
    if(CURRENT_AUTH && typeof cloudRegisterAccount==='function'){
      // vorhandenen BauView-Benutzer (Name/Rolle) verwenden, falls da
      const u=(await all('users')).find(x=>(x.email||'').toLowerCase()===(CURRENT_AUTH.email||'').toLowerCase()) || (await get('users',CURRENT_AUTH.id));
      await cloudRegisterAccount(CURRENT_AUTH.id, CURRENT_AUTH.email, u?u.name:'', u?u.role:'');
    }
  }catch(e){}
  if(typeof cloudSubscribeRealtime==='function'){
    cloudSubscribeRealtime(table=>{ _onRemoteChange(table); });
  }
  renderSyncPill(_lastCloudError?'error':'synced');
  await startApp();
}
// Wird bei Live-Änderung aus der Cloud aufgerufen
let _remoteTimer=null;
function _onRemoteChange(table){
  renderSyncPill('synced');
  // sanftes, gebündeltes Neu-Zeichnen (max. alle 400ms) → spart Rechenzeit
  clearTimeout(_remoteTimer);
  _remoteTimer=setTimeout(async()=>{
    try{
      await renderProjectSelect();
      const m=MODULES.find(x=>x.id===state.module);
      if(m && state.module!=='plans'){ await navigate(state.module); }
    }catch(e){}
  },400);
}

async function startApp(){
  await seedIfEmpty();
  if(typeof loadRoles==='function')await loadRoles();
  await loadCurrentUser();renderUserChip();
  const users=await all('users');
  await renderProjectSelect();
  await renderRail();await navigate('dashboard');updateNet();
  if(!users.length){setTimeout(()=>openUserEditor(),400);}
  window.removeEventListener('resize',_resizeHandler);
  window.addEventListener('resize',_resizeHandler);
}
function _resizeHandler(){ if(state.module==='plans'&&state.planId)renderPage(); }

/* ---------- Anmeldebildschirm ---------- */
function showLoginScreen(mode){
  mode=mode||'login';
  const ov=document.createElement('div');
  ov.id='loginOverlay';
  ov.innerHTML=`
    <div class="login-card">
      <img class="login-logo" ${typeof BRAND!=='undefined'?`src="${BRAND.bauviewLogo}"`:''} alt="BauView">
      <h2 id="loginTitle">BauView</h2>
      <p class="login-sub" id="loginSub"></p>
      <div id="signupFields" style="display:none">
        <div class="login-field"><label>Name</label><input id="suName" placeholder="Vor- und Nachname"></div>
        <div style="font-size:12px;color:var(--muted);margin:-4px 0 10px;text-align:left">Deine Rolle und Berechtigungen werden vom Administrator zugewiesen.</div>
      </div>
      <div class="login-field"><label>E-Mail</label><input id="loginEmail" type="email" autocomplete="username" placeholder="name@helbling-architektur.ch"></div>
      <div class="login-field"><label>Passwort</label><input id="loginPass" type="password" autocomplete="current-password" placeholder="••••••••"></div>
      <div id="loginError" class="login-error"></div>
      <div id="loginInfo" class="login-info"></div>
      <button class="btn btn-primary" id="primaryBtn" style="width:100%;margin-top:6px"></button>
      <button class="btn btn-ghost" id="switchBtn" style="width:100%;margin-top:8px"></button>
      <button class="btn btn-ghost" id="forgotBtn" style="width:100%;margin-top:6px;font-size:12px;color:var(--muted)">Passwort vergessen?</button>
      <button class="btn btn-ghost" id="localBtn" style="width:100%;margin-top:10px;font-size:12px;color:var(--muted)">Ohne Anmeldung nur lokal arbeiten</button>
    </div>`;
  document.body.appendChild(ov);
  const $=id=>document.getElementById(id);
  const showErr=msg=>{const e=$('loginError');e.textContent=msg;e.style.display=msg?'block':'none';};
  const showInfo=msg=>{const e=$('loginInfo');e.textContent=msg;e.style.display=msg?'block':'none';};
  const setBusy=b=>{$('primaryBtn').disabled=b;$('primaryBtn').textContent=b?'Bitte warten…':(state._authMode==='signup'?'Konto erstellen':'Anmelden');};

  state._authMode=mode;
  function applyMode(){
    const signup=state._authMode==='signup';
    $('signupFields').style.display=signup?'block':'none';
    $('loginTitle').textContent=signup?'Konto erstellen':'BauView – Anmeldung';
    $('loginSub').textContent=signup?'Erstelle dein Konto. Damit wird gleich dein BauView-Benutzer angelegt.':'Melde dich an, damit deine Projekte auf allen Geräten synchron sind.';
    $('primaryBtn').textContent=signup?'Konto erstellen':'Anmelden';
    $('switchBtn').textContent=signup?'Ich habe schon ein Konto – anmelden':'Neues Konto erstellen';
    showErr('');showInfo('');
  }
  applyMode();

  $('switchBtn').onclick=()=>{ state._authMode=state._authMode==='signup'?'login':'signup'; applyMode(); };

  $('primaryBtn').onclick=async()=>{
    const email=$('loginEmail').value.trim();
    const pass=$('loginPass').value;
    if(!email||!pass){showErr('Bitte E-Mail und Passwort eingeben.');return;}
    showErr('');showInfo('');setBusy(true);
    try{
      if(state._authMode==='signup'){
        const name=$('suName').value.trim(); const role='Noch nicht zugewiesen';
        if(!name){showErr('Bitte Namen eingeben.');setBusy(false);return;}
        if(pass.length<6){showErr('Das Passwort muss mindestens 6 Zeichen haben.');setBusy(false);return;}
        const {user,needsConfirm}=await cloudSignUp(email,pass);
        const authId=(user&&user.id)||uid();
        const newUser={id:authId,projectId:undefined,name,role,email:email.toLowerCase(),authId,createdAt:nowISO()};
        await put('users',newUser);
        localStorage.setItem('bauview_currentUserId',authId);
        if(typeof cloudRegisterAccount==='function') await cloudRegisterAccount(authId,email,name,role);
        if(needsConfirm){
          setBusy(false);
          $('signupFields').style.display='none';
          showInfo('✓ Konto erstellt! Wir haben dir eine Bestätigungs-E-Mail an '+email+' geschickt. Bitte klicke den Link darin – danach kannst du dich anmelden.');
          state._authMode='login';
          $('primaryBtn').textContent='Anmelden';
          $('switchBtn').textContent='Neues Konto erstellen';
          $('loginTitle').textContent='E-Mail bestätigen';
          $('loginSub').textContent='Nach dem Klick auf den Link in der E-Mail hier anmelden.';
          return;
        }
        // keine Bestätigung nötig → direkt rein
        const su=await cloudCurrentUser(); ov.remove(); await afterLogin(su);
      }else{
        await cloudSignIn(email,pass);
        const su=await cloudCurrentUser();
        ov.remove();
        await afterLogin(su);
      }
    }catch(e){ setBusy(false); showErr(_loginErrText(e)); }
  };
  $('forgotBtn').onclick=async()=>{
    const email=$('loginEmail').value.trim();
    if(!email){showErr('Bitte zuerst deine E-Mail eingeben.');return;}
    try{ await cloudResetPassword(email); showInfo('Wir haben dir eine E-Mail zum Zurücksetzen des Passworts geschickt.'); showErr(''); }
    catch(e){ showErr(_loginErrText(e)); }
  };
  $('localBtn').onclick=async()=>{
    if(!confirm('Ohne Anmeldung werden deine Daten NICHT synchronisiert und bleiben nur auf diesem Gerät. Fortfahren?'))return;
    ov.remove();renderSyncPill('local');await startApp();
  };
  setTimeout(()=>$('loginEmail')?.focus(),100);
}
function _loginErrText(e){
  const m=(e&&e.message)||'';
  if(/Invalid login/i.test(m))return 'E-Mail oder Passwort falsch.';
  if(/Email not confirmed/i.test(m))return 'Bitte zuerst die Bestätigungs-E-Mail anklicken, dann anmelden.';
  if(/already registered/i.test(m))return 'Dieses Konto existiert bereits – bitte anmelden.';
  if(/rate limit|too many/i.test(m))return 'Zu viele Versuche. Bitte kurz warten.';
  if(/Failed to fetch|NetworkError/i.test(m))return 'Keine Verbindung zum Server. Internet prüfen.';
  if(/6 characters|at least/i.test(m))return 'Das Passwort muss mindestens 6 Zeichen haben.';
  return m||'Vorgang fehlgeschlagen.';
}

function renderSyncPill(st){
  let pill=document.getElementById('syncPill');
  if(!pill){
    const np=document.getElementById('netPill');
    if(!np)return;
    pill=document.createElement('div');pill.id='syncPill';pill.className='sync-pill';
    np.parentNode.insertBefore(pill,np);
  }
  pill.className='sync-pill '+st;
  const label=st==='synced'?'Synchronisiert':st==='syncing'?'Synchronisiere…':st==='error'?'Sync-Fehler':'Nur lokal';
  pill.innerHTML=`<span class="sdot"></span><span>${label}</span>`;
  pill.style.cursor=st==='error'?'pointer':'';
  pill.onclick=st==='error'?()=>{alert('Synchronisierungs-Fehler:\n\n'+(_lastCloudError||'unbekannt')+'\n\nBitte diesen Text an die Entwicklung weitergeben.');}:null;
}
// Wird bei jedem Cloud-Fehler aufgerufen → Pille zeigt sichtbar „Sync-Fehler"
function onCloudError(msg){ renderSyncPill('error'); }
