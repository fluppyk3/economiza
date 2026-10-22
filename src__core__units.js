// Unidades de medida: reconhecimento em texto, conversão para unidade-base inteira
// (g, ml, un, mm) e cálculo de preço por quilo / litro / unidade.
import { scaleCents } from './src__core__money.js';

/** unidade canônica -> { kind, factor para a unidade-base inteira, base } */
const UNITS = {
  kg: { kind: 'mass', base: 'g', factor: 1000 },
  g: { kind: 'mass', base: 'g', factor: 1 },
  mg: { kind: 'mass', base: 'g', factor: 0.001 },
  l: { kind: 'volume', base: 'ml', factor: 1000 },
  ml: { kind: 'volume', base: 'ml', factor: 1 },
  cl: { kind: 'volume', base: 'ml', factor: 10 },
  un: { kind: 'count', base: 'un', factor: 1 },
  dz: { kind: 'count', base: 'un', factor: 12 },
  m: { kind: 'length', base: 'mm', factor: 1000 },
  cm: { kind: 'length', base: 'mm', factor: 10 },
  mm: { kind: 'length', base: 'mm', factor: 1 },
};

const ALIASES = [
  ['kg', ['kg', 'kgs', 'quilo', 'quilos', 'quilograma', 'quilogramas', 'kilo', 'kilos']],
  ['g', ['g', 'gr', 'grs', 'grama', 'gramas']],
  ['mg', ['mg']],
  ['l', ['l', 'lt', 'lts', 'litro', 'litros']],
  ['ml', ['ml', 'mls']],
  ['cl', ['cl']],
  ['un', ['un', 'und', 'unid', 'unids', 'unidade', 'unidades', 'pç', 'pc', 'pcs', 'peça', 'peças', 'peca', 'pecas']],
  ['dz', ['dz', 'dúzia', 'duzia', 'dúzias', 'duzias']],
  ['m', ['m', 'mt', 'mts', 'metro', 'metros']],
  ['cm', ['cm']],
  ['mm', ['mm']],
];

const ALIAS_MAP = new Map();
for (const [canon, list] of ALIASES) for (const a of list) ALIAS_MAP.set(a.toLowerCase(), canon);
const UNIT_ALT = [...ALIAS_MAP.keys()].sort((a, b) => b.length - a.length).join('|');

/** Canonicaliza "KGS", "Litros", "gr" etc. Retorna null se não for unidade. */
export function canonicalUnit(raw) {
  return ALIAS_MAP.get(String(raw ?? '').trim().toLowerCase()) ?? null;
}

export function unitInfo(canon) {
  return UNITS[canon] ?? null;
}

/**
 * Converte um número em texto + unidade para quantidade na unidade-base inteira.
 * "1,5" kg -> 1500 g ; "350" ml -> 350 ; "1.500" g -> 1500 g.
 */
export function toBaseQty(amountText, unitRaw) {
  const canon = canonicalUnit(unitRaw);
  const info = canon && UNITS[canon];
  if (!info) return null;
  let s = String(amountText).trim();
  if (!/^\d+([.,]\d+)?$/.test(s)) return null;
  // Ponto seguido de exatamente 3 dígitos em g/ml/un = separador de milhar ("1.500 g").
  if (/^\d{1,3}\.\d{3}$/.test(s) && info.factor === 1) s = s.replace('.', '');
  const num = Number(s.replace(',', '.'));
  if (!Number.isFinite(num) || num <= 0) return null;
  const base = Math.round(num * info.factor);
  if (!Number.isSafeInteger(base) || base <= 0) return null;
  return { qty: base, unit: info.base, kind: info.kind, canon };
}

/**
 * Procura medidas no texto: "500 g", "5 KG", "1,5L", "12 x 350 ml", "c/12".
 * Cada item traz posição para que o módulo de preços ignore esses números.
 */
