/* ============================================================
   CLOUD-SYNC-SCHICHT  (Supabase)
   ------------------------------------------------------------
   Diese Datei kapselt die GESAMTE Cloud-Kommunikation.
   Beim späteren Wechsel auf M365/SharePoint wird NUR diese
   Datei ausgetauscht – der Rest der App bleibt unverändert.

   >>> HIER deine Supabase-Zugangsdaten eintragen: <<<
   ============================================================ */
const CLOUD_CONFIG = {
  url:  'https://oljyepagacpgbqkjzfxm.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sanllcGFnYWNwZ2Jxa2p6ZnhtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2NDE1MDEsImV4cCI6MjA5ODIxNzUwMX0.xlr4ctB3uqCcNUnb1coTxLwo8WeY-_JHOITRQVUWl4Y',
  adminEmail: 'yavuz@helbling-architektur.ch',  // Admin-Konto: sieht alle Konten, steuert Rollen
  enabled: false                  // wird automatisch true, sobald URL+Key gültig sind
};
function cloudIsAdmin(email){
  const a=(CLOUD_CONFIG.adminEmail||'').trim().toLowerCase();
  return a && email && email.trim().toLowerCase()===a;
}
// Tabellen, die in die Cloud synchronisiert werden (entspricht STORES ohne 'app')
const CLOUD_TABLES = ['projects','plans','defects','contacts','protocols','acceptances','checklists','workorders','journal','notes','users','files','honorars','baubeschriebe'];

let _sb = null;            // Supabase-Client
let _cloudReady = false;
let _online = navigator.onLine;
let _syncQueueKey = 'bauview_sync_queue';

/* ---------- Initialisierung ---------- */
async function cloudInit(){
  const cfgValid = CLOUD_CONFIG.url && CLOUD_CONFIG.url.startsWith('http') &&
                   CLOUD_CONFIG.anonKey && CLOUD_CONFIG.anonKey.length>20 &&
                   !CLOUD_CONFIG.url.includes('HIER_');
  CLOUD_CONFIG.enabled = !!cfgValid;
  if(!CLOUD_CONFIG.enabled){ console.info('[Cloud] Kein gültiges Supabase-Konfig – App läuft rein lokal.'); return false; }
  if(typeof supabase==='undefined'){ console.warn('[Cloud] Supabase-Bibliothek nicht geladen.'); return false; }
  _sb = supabase.createClient(CLOUD_CONFIG.url, CLOUD_CONFIG.anonKey);
  _cloudReady = true;
  window.addEventListener('online', ()=>{ _online=true; cloudFlushQueue(); });
  window.addEventListener('offline', ()=>{ _online=false; });
  return true;
}
function cloudEnabled(){ return CLOUD_CONFIG.enabled && _cloudReady; }

/* ---------- Authentifizierung (Login) ---------- */
async function cloudSignIn(email,password){
  if(!cloudEnabled()) throw new Error('Cloud nicht aktiv');
  const {data,error}=await _sb.auth.signInWithPassword({email:email.trim().toLowerCase(),password});
  if(error) throw error; return data.user;
}
// Registrierung. Gibt {user, needsConfirm} zurück: needsConfirm=true → E-Mail muss bestätigt werden.
async function cloudSignUp(email,password){
  if(!cloudEnabled()) throw new Error('Cloud nicht aktiv');
  const redirectTo = (location.origin && location.origin.startsWith('http')) ? location.origin : undefined;
  const {data,error}=await _sb.auth.signUp({
    email:email.trim().toLowerCase(), password,
    options: redirectTo ? { emailRedirectTo: redirectTo } : {}
  });
  if(error) throw error;
  // Wenn keine Session zurückkommt, verlangt Supabase eine E-Mail-Bestätigung.
  const needsConfirm = !data.session;
  return { user:data.user, needsConfirm };
}
async function cloudSignOut(){ if(cloudEnabled()) await _sb.auth.signOut(); }
// Zuverlässig: erst Session prüfen (lokal, schnell), dann User.
async function cloudCurrentUser(){
  if(!cloudEnabled()) return null;
  try{
    const {data:s}=await _sb.auth.getSession();
    if(!s || !s.session) return null;
    return s.session.user || null;
  }catch(e){ return null; }
}
// Passwort zurücksetzen (Mail mit Link)
async function cloudResetPassword(email){
  if(!cloudEnabled()) throw new Error('Cloud nicht aktiv');
  const redirectTo=(location.origin&&location.origin.startsWith('http'))?location.origin:undefined;
  const {error}=await _sb.auth.resetPasswordForEmail(email.trim().toLowerCase(), redirectTo?{redirectTo}:{});
  if(error) throw error;
}

