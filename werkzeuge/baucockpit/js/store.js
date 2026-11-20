/* Baucockpit – interner Speicher (IndexedDB) */
(function () {
  const DB_NAME = 'baucockpit';
  const DB_VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('catalog')) db.createObjectStore('catalog', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
    });
  }
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  const Store = {
    async all(store) { return tx(store, 'readonly', s => reqP(s.getAll())); },
    async get(store, key) { return tx(store, 'readonly', s => reqP(s.get(key))); },
    async put(store, obj) { return tx(store, 'readwrite', s => reqP(s.put(obj))); },
    async del(store, key) { return tx(store, 'readwrite', s => reqP(s.delete(key))); },
    async getSetting(key, def) { const r = await Store.get('settings', key); return r ? r.value : def; },
    async setSetting(key, value) { return Store.put('settings', { key, value }); },
    async exportAll() {
      return {
        format: 'baucockpit-backup', version: 1, exported: new Date().toISOString(),
        projects: await Store.all('projects'), catalog: await Store.all('catalog'), settings: await Store.all('settings')
      };
    },
    async importAll(data, { replace = false } = {}) {
      if (!data || data.format !== 'baucockpit-backup') throw new Error('Keine gültige Baucockpit-Sicherung');
      if (replace) {
        for (const st of ['projects', 'catalog', 'settings']) for (const o of await Store.all(st)) await Store.del(st, o.id || o.key);
      }
      for (const p of data.projects || []) await Store.put('projects', p);
      for (const c of data.catalog || []) await Store.put('catalog', c);
      for (const s of data.settings || []) await Store.put('settings', s);
    },
    async estimate() {
      if (navigator.storage && navigator.storage.estimate) return navigator.storage.estimate();
      return null;
    },
    async persist() {
      if (navigator.storage && navigator.storage.persist) return navigator.storage.persist();
      return false;
    }
  };
  window.Store = Store;
})();