export function findMeasures(text) {
  const out = [];
  const s = String(text ?? '');

  // multiplicador: 12 x 350 ml
  const multi = new RegExp(`(?<![\\p{L}\\d.,])(\\d{1,3})\\s*[xX×]\\s*(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_ALT})(?![\\p{L}\\d])`, 'giu');
  const taken = [];
  for (const m of s.matchAll(multi)) {
    const each = toBaseQty(m[2], m[3]);
    const count = Number(m[1]);
    if (!each || !(count > 0)) continue;
    out.push({
      start: m.index, end: m.index + m[0].length, raw: m[0], unit: each.canon, kind: each.kind,
      baseUnit: each.unit, baseQty: each.qty * count, count, eachQty: each.qty, multipack: true,
    });
    taken.push([m.index, m.index + m[0].length]);
  }

  const re = new RegExp(`(?<![\\p{L}\\d.,])(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_ALT})(?![\\p{L}\\d])`, 'giu');
  for (const m of s.matchAll(re)) {
    const start = m.index;
    const end = start + m[0].length;
    if (taken.some(([a, b]) => start < b && end > a)) continue;
    const q = toBaseQty(m[1], m[2]);
    out.push({
      start, end, raw: m[0], amountText: m[1], unit: q ? q.canon : canonicalUnit(m[2]),
      kind: q ? q.kind : (unitInfo(canonicalUnit(m[2]))?.kind ?? 'unknown'),
      baseUnit: q ? q.unit : null, baseQty: q ? q.qty : null,
    });
  }

  // OCR costuma ler "1 L" como "IL" (letra I no lugar do algarismo 1). Aceito só em maiúsculas,
  // sem espaço e com unidade L/ML/KG; o resultado é marcado para o usuário confirmar.
  const confused = /(?<![\p{L}\d.,])[Il|](L|ML|KG)(?![\p{L}\d])/gu;
  for (const m of s.matchAll(confused)) {
    const start = m.index; const end = start + m[0].length;
    if (out.some((o) => start < o.end && end > o.start)) continue;
    const q = toBaseQty('1', m[1]);
    if (!q) continue;
    out.push({ start, end, raw: m[0], amountText: '1', unit: q.canon, kind: q.kind, baseUnit: q.unit, baseQty: q.qty, ocrFixed: true });
  }

  // "c/12", "cx c/ 24", "com 6 un" -> contagem
  const pack = /(?<![\p{L}\d])(?:c\/|c\s*\/\s*|cx\s*c\/?\s*)\s*(\d{1,3})(?![\d,.]|\s*(?:kg|g|ml|l)\b)/giu;
  for (const m of s.matchAll(pack)) {
    const start = m.index;
    const end = start + m[0].length;
    if (out.some((o) => start < o.end && end > o.start)) continue;
    out.push({
      start, end, raw: m[0], unit: 'un', kind: 'count', baseUnit: 'un', baseQty: Number(m[1]), pack: true,
    });
  }

  return out.sort((a, b) => a.start - b.start);
}

/** "500 g", "1,5 kg", "2 L", "350 ml", "12 un". */
export function formatQuantity(qty, baseUnit) {
  if (!Number.isSafeInteger(qty) || qty <= 0) return '';
  const trim = (n) => String(n).replace('.', ',');
  if (baseUnit === 'g') {
    return qty >= 1000 ? `${trim(qty / 1000)} kg` : `${qty} g`;
  }
  if (baseUnit === 'ml') {
    return qty >= 1000 ? `${trim(qty / 1000)} L` : `${qty} ml`;
  }
  if (baseUnit === 'un') return `${qty} un`;
  if (baseUnit === 'mm') return qty >= 1000 ? `${trim(qty / 1000)} m` : `${qty / 10} cm`;
  return '';
}

/** Para preencher o formulário: 1500 g -> { amount: "1,5", unit: "kg" }. */
export function qtyToForm(qty, baseUnit) {
  if (!Number.isSafeInteger(qty) || qty <= 0) return { amount: '', unit: baseUnit === 'ml' ? 'ml' : baseUnit === 'un' ? 'un' : 'g' };
  const trim = (n) => String(n).replace('.', ',');
  if (baseUnit === 'g' && qty >= 1000) return { amount: trim(qty / 1000), unit: 'kg' };
  if (baseUnit === 'ml' && qty >= 1000) return { amount: trim(qty / 1000), unit: 'l' };
  return { amount: String(qty), unit: baseUnit };
}

/**
 * Preço por quilo / litro / unidade a partir do preço da embalagem.
 * Retorna { cents, per: 'kg'|'l'|'un' } ou null.
 */
export function unitPriceFromPackage(priceCents, qty, baseUnit) {
  if (!Number.isSafeInteger(priceCents) || !Number.isSafeInteger(qty) || qty <= 0) return null;
  if (baseUnit === 'g') return { cents: scaleCents(priceCents, 1000, qty), per: 'kg' };
  if (baseUnit === 'ml') return { cents: scaleCents(priceCents, 1000, qty), per: 'l' };
  if (baseUnit === 'un') return { cents: priceCents, per: 'un', qty };
  return null;
}

/** Preço da embalagem esperado a partir do preço por kg/L e da quantidade (verificação cruzada). */
export function packagePriceFromUnit(unitCents, per, qty, baseUnit) {
  if (!Number.isSafeInteger(unitCents) || !Number.isSafeInteger(qty) || qty <= 0) return null;
  if ((per === 'kg' && baseUnit === 'g') || (per === 'l' && baseUnit === 'ml')) return scaleCents(unitCents, qty, 1000);
  return null;
}

/** Base de comparação de uma quantidade: 'kg' | 'l' | 'un' | null. */
export function comparisonBasis(baseUnit) {
  if (baseUnit === 'g') return 'kg';
  if (baseUnit === 'ml') return 'l';
  if (baseUnit === 'un') return 'un';
  return null;
}

export const PRICE_BASIS_LABEL = {
  package: 'por embalagem',
  kg: 'por kg',
  l: 'por litro',
  un: 'por unidade',
};

/** Reconhece o sufixo/prefixo de base do preço: "kg", "quilo", "litro", "un", "100g". */
export function basisFromWord(word) {
  const c = canonicalUnit(String(word).replace(/\s+/g, ''));
  if (c === 'kg') return 'kg';
  if (c === 'l') return 'l';
  if (c === 'un') return 'un';
  if (c === 'g') return 'g';
  if (c === 'ml') return 'ml';
  return null;
}