/* ---------- Daten: Upsert / Delete / Pull ---------- */
// Wandelt App-Objekt -> Tabellenzeile {id, projectId, data}
function _toRow(row){
  const r={ id: row.id, data: row };
  if(row.projectId!==undefined) r.projectId = row.projectId;
  // Projekte tragen Eigentümer + Mitglieder als eigene Spalten (für serverseitige Trennung)
  if(row.ownerId!==undefined) r.ownerId = row.ownerId;
  if(row.members!==undefined) r.members = row.members;
  return r;
}
// Wandelt Tabellenzeile -> App-Objekt (members/ownerId aus Spalte zurück ins Objekt spiegeln)
function _fromRow(rec){
  if(!rec) return rec;
  const d = rec.data ? rec.data : rec;
  if(rec.ownerId!==undefined && d) d.ownerId = rec.ownerId;
  if(rec.members!==undefined && d) d.members = rec.members;
  return d;
}

let _lastCloudError=''; // letzter Cloud-Fehler (für sichtbare Diagnose)
function _cloudErr(msg){ _lastCloudError=msg; try{ if(typeof onCloudError==='function') onCloudError(msg); }catch(e){} }

// Lagert eingebettete Base64-Bilder eines Datensatzes in den Storage aus.
// Bildfelder je Tabelle: defects/protocol-items haben excerpt + photos[], notes/journal photos[], acceptances sigBuilder/sigContractor
async function _offloadImages(table,row){
  if(!cloudEnabled()||!row) return row;
  const pid=row.projectId;
  const isData=v=>typeof v==='string'&&v.startsWith('data:');
  try{
    // excerpt (Planausschnitt)
    if(isData(row.excerpt)) row.excerpt=await cloudUploadImage(pid,row.excerpt,'ex_');
    // photos-Array
    if(Array.isArray(row.photos)){
      for(let i=0;i<row.photos.length;i++) if(isData(row.photos[i])) row.photos[i]=await cloudUploadImage(pid,row.photos[i],'ph_');
    }
    // Unterschriften (Abnahme)
    if(isData(row.sigBuilder)) row.sigBuilder=await cloudUploadImage(pid,row.sigBuilder,'sb_');
    if(isData(row.sigContractor)) row.sigContractor=await cloudUploadImage(pid,row.sigContractor,'sc_');
    // Protokoll-/Abnahme-Items mit eigenen Bildern
    if(Array.isArray(row.items)){
      for(const it of row.items){
        if(isData(it.excerpt)) it.excerpt=await cloudUploadImage(pid,it.excerpt,'ie_');
        if(Array.isArray(it.photos)) for(let i=0;i<it.photos.length;i++) if(isData(it.photos[i])) it.photos[i]=await cloudUploadImage(pid,it.photos[i],'ip_');
      }
    }
    // Plan-PDFs (oft mehrere MB) auslagern – Zeile bleibt sonst zu gross für Supabase/localStorage.
    // Lokal bleibt pdfData erhalten (schnelles Rendern); die Cloud-Kopie bekommt nur die URL.
    if(table==='plans' && Array.isArray(row.versions)){
      for(const v of row.versions){
        if(isData(v.pdfData)){
          const url=await cloudUploadImage(pid,v.pdfData,'plan_');
          if(url && !url.startsWith('data:')){ v.pdfUrl=url; v.pdfData=null; }
        }
      }
    }
  }catch(e){ console.warn('[Cloud] Bild-Auslagerung:',e.message); }
  return row;
}

