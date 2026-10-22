// Formato de backup (JSON) e exportação CSV — funções puras, sem acesso ao banco.
import { isValidCents, formatBRL } from './src__core__money.js';
import { formatQuantity } from './src__core__units.js';

export const APP_NAME = 'PrecoCerto';
export const BACKUP_FORMAT_VERSION = 1;

const BASES = ['package', 'kg', 'l', 'un'];
const ORIGINS = ['manual', 'scanner', 'import'];

/** Monta o objeto de backup (sem dados de demonstração, a menos que pedido). */
export function buildBackup({ products, prices, scans = [], settings = null }, { includeDemo = false, now = new Date().toISOString() } = {}) {
  const keepProducts = products.filter((p) => includeDemo || !p.isDemo);
  const ids = new Set(keepProducts.map((p) => p.id));
  const keepPrices = prices.filter((p) => ids.has(p.productId));
  return {
    app: APP_NAME,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: now,
    counts: { products: keepProducts.length, prices: keepPrices.length },
    settings,
    products: keepProducts,
    prices: keepPrices,
    scans: scans.filter((s) => !s.productId || ids.has(s.productId)),
  };
}

const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));
const isStr = (s, max) => typeof s === 'string' && s.length <= max;

/**
 * Valida um backup. NÃO altera nada. Retorna { ok, errors[], warnings[], data }.
 * Qualquer erro estrutural rejeita o arquivo inteiro (nada é importado pela metade).
 */
export function validateBackup(obj) {
  const errors = [];
  const warnings = [];
  const add = (m) => { if (errors.length < 30) errors.push(m); };

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['O arquivo não contém um backup do PreçoCerto.'], warnings, data: null };
  if (obj.app !== APP_NAME) add('O arquivo não parece ser um backup do PreçoCerto (campo "app" ausente ou diferente).');
  if (typeof obj.formatVersion !== 'number') add('Versão do formato ausente.');
  else if (obj.formatVersion > BACKUP_FORMAT_VERSION) add(`Este backup é de uma versão mais nova (${obj.formatVersion}) que o aplicativo entende (${BACKUP_FORMAT_VERSION}).`);
  if (!Array.isArray(obj.products)) add('Lista de produtos ausente.');
  if (!Array.isArray(obj.prices)) add('Lista de preços ausente.');
  if (errors.length) return { ok: false, errors, warnings, data: null };

  const productIds = new Set();
  obj.products.forEach((p, i) => {
    const at = `Produto ${i + 1}`;
    if (!p || typeof p !== 'object') return add(`${at}: formato inválido.`);
    if (!isStr(p.id, 80) || !p.id) add(`${at}: identificador inválido.`);
    else if (productIds.has(p.id)) add(`${at}: identificador repetido (${p.id}).`);
    else productIds.add(p.id);
    if (!isStr(p.name, 120) || p.name.trim().length < 1) add(`${at}: nome inválido.`);
    if (p.brand !== undefined && !isStr(p.brand, 60)) add(`${at}: marca inválida.`);
    if (p.category !== undefined && !isStr(p.category, 40)) add(`${at}: categoria inválida.`);
    if (p.notes !== undefined && !isStr(p.notes, 500)) add(`${at}: observações inválidas.`);
    if (p.packQty != null && !(Number.isSafeInteger(p.packQty) && p.packQty > 0)) add(`${at}: quantidade da embalagem inválida.`);
    if (p.packUnit != null && !['g', 'ml', 'un'].includes(p.packUnit)) add(`${at}: unidade da embalagem inválida.`);
    if (!isIso(p.createdAt)) add(`${at}: data de criação inválida.`);
  });

  const priceIds = new Set();
  obj.prices.forEach((r, i) => {
    const at = `Preço ${i + 1}`;
    if (!r || typeof r !== 'object') return add(`${at}: formato inválido.`);
    if (!isStr(r.id, 80) || !r.id) add(`${at}: identificador inválido.`);
    else if (priceIds.has(r.id)) add(`${at}: identificador repetido (${r.id}).`);
    else priceIds.add(r.id);
    if (!productIds.has(r.productId)) add(`${at}: refere-se a um produto que não existe no arquivo.`);
    if (!isValidCents(r.cents)) add(`${at}: valor inválido (deve ser um número inteiro de centavos maior que zero).`);
    if (!BASES.includes(r.basis)) add(`${at}: tipo de preço inválido.`);
    if (!isIso(r.observedAt)) add(`${at}: data inválida.`);
    if (r.origin !== undefined && !ORIGINS.includes(r.origin)) add(`${at}: origem inválida.`);
    if (r.store !== undefined && !isStr(r.store, 60)) add(`${at}: loja inválida.`);
    if (r.note !== undefined && !isStr(r.note, 500)) add(`${at}: observação inválida.`);
  });

  const scans = Array.isArray(obj.scans) ? obj.scans : [];
  if (obj.scans !== undefined && !Array.isArray(obj.scans)) add('Lista de leituras inválida.');

  if (errors.length) return { ok: false, errors, warnings, data: null };
  if (obj.products.length === 0) warnings.push('O backup não contém produtos.');
  return { ok: true, errors, warnings, data: { products: obj.products, prices: obj.prices, scans, settings: obj.settings ?? null } };
}

