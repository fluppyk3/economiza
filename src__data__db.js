// Abertura do IndexedDB com migrações versionadas.
//  v1: produtos, preços e meta
//  v2: leituras (scans), índice de "consultado recentemente" e preenchimento de searchKey
import { foldText } from './src__core__text.js';
import { AppError } from './src__core__errors.js';

export const DB_NAME = 'precocerto';
export const DB_VERSION = 2;

export { AppError };

export function productSearchKey(p) {
  return foldText([p.name, p.brand, p.category, p.barcode].filter(Boolean).join(' '));
}

const MIGRATIONS = {
  1(db) {
    const products = db.createObjectStore('products', { keyPath: 'id' });
    products.createIndex('name', 'name');
    products.createIndex('createdAt', 'createdAt');
    products.createIndex('updatedAt', 'updatedAt');
    products.createIndex('category', 'category');
    products.createIndex('submissionId', 'submissionId');
    const prices = db.createObjectStore('prices', { keyPath: 'id' });
    prices.createIndex('productId', 'productId');
    prices.createIndex('observedAt', 'observedAt');
    prices.createIndex('submissionId', 'submissionId');
    db.createObjectStore('meta', { keyPath: 'key' });
  },
  2(db, tx) {
    if (!db.objectStoreNames.contains('scans')) {
      const scans = db.createObjectStore('scans', { keyPath: 'id' });
      scans.createIndex('at', 'at');
    }
    const products = tx.objectStore('products');
    if (!products.indexNames.contains('lastViewedAt')) products.createIndex('lastViewedAt', 'lastViewedAt');
    // preenche searchKey e contadores em produtos criados antes da v2
    products.openCursor().onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return;
      const p = cur.value;
      let changed = false;
      if (typeof p.searchKey !== 'string') { p.searchKey = productSearchKey(p); changed = true; }
      if (typeof p.isDemo !== 'boolean') { p.isDemo = false; changed = true; }
      if (p.lastViewedAt === undefined) { p.lastViewedAt = null; changed = true; }
      if (changed) cur.update(p);
      cur.continue();
    };
  },
};

export function openDB(name = DB_NAME, version = DB_VERSION) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new AppError('STORAGE_UNAVAILABLE', 'Este navegador não permite salvar dados aqui (armazenamento indisponível). Abra em uma janela normal, não anônima.'));
      return;
    }
    let req;
    try { req = indexedDB.open(name, version); } catch (e) {
      reject(new AppError('STORAGE_UNAVAILABLE', 'Não foi possível abrir o armazenamento do navegador.', e));
      return;
    }
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction;
      for (let v = ev.oldVersion + 1; v <= (ev.newVersion ?? version); v++) {
        if (MIGRATIONS[v]) MIGRATIONS[v](db, tx);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(new AppError('STORAGE_UNAVAILABLE', 'Não foi possível abrir o armazenamento do navegador.', req.error));
    req.onblocked = () => reject(new AppError('STORAGE_BLOCKED', 'O armazenamento está em uso por outra aba do aplicativo. Feche as outras abas e recarregue.'));
  });
}

/** Promessa para um IDBRequest. */
export const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

/**
 * Executa `work(tx)` em UMA transação. Se algo falhar, a transação é abortada e
 * NADA é gravado (os dados anteriores permanecem íntegros).
 */
export function run(db, stores, mode, work) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(stores, mode); } catch (e) { reject(wrapError(e)); return; }
    let result;
    let failed = false;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(wrapError(tx.error ?? new Error('Operação cancelada')));
    Promise.resolve()
      .then(() => work(tx))
      .then((r) => { result = r; })
      .catch((e) => {
        failed = true;
        try { tx.abort(); } catch { /* já finalizada */ }
        reject(wrapError(e));
      });
    void failed;
  });
}

export function wrapError(e) {
  if (e instanceof AppError) return e;
  if (e && e.name === 'QuotaExceededError') {
    return new AppError('QUOTA', 'O armazenamento do navegador está cheio. Exporte um backup e libere espaço.', e);
  }
  return new AppError('STORAGE_ERROR', 'Não foi possível concluir a operação com os dados. Nada foi alterado.', e);
}

export function deleteDatabase(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => resolve();
  });
}