async function cloudUpsert(table,row){
  if(!cloudEnabled()) return;
  if(!_online){ cloudEnqueue({op:'upsert',table,row}); return; }
  try{
    // Bilder auslagern – auf einer KOPIE, damit die lokale Anzeige die schnellen Base64 behält.
    const slim=await _offloadImages(table, JSON.parse(JSON.stringify(row)));
    const {error}=await _sb.from(table).upsert(_toRow(slim));
    if(error) throw error;
    _lastCloudError='';
  }catch(e){
    console.warn('[Cloud] upsert fehlgeschlagen ('+table+'):',e.message);
    _cloudErr('Upload fehlgeschlagen ('+table+'): '+e.message);
    cloudEnqueue({op:'upsert',table,row});
  }
}
async function cloudDelete(table,id){
  if(!cloudEnabled()) return;
  if(!_online){ cloudEnqueue({op:'delete',table,id}); return; }
  try{
    const {error}=await _sb.from(table).delete().eq('id',id);
    if(error) throw error;
  }catch(e){ console.warn('[Cloud] delete fehlgeschlagen, in Warteschlange:',e.message); cloudEnqueue({op:'delete',table,id}); }
}
async function cloudPullAll(table){
  if(!cloudEnabled()) return [];
  try{
    const {data,error}=await _sb.from(table).select('*');
    if(error) throw error; return (data||[]).map(_fromRow);
  }catch(e){ console.warn('[Cloud] pull fehlgeschlagen:',e.message); return []; }
}

/* ---------- Offline-Warteschlange ---------- */
function cloudEnqueue(item){
  try{
    const q=JSON.parse(localStorage.getItem(_syncQueueKey)||'[]');
    q.push({...item,ts:Date.now()});
    localStorage.setItem(_syncQueueKey,JSON.stringify(q));
  }catch(e){
    // localStorage-Limit erreicht (z.B. sehr grosse Datei) – nicht crashen.
    // Ohne Warteschlangen-Eintrag wird der Retry beim nächsten Login über cloudSyncUp nachgeholt.
    console.warn('[Cloud] Warteschlange voll, Eintrag übersprungen:',e.message);
    try{ localStorage.removeItem(_syncQueueKey); }catch(_){} // kaputten/übergrossen Queue-Eintrag verwerfen
  }
}
async function cloudFlushQueue(){
  if(!cloudEnabled()||!_online) return;
  let q=[];
  try{ q=JSON.parse(localStorage.getItem(_syncQueueKey)||'[]'); }catch(e){ q=[]; }
  if(!q.length) return;
  const remaining=[];
  for(const item of q){
    try{
      if(item.op==='upsert'){ const {error}=await _sb.from(item.table).upsert(_toRow(item.row)); if(error) throw error; }
      else if(item.op==='delete'){ const {error}=await _sb.from(item.table).delete().eq('id',item.id); if(error) throw error; }
    }catch(e){ remaining.push(item); }
  }
  try{ localStorage.setItem(_syncQueueKey,JSON.stringify(remaining)); }catch(e){ try{localStorage.removeItem(_syncQueueKey);}catch(_){} }
  if(typeof toast==='function' && q.length && !remaining.length) toast('Synchronisiert',true);
}

/* ---------- Datei-Speicher (Plan-PDFs, externe Dateien) ---------- */
// Lädt eine Datei in den Supabase-Storage-Bucket 'files' und gibt den Pfad + öffentliche URL zurück
async function cloudUploadFile(projectId, fileObj){
  if(!cloudEnabled()) return null;
  const path = `${projectId}/${Date.now()}_${fileObj.name.replace(/[^\w.\-]/g,'_')}`;
  const {error}=await _sb.storage.from('files').upload(path, fileObj, {upsert:false});
  if(error) throw error;
  const {data}=_sb.storage.from('files').getPublicUrl(path);
  return { path, url: data.publicUrl };
}
async function cloudDownloadFileUrl(path){
  if(!cloudEnabled()) return null;
  const {data}=_sb.storage.from('files').getPublicUrl(path);
  return data.publicUrl;
}
async function cloudDeleteFile(path){
  if(!cloudEnabled()||!path) return;
  try{ await _sb.storage.from('files').remove([path]); }catch(e){ console.warn('[Cloud] Datei löschen fehlgeschlagen',e.message); }
}

/* ---------- Bild-Auslagerung (Base64 -> Storage) ----------
   Große eingebettete Bilder (Fotos, Planausschnitte) werden in den Storage
   ausgelagert, damit die Datenbankzeilen klein bleiben (Sync funktioniert,
   weniger Daten/Token). Im Datensatz steht dann nur noch die kurze URL. */