/** Descreve o que uma importação fará, SEM alterar nada. */
export function planImport(data, current, mode) {
  const curProductIds = new Set(current.products.map((p) => p.id));
  const curPriceIds = new Set(current.prices.map((p) => p.id));
  const newProducts = data.products.filter((p) => !curProductIds.has(p.id));
  const newPrices = data.prices.filter((p) => !curPriceIds.has(p.id));
  if (mode === 'replace') {
    return {
      mode, willDeleteProducts: current.products.filter((p) => !p.isDemo).length, willDeletePrices: current.prices.filter((p) => !p.isDemo).length,
      willAddProducts: data.products.length, willAddPrices: data.prices.length, skippedProducts: 0, skippedPrices: 0,
    };
  }
  return {
    mode, willDeleteProducts: 0, willDeletePrices: 0,
    willAddProducts: newProducts.length, willAddPrices: newPrices.length,
    skippedProducts: data.products.length - newProducts.length, skippedPrices: data.prices.length - newPrices.length,
  };
}

/* ------------------------------ CSV ------------------------------ */

/** Escapa uma célula; neutraliza fórmulas (=, +, -, @) para não executarem no Excel. */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[";\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const BASIS_LABEL = { package: 'Embalagem', kg: 'Por kg', l: 'Por litro', un: 'Por unidade' };
const ORIGIN_LABEL = { manual: 'Cadastro manual', scanner: 'Scanner', import: 'Importação' };

export const CSV_HEADER = ['Produto', 'Marca', 'Categoria', 'Embalagem', 'Código de barras', 'Preço (R$)', 'Tipo de preço', 'Promoção', 'Preço anterior (R$)', 'Data e hora', 'Loja', 'Origem', 'Observação'];

/** CSV com ';' (Excel pt-BR), vírgula decimal e BOM UTF-8 para os acentos. */
export function toCsv({ products, prices }) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const rows = [CSV_HEADER.map(csvCell).join(';')];
  const priced = new Set();
  const sorted = [...prices].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  for (const r of sorted) {
    const p = byId.get(r.productId);
    if (!p) continue;
    priced.add(p.id);
    rows.push([
      p.name, p.brand ?? '', p.category ?? '', p.packQty ? formatQuantity(p.packQty, p.packUnit) : '', p.barcode ?? '',
      formatBRL(r.cents, { symbol: false }), BASIS_LABEL[r.basis] ?? r.basis, r.kind === 'promo' ? 'Sim' : 'Não',
      r.previousCents ? formatBRL(r.previousCents, { symbol: false }) : '', r.observedAt, r.store ?? '',
      ORIGIN_LABEL[r.origin] ?? r.origin ?? '', r.note ?? '',
    ].map(csvCell).join(';'));
  }
  for (const p of products) {
    if (priced.has(p.id)) continue;
    rows.push([p.name, p.brand ?? '', p.category ?? '', p.packQty ? formatQuantity(p.packQty, p.packUnit) : '', p.barcode ?? '', '', '', '', '', '', '', '', p.notes ?? ''].map(csvCell).join(';'));
  }
  return `﻿${rows.join('\r\n')}\r\n`;
}
