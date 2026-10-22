// Repositório de dados: produtos, histórico de preços, leituras e configurações.
// Toda operação que mexe em mais de um registro roda em UMA transação.
import { run, req, AppError, productSearchKey, openDB } from './src__data__db.js';
import { newId, foldText } from './src__core__text.js';
import { isValidPriceRecord } from './src__core__validation.js';
import { buildBackup, validateBackup, planImport, toCsv } from './src__data__backup-format.js';
import { DEFAULT_STALE_DAYS, lastChange } from './src__core__compare.js';

/** Dois registros iguais do mesmo produto dentro desta janela são tratados como clique duplicado. */
export const DUPLICATE_WINDOW_MS = 30_000;

export const DEFAULT_SETTINGS = { staleDays: DEFAULT_STALE_DAYS, lastStore: '', showDemo: false, lastBackupAt: null };

const byObservedDesc = (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || (a.id < b.id ? 1 : -1);

function lastPriceOf(prices) {
  if (!prices.length) return null;
  const p = [...prices].sort(byObservedDesc)[0];
  return { id: p.id, cents: p.cents, basis: p.basis, observedAt: p.observedAt, kind: p.kind ?? 'regular' };
}

export class Repo {
  constructor(db) { this.db = db; }

  static async open(name) { return new Repo(await openDB(name)); }
  close() { this.db.close(); }

  /* ---------------------------- produtos ---------------------------- */

  /**
   * Cria um produto e (se houver preço) o primeiro registro de histórico, de forma atômica.
   * input: valores já validados (ver validateProductInput). Idempotente com submissionId.
   */
  createProduct(input, { origin = 'manual', submissionId = null, scanId = null, isDemo = false, now = new Date().toISOString(), observedAt = null } = {}) {
    return run(this.db, ['products', 'prices', 'scans'], 'readwrite', async (tx) => {
      const products = tx.objectStore('products');
      const prices = tx.objectStore('prices');
      if (submissionId) {
        const dup = await req(products.index('submissionId').get(submissionId));
        if (dup) {
          const lp = dup.lastPrice ? await req(prices.get(dup.lastPrice.id)) : null;
          return { product: dup, price: lp, duplicate: true };
        }
      }
      const product = {
        id: newId('prd'), name: input.name, brand: input.brand ?? '', category: input.category || 'Outros',
        packQty: input.packQty ?? null, packUnit: input.packUnit ?? null, barcode: input.barcode ?? null,
        notes: input.notes ?? '', source: origin === 'scanner' ? 'scanner' : origin === 'import' ? 'import' : 'manual',
        isDemo, createdAt: now, updatedAt: now, lastViewedAt: null, lastPrice: null, priceCount: 0, submissionId,
      };
      product.searchKey = productSearchKey(product);
      let price = null;
      if (input.cents) {
        price = {
          id: newId('prc'), productId: product.id, cents: input.cents, basis: input.basis || 'package',
          kind: input.kind === 'promo' ? 'promo' : 'regular', previousCents: input.previousCents ?? null,
          packQty: input.basis && input.basis !== 'package' ? null : (input.packQty ?? null),
          packUnit: input.basis && input.basis !== 'package' ? null : (input.packUnit ?? null),
          observedAt: observedAt ?? now, origin, store: input.store ?? '', note: '', submissionId: null, scanId, isDemo,
        };
        product.lastPrice = lastPriceOf([price]);
        product.priceCount = 1;
        prices.put(price);
      }
      products.put(product);
      if (scanId) {
        const scan = await req(tx.objectStore('scans').get(scanId));
        if (scan) { scan.status = 'saved'; scan.productId = product.id; tx.objectStore('scans').put(scan); }
      }
      return { product, price, duplicate: false };
    });
  }

  updateProduct(id, patch, now = new Date().toISOString()) {
    return run(this.db, ['products'], 'readwrite', async (tx) => {
      const store = tx.objectStore('products');
      const cur = await req(store.get(id));
      if (!cur) throw new AppError('NOT_FOUND', 'Produto não encontrado.');
      const allowed = ['name', 'brand', 'category', 'packQty', 'packUnit', 'barcode', 'notes'];
      const next = { ...cur };
      for (const k of allowed) if (k in patch) next[k] = patch[k];
      next.updatedAt = now;
      next.searchKey = productSearchKey(next);
      store.put(next);
      return next;
    });
  }

  /** Exclui o produto e TODO o seu histórico, de uma vez só. */
  deleteProduct(id) {
    return run(this.db, ['products', 'prices', 'scans'], 'readwrite', async (tx) => {
      const products = tx.objectStore('products');
      const cur = await req(products.get(id));
      if (!cur) throw new AppError('NOT_FOUND', 'Produto não encontrado.');
      const prices = await req(tx.objectStore('prices').index('productId').getAll(id));
      for (const p of prices) tx.objectStore('prices').delete(p.id);
      const scans = await req(tx.objectStore('scans').getAll());
      for (const s of scans) if (s.productId === id) { s.productId = null; tx.objectStore('scans').put(s); }
      products.delete(id);
      return { deletedPrices: prices.length };
    });
  }

  getProduct(id) { return req(this.db.transaction('products').objectStore('products').get(id)); }

  async listProducts({ includeDemo = false } = {}) {
    const all = await req(this.db.transaction('products').objectStore('products').getAll());
    return all.filter((p) => includeDemo || !p.isDemo);
  }

  touchProduct(id, now = new Date().toISOString()) {
    return run(this.db, ['products'], 'readwrite', async (tx) => {
      const s = tx.objectStore('products');
      const p = await req(s.get(id));
      if (p) { p.lastViewedAt = now; s.put(p); }
      return !!p;
    });
  }

  /* ----------------------------- preços ----------------------------- */

  /**
   * Adiciona uma NOVA observação de preço (o histórico anterior nunca é sobrescrito).
   * Cliques repetidos e reprocessamentos não geram duplicatas.
   */
  addPrice(productId, input, { origin = 'manual', submissionId = null, scanId = null, now = new Date().toISOString() } = {}) {
    return run(this.db, ['products', 'prices'], 'readwrite', async (tx) => {
      const products = tx.objectStore('products');
      const prices = tx.objectStore('prices');
      const product = await req(products.get(productId));
      if (!product) throw new AppError('NOT_FOUND', 'Produto não encontrado.');
      if (submissionId) {
        const dup = await req(prices.index('submissionId').get(submissionId));
        if (dup) return { price: dup, product, duplicate: true };
      }
      const existing = await req(prices.index('productId').getAll(productId));
      const basis = input.basis || 'package';
      const observedAt = input.observedAt ?? now;
      const twin = existing.find((p) => p.cents === input.cents && p.basis === basis && (p.store ?? '') === (input.store ?? '')
        && p.origin === origin && Math.abs(Date.parse(observedAt) - Date.parse(p.observedAt)) < DUPLICATE_WINDOW_MS);
      if (twin) return { price: twin, product, duplicate: true };
      const price = {
        id: newId('prc'), productId, cents: input.cents, basis,
        kind: input.kind === 'promo' ? 'promo' : 'regular', previousCents: input.previousCents ?? null,
        packQty: basis === 'package' ? (input.packQty ?? product.packQty ?? null) : null,
        packUnit: basis === 'package' ? (input.packUnit ?? product.packUnit ?? null) : null,
        observedAt, origin, store: input.store ?? '', note: input.note ?? '', submissionId, scanId, isDemo: !!product.isDemo,
      };
      if (!isValidPriceRecord(price)) throw new AppError('VALIDATION', 'Preço inválido.');
      prices.put(price);
      const all = [...existing, price];
      product.lastPrice = lastPriceOf(all);
      product.priceCount = all.length;
      product.updatedAt = now;
      products.put(product);
      return { price, product, duplicate: false };
    });
  }

  deletePrice(priceId) {
    return run(this.db, ['products', 'prices'], 'readwrite', async (tx) => {
      const prices = tx.objectStore('prices');
      const price = await req(prices.get(priceId));
      if (!price) throw new AppError('NOT_FOUND', 'Registro de preço não encontrado.');
      prices.delete(priceId);
      const rest = (await req(prices.index('productId').getAll(price.productId))).filter((p) => p.id !== priceId);
      const products = tx.objectStore('products');
      const product = await req(products.get(price.productId));
      if (product) { product.lastPrice = lastPriceOf(rest); product.priceCount = rest.length; products.put(product); }
      return { remaining: rest.length };
    });
  }

  async getPrices(productId) {
    const list = await req(this.db.transaction('prices').objectStore('prices').index('productId').getAll(productId));
    return list.sort(byObservedDesc);
  }

  async allPrices({ includeDemo = false } = {}) {
    const all = await req(this.db.transaction('prices').objectStore('prices').getAll());
    return all.filter((p) => includeDemo || !p.isDemo).sort(byObservedDesc);
  }

  /* ----------------------------- leituras ---------------------------- */

  addScan(scan) {
    const rec = {
      id: newId('scn'), at: new Date().toISOString(), status: 'pending', productId: null, ...scan,
      rawText: String(scan.rawText ?? '').slice(0, 3000),
    };
    return run(this.db, ['scans'], 'readwrite', (tx) => { tx.objectStore('scans').put(rec); return rec; });
  }

  setScanStatus(id, status) {
    return run(this.db, ['scans'], 'readwrite', async (tx) => {
      const s = tx.objectStore('scans');
      const cur = await req(s.get(id));
      if (cur) { cur.status = status; s.put(cur); }
      return cur;
    });
  }

  async listScans(limit = 10) {
    const all = await req(this.db.transaction('scans').objectStore('scans').getAll());
    return all.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
  }

  /* --------------------------- configurações -------------------------- */

  async getSettings() {
    const row = await req(this.db.transaction('meta').objectStore('meta').get('settings'));
    return { ...DEFAULT_SETTINGS, ...(row?.value ?? {}) };
  }

  setSettings(patch) {
    return run(this.db, ['meta'], 'readwrite', async (tx) => {
      const s = tx.objectStore('meta');
      const row = await req(s.get('settings'));
      const value = { ...DEFAULT_SETTINGS, ...(row?.value ?? {}), ...patch };
      s.put({ key: 'settings', value });
      return value;
    });
  }

  /* ------------------------------ painel ------------------------------ */

  async dashboard() {
    const [products, prices, scans, settings] = await Promise.all([this.listProducts(), this.allPrices(), this.listScans(5), this.getSettings()]);
    const byProduct = new Map();
    for (const p of prices) {
      if (!byProduct.has(p.productId)) byProduct.set(p.productId, []);
      byProduct.get(p.productId).push(p);
    }
    const changes = [];
    for (const p of products) {
      const c = lastChange(byProduct.get(p.id) ?? []);
      if (c && Math.abs(c.pct ?? 0) >= 5) changes.push({ product: p, ...c });
    }
    changes.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    const recentAdded = [...products].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 5);
    const recentViewed = products.filter((p) => p.lastViewedAt).sort((a, b) => Date.parse(b.lastViewedAt) - Date.parse(a.lastViewedAt)).slice(0, 5);
    return { productCount: products.length, priceCount: prices.length, recentAdded, recentViewed, scans, changes: changes.slice(0, 5), settings };
  }

  /* ----------------------- integridade e backup ----------------------- */

  /** Confere relacionamentos produto↔histórico. Com repair=true corrige o que for seguro. */
  async verifyIntegrity({ repair = false } = {}) {
    return run(this.db, ['products', 'prices'], repair ? 'readwrite' : 'readonly', async (tx) => {
      const products = await req(tx.objectStore('products').getAll());
      const prices = await req(tx.objectStore('prices').getAll());
      const ids = new Set(products.map((p) => p.id));
      const orphanPrices = prices.filter((p) => !ids.has(p.productId));
      const mismatched = [];
      const grouped = new Map();
      for (const p of prices) if (ids.has(p.productId)) {
        if (!grouped.has(p.productId)) grouped.set(p.productId, []);
        grouped.get(p.productId).push(p);
      }
      for (const prod of products) {
        const list = grouped.get(prod.id) ?? [];
        const lp = lastPriceOf(list);
        const ok = (lp?.id ?? null) === (prod.lastPrice?.id ?? null) && (prod.priceCount ?? 0) === list.length;
        if (!ok) {
          mismatched.push(prod.id);
          if (repair) { prod.lastPrice = lp; prod.priceCount = list.length; tx.objectStore('products').put(prod); }
        }
      }
      if (repair) for (const o of orphanPrices) tx.objectStore('prices').delete(o.id);
      return { ok: orphanPrices.length === 0 && mismatched.length === 0, orphanPrices: orphanPrices.map((p) => p.id), mismatched, products: products.length, prices: prices.length };
    });
  }

  async exportBackup({ includeDemo = false } = {}) {
    const [products, prices, scans, settings] = await Promise.all([
      this.listProducts({ includeDemo: true }), this.allPrices({ includeDemo: true }),
      req(this.db.transaction('scans').objectStore('scans').getAll()), this.getSettings(),
    ]);
    return buildBackup({ products, prices, scans, settings }, { includeDemo });
  }

  async exportCsv() {
    const [products, prices] = await Promise.all([this.listProducts(), this.allPrices()]);
    return toCsv({ products, prices });
  }

  /** Mostra o que a importação faria, sem alterar nada. */
  async previewImport(obj, mode) {
    const v = validateBackup(obj);
    if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings };
    const current = { products: await this.listProducts({ includeDemo: true }), prices: await this.allPrices({ includeDemo: true }) };
    return { ok: true, warnings: v.warnings, plan: planImport(v.data, current, mode), data: v.data };
  }

  /**
   * Importa um backup já validado. 'merge' só ADICIONA o que ainda não existe (ids novos);
   * 'replace' troca tudo (exceto demonstração) — antes guarda um instantâneo para "desfazer".
   */
  async importBackup(obj, mode) {
    const v = validateBackup(obj);
    if (!v.ok) throw new AppError('INVALID_BACKUP', `Backup inválido: ${v.errors[0]}`);
    const snapshot = mode === 'replace' ? await this.exportBackup({ includeDemo: true }) : null;
    return run(this.db, ['products', 'prices', 'scans', 'meta'], 'readwrite', async (tx) => {
      const P = tx.objectStore('products');
      const R = tx.objectStore('prices');
      const S = tx.objectStore('scans');
      if (mode === 'replace') {
        const cur = await req(P.getAll());
        const curPrices = await req(R.getAll());
        for (const p of cur) if (!p.isDemo) P.delete(p.id);
        for (const r of curPrices) if (!r.isDemo) R.delete(r.id);
        S.clear();
        tx.objectStore('meta').put({ key: 'lastImportSnapshot', value: snapshot, at: new Date().toISOString() });
      }
      const existingP = new Set((await req(P.getAllKeys())));
      const existingR = new Set((await req(R.getAllKeys())));
      let addedP = 0; let addedR = 0;
      const incoming = v.data;
      for (const p of incoming.products) {
        if (existingP.has(p.id)) continue;
        const rec = { ...p, isDemo: false, source: p.source ?? 'import', lastViewedAt: p.lastViewedAt ?? null };
        rec.searchKey = productSearchKey(rec);
        P.put(rec); existingP.add(p.id); addedP++;
      }
      const touched = new Set();
      for (const r of incoming.prices) {
        if (existingR.has(r.id)) continue;
        R.put({ ...r, isDemo: false, origin: r.origin ?? 'import' }); existingR.add(r.id); addedR++; touched.add(r.productId);
      }
      for (const s of incoming.scans) S.put(s);
      // recalcula "último preço" dos produtos afetados
      const allPrices = await req(R.getAll());
      const group = new Map();
      for (const r of allPrices) { if (!group.has(r.productId)) group.set(r.productId, []); group.get(r.productId).push(r); }
      const prods = await req(P.getAll());
      for (const prod of prods) {
        const list = group.get(prod.id) ?? [];
        const lp = lastPriceOf(list);
        if ((lp?.id ?? null) !== (prod.lastPrice?.id ?? null) || (prod.priceCount ?? 0) !== list.length) {
          prod.lastPrice = lp; prod.priceCount = list.length; P.put(prod);
        }
      }
      return { addedProducts: addedP, addedPrices: addedR, mode };
    });
  }

  async hasImportSnapshot() {
    const row = await req(this.db.transaction('meta').objectStore('meta').get('lastImportSnapshot'));
    return row ? { at: row.at } : null;
  }

  /** Restaura o estado anterior à última importação "substituir". */
  async undoLastImport() {
    const row = await req(this.db.transaction('meta').objectStore('meta').get('lastImportSnapshot'));
    if (!row) throw new AppError('NOTHING_TO_UNDO', 'Não há importação para desfazer.');
    await this.importBackup(row.value, 'replace');
    await run(this.db, ['meta'], 'readwrite', (tx) => { tx.objectStore('meta').delete('lastImportSnapshot'); });
    return true;
  }

  /** Apaga TODOS os dados reais (a interface exige confirmação antes). */
  clearAll({ includeDemo = true } = {}) {
    return run(this.db, ['products', 'prices', 'scans'], 'readwrite', async (tx) => {
      const P = tx.objectStore('products'); const R = tx.objectStore('prices');
      for (const p of await req(P.getAll())) if (includeDemo || !p.isDemo) P.delete(p.id);
      for (const r of await req(R.getAll())) if (includeDemo || !r.isDemo) R.delete(r.id);
      if (includeDemo) tx.objectStore('scans').clear();
      return true;
    });
  }

  /* ---------------------------- demonstração --------------------------- */

  async loadDemo(now = new Date()) {
    const existing = (await this.listProducts({ includeDemo: true })).filter((p) => p.isDemo);
    if (existing.length) return { added: 0 };
    const day = (n) => new Date(now.getTime() - n * 86_400_000).toISOString();
    const demo = [
      { name: 'Café Torrado e Moído 500 g (demonstração)', brand: 'Marca Exemplo', category: 'Mercearia', packQty: 500, packUnit: 'g', prices: [[1890, 40, 'Mercado Exemplo A'], [1790, 12, 'Mercado Exemplo A'], [1590, 2, 'Mercado Exemplo B']] },
      { name: 'Arroz Branco 5 kg (demonstração)', brand: 'Marca Exemplo', category: 'Mercearia', packQty: 5000, packUnit: 'g', prices: [[2490, 20, 'Mercado Exemplo A'], [2690, 3, 'Mercado Exemplo A']] },
      { name: 'Leite Integral 1 L (demonstração)', brand: 'Marca Exemplo', category: 'Laticínios', packQty: 1000, packUnit: 'ml', prices: [[499, 9, 'Mercado Exemplo B']] },
    ];
    let added = 0;
    for (const d of demo) {
      const first = d.prices[0];
      const { product } = await this.createProduct(
        { name: d.name, brand: d.brand, category: d.category, packQty: d.packQty, packUnit: d.packUnit, cents: first[0], basis: 'package', store: first[2], notes: 'Dado de demonstração — não é um preço real.' },
        { origin: 'manual', isDemo: true, now: day(first[1]), observedAt: day(first[1]) },
      );
      for (const [cents, ago, store] of d.prices.slice(1)) {
        await this.addPrice(product.id, { cents, basis: 'package', store }, { origin: 'manual', now: day(ago) });
      }
      added++;
    }
    return { added };
  }

  removeDemo() {
    return run(this.db, ['products', 'prices'], 'readwrite', async (tx) => {
      let n = 0;
      for (const p of await req(tx.objectStore('products').getAll())) if (p.isDemo) { tx.objectStore('products').delete(p.id); n++; }
      for (const r of await req(tx.objectStore('prices').getAll())) if (r.isDemo) tx.objectStore('prices').delete(r.id);
      return { removed: n };
    });
  }
}

/* ----------------------- busca / filtros (puros) ----------------------- */

export function filterProducts(products, { query = '', category = '', sort = 'recent' } = {}) {
  const terms = foldText(query).split(' ').filter(Boolean);
  let list = products.filter((p) => terms.every((t) => (p.searchKey ?? '').includes(t)));
  if (category) list = list.filter((p) => p.category === category);
  const cmp = {
    recent: (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    name: (a, b) => a.name.localeCompare(b.name, 'pt-BR'),
    price: (a, b) => (a.lastPrice?.cents ?? Infinity) - (b.lastPrice?.cents ?? Infinity),
  }[sort] ?? (() => 0);
  return list.sort(cmp);
}