function _b64ToBlob(dataURL){
  try{
    const arr=dataURL.split(','); const mime=(arr[0].match(/:(.*?);/)||[])[1]||'image/jpeg';
    const bin=atob(arr[1]); const u=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);
    return new Blob([u],{type:mime});
  }catch(e){ return null; }
}
// Lädt einen Base64-String in den Storage und gibt die öffentliche URL zurück
async function cloudUploadImage(projectId, dataURL, tag){
  if(!cloudEnabled()||!dataURL||!dataURL.startsWith('data:')) return dataURL; // schon URL oder leer
  const blob=_b64ToBlob(dataURL); if(!blob) return dataURL;
  const ext=(blob.type.split('/')[1]||'jpg').replace('jpeg','jpg');
  const path=`${projectId||'allg'}/img_${tag||''}${Date.now()}_${Math.random().toString(36).slice(2,7)}.${ext}`;
  try{
    const {error}=await _sb.storage.from('files').upload(path, blob, {upsert:true,contentType:blob.type});
    if(error) throw error;
    const {data}=_sb.storage.from('files').getPublicUrl(path);
    return data.publicUrl;
  }catch(e){ console.warn('[Cloud] Bild-Upload fehlgeschlagen:',e.message); return dataURL; }
}
// Lädt eine öffentlich lesbare JSON-Momentaufnahme hoch (für Unternehmer-Freigabe per QR-Code/Link,
// ohne dass der Unternehmer einen BauView-Account braucht). Gibt die öffentliche URL zurück, oder null.
async function cloudUploadPublicJSON(pathId, obj){
  if(!cloudEnabled()) return null;
  try{
    const blob=new Blob([JSON.stringify(obj)],{type:'application/json'});
    const path=`public/${pathId}.json`;
    const {error}=await _sb.storage.from('files').upload(path, blob, {upsert:true,contentType:'application/json'});
    if(error) throw error;
    const {data}=_sb.storage.from('files').getPublicUrl(path);
    return data.publicUrl;
  }catch(e){ console.warn('[Cloud] Freigabe-Upload fehlgeschlagen:',e.message); return null; }
}

/* ---------- Voll-Synchronisierung beim Start ---------- */
// Lädt ALLE lokalen Datensätze in die Cloud hoch (für Geräte, die schon lokale Daten haben).
async function cloudSyncUp(){
  if(!cloudEnabled()||typeof all!=='function') return;
  const myId = (typeof CURRENT_AUTH!=='undefined' && CURRENT_AUTH) ? CURRENT_AUTH.id : null;
  for(const table of CLOUD_TABLES){
    let rows=[];
    try{ rows=await all(table); }catch(e){ continue; }
    for(const row of rows){
      // Migration: Projekte ohne Eigentümer dem aktuellen Benutzer zuordnen,
      // sonst gehen sie durch die neue serverseitige Trennung "verloren".
      if(table==='projects' && myId){
        if(!row.ownerId) row.ownerId=myId;
        if(!Array.isArray(row.members)) row.members=[];
        if(!row.members.includes(myId)) row.members.push(myId);
        try{ await putLocal('projects',row); }catch(e){}
      }
      try{ await cloudUpsert(table,row); }catch(e){}
    }
  }
}
// Holt alle Cloud-Daten und spiegelt sie lokal in IndexedDB.
// Vorhandene lokale Datensätze mit eingebetteten Bildern werden NICHT durch
// die schlanke Cloud-Version (nur URLs) ersetzt – lokal bleibt schnell/offline.
async function cloudSyncDown(){
  if(!cloudEnabled()) return;
  for(const table of CLOUD_TABLES){
    const rows=await cloudPullAll(table);
    for(const row of rows){
      try{
        let local=null; try{ local=await get(table,row.id); }catch(_){}
        if(local && _hasEmbedded(local) && !_hasEmbedded(row)){
          // lokal ist „reicher" (Base64-Bilder) als Cloud (URLs) → lokal behalten
          continue;
        }
        await putLocal(table,row);
      }catch(e){}
    }
  }
}
function _hasEmbedded(o){
  if(!o) return false;
  const d=v=>typeof v==='string'&&v.startsWith('data:');
  if(d(o.excerpt)||d(o.sigBuilder)||d(o.sigContractor)) return true;
  if(Array.isArray(o.photos)&&o.photos.some(d)) return true;
  if(Array.isArray(o.items)&&o.items.some(it=>d(it.excerpt)||(Array.isArray(it.photos)&&it.photos.some(d)))) return true;
  if(Array.isArray(o.versions)&&o.versions.some(v=>d(v.pdfData))) return true; // Pläne
  return false;
}

