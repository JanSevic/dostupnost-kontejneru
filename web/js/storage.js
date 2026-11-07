// Browser storage (IndexedDB): areas, containers and variants, settings.
// The database name changed together with the record format (Czech -> English keys), so
// data saved by older versions are not read.
const DB_NAME = "dostupnost-kontejneru-v2";
let connection = null;

export function open() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("areas", { keyPath: "slug" });
      d.createObjectStore("work", { keyPath: "slug" });
      d.createObjectStore("settings", { keyPath: "key" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return connection;
}

async function transaction(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Uložení se nepovedlo (plné úložiště prohlížeče?)."));
  });
}

export const get = (store, key) => transaction(store, "readonly", (s) => s.get(key));
export const getAll = (store) => transaction(store, "readonly", (s) => s.getAll());
export const put = (store, value) => transaction(store, "readwrite", (s) => s.put(value));
export const remove = (store, key) => transaction(store, "readwrite", (s) => s.delete(key));