/* ---------- LIVE-SYNC (Realtime) ---------- */
// Abonniert Änderungen aller Tabellen. Bei Fremdänderung wird lokal gespiegelt
// und onChange(table) aufgerufen (zum Neu-Rendern).
let _rtChannel=null;
function cloudSubscribeRealtime(onChange){
  if(!cloudEnabled()||!_sb) return;
  try{
    if(_rtChannel){ _sb.removeChannel(_rtChannel); _rtChannel=null; }
    _rtChannel=_sb.channel('bauview_live');
    CLOUD_TABLES.forEach(table=>{
      _rtChannel.on('postgres_changes',{event:'*',schema:'public',table},async payload=>{
        try{
          if(payload.eventType==='DELETE'){
            const id=payload.old&&payload.old.id; if(id)await delLocal(table,id);
          }else{
            const rec=_fromRow(payload.new); if(rec&&rec.id)await putLocal(table,rec);
          }
          if(typeof onChange==='function') onChange(table);
        }catch(e){}
      });
    });
    _rtChannel.subscribe();
  }catch(e){ console.warn('[Cloud] Realtime nicht verfügbar:',e.message); }
}
function cloudUnsubscribeRealtime(){ if(_rtChannel&&_sb){ try{_sb.removeChannel(_rtChannel);}catch(e){} _rtChannel=null; } }

// Auth-Status-Änderungen (z.B. Bestätigung in anderem Tab) beobachten
function cloudOnAuthChange(cb){
  if(!cloudEnabled()||!_sb) return;
  _sb.auth.onAuthStateChange((event,session)=>{ try{cb&&cb(event,session);}catch(e){} });
}

/* ---------- KONTEN-REGISTER (für Admin-Übersicht) ---------- */
// Bei Registrierung wird hier ein Eintrag angelegt: wer hat ein Konto, welche Rolle, Status.
async function cloudRegisterAccount(authUserId, email, name, role){
  if(!cloudEnabled()||!authUserId) return;
  const em=(email||'').toLowerCase();
  // Erst prüfen, ob für diese E-Mail bereits ein Konto existiert (Duplikate vermeiden)
  try{
    const all=await cloudListAccounts();
    const existing=all.find(a=>(a.email||'').toLowerCase()===em && a.id!==authUserId);
    if(existing){
      // Duplikat mit anderer id gefunden → altes löschen, neues (auth-id) behalten
      try{ await cloudDeleteAccount(existing.id); }catch(e){}
    }
    const mine=all.find(a=>a.id===authUserId);
    if(mine){
      // Eintrag existiert → nur Name auffüllen, Rolle NICHT überschreiben (Admin vergibt sie)
      const merged={...mine};
      if(name && !mine.name) merged.name=name;
      if(em && !mine.email) merged.email=em;
      const {error}=await _sb.from('accounts').upsert({id:authUserId,data:merged}); if(error)throw error;
      return;
    }
  }catch(e){}
  const row={ id:authUserId, data:{ id:authUserId, email:em, name:name||'', role:role||'Noch nicht zugewiesen',
    permissions:null, createdAt:new Date().toISOString(), status:'aktiv' } };
  try{ const {error}=await _sb.from('accounts').upsert(row); if(error)throw error; }
  catch(e){ console.warn('[Cloud] Konto-Register:',e.message); }
}
async function cloudListAccounts(){
  if(!cloudEnabled()) return [];
  try{ const {data,error}=await _sb.from('accounts').select('*'); if(error)throw error; return (data||[]).map(_fromRow); }
  catch(e){ console.warn('[Cloud] Konten lesen:',e.message); return []; }
}
async function cloudUpdateAccount(account){
  if(!cloudEnabled()) return;
  try{ const {error}=await _sb.from('accounts').upsert({id:account.id,data:account}); if(error)throw error; }
  catch(e){ console.warn('[Cloud] Konto aktualisieren:',e.message); }
}
async function cloudDeleteAccount(id){
  if(!cloudEnabled()||!id) return;
  try{ const {error}=await _sb.from('accounts').delete().eq('id',id); if(error)throw error; }
  catch(e){ console.warn('[Cloud] Konto löschen:',e.message); }
}
// Eigenes Passwort ändern
async function cloudUpdatePassword(newPassword){
  if(!cloudEnabled()) throw new Error('Cloud nicht aktiv');
  const {error}=await _sb.auth.updateUser({password:newPassword});
  if(error) throw error;
}
// Eigene E-Mail ändern (löst Bestätigungsmail aus)
async function cloudUpdateEmail(newEmail){
  if(!cloudEnabled()) throw new Error('Cloud nicht aktiv');
  const {error}=await _sb.auth.updateUser({email:newEmail.trim().toLowerCase()});
  if(error) throw error;
}
