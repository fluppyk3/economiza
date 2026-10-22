// Comparação de preços. Nunca compara cegamente: embalagens/unidades diferentes só são
// comparadas quando existe conversão segura (por kg, por litro ou por unidade).
import { diffCents } from './src__core__money.js';
import { unitPriceFromPackage, formatQuantity } from './src__core__units.js';

export const DEFAULT_STALE_DAYS = 30;

export function daysBetween(fromIso, toIso) {
  return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

export function isStale(observedAt, nowIso, staleDays = DEFAULT_STALE_DAYS) {
  const d = daysBetween(observedAt, nowIso);
  return Number.isFinite(d) && d > staleDays;
}

/**
 * Preço normalizado (por kg, L ou un) de um registro, ou null quando não for possível.
 * record: { cents, basis, packQty?, packUnit? }; product pode fornecer a embalagem.
 */
export function normalizedPrice(record, product = null) {
  if (!record) return null;
  if (record.basis === 'kg' || record.basis === 'l' || record.basis === 'un') {
    return { cents: record.cents, per: record.basis };
  }
  const qty = record.packQty ?? product?.packQty;
  const unit = record.packUnit ?? product?.packUnit;
  if (!qty || !unit) return null;
  const u = unitPriceFromPackage(record.cents, qty, unit);
  return u ? { cents: u.cents, per: u.per } : null;
}

/**
 * Compara os registros de UM produto. Só compara valores equivalentes:
 * mesma base e mesma embalagem, ou conversão segura para preço por kg/L/un.
 */
export function compareRecords(records, product = null, { now = new Date().toISOString(), staleDays = DEFAULT_STALE_DAYS } = {}) {
  const items = records.map((r) => ({
    ...r,
    stale: isStale(r.observedAt, now, staleDays),
    normalized: normalizedPrice(r, product),
  }));
  if (items.length < 2) {
    return { comparable: false, reason: 'É preciso ter pelo menos dois preços registrados para comparar.', items };
  }

  // 1) valores idênticos em tipo e embalagem
  const sameKind = (a, b) => a.basis === b.basis && (a.basis !== 'package' || ((a.packQty ?? product?.packQty ?? null) === (b.packQty ?? product?.packQty ?? null) && (a.packUnit ?? product?.packUnit ?? null) === (b.packUnit ?? product?.packUnit ?? null)));
  let group = items;
  let per = null;
  let label = items[0].basis === 'package' ? 'embalagem' : items[0].basis;
  if (!items.every((r) => sameKind(r, items[0]))) {
    // 2) tentar por kg/L/un
    const norm = items.filter((r) => r.normalized);
    const pers = new Set(norm.map((r) => r.normalized.per));
    if (norm.length >= 2 && pers.size === 1) {
      group = norm; per = [...pers][0]; label = `por ${per === 'kg' ? 'kg' : per === 'l' ? 'litro' : 'unidade'} (convertido)`;
    } else {
      return { comparable: false, reason: 'Os registros têm embalagens ou unidades diferentes e não dá para converter com segurança.', items };
    }
  } else if (items[0].basis === 'package') {
    const q = items[0].packQty ?? product?.packQty;
    const u = items[0].packUnit ?? product?.packUnit;
    label = q && u ? `embalagem de ${formatQuantity(q, u)}` : 'embalagem';
  } else {
    per = items[0].basis;
    label = `por ${per === 'kg' ? 'kg' : per === 'l' ? 'litro' : 'unidade'}`;
  }

  const value = (r) => (per && r.normalized ? r.normalized.cents : r.cents);
  const sorted = [...group].sort((a, b) => value(a) - value(b) || Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const d = diffCents(value(min), value(max));
  return {
    comparable: true, label, per,
    min: { ...min, value: value(min) }, max: { ...max, value: value(max) },
    diffAbs: d.abs, diffPct: d.pct, items: group, sameValue: d.abs === 0,
    staleCount: group.filter((r) => r.stale).length,
  };
}

/**
 * Compara PRODUTOS diferentes pelo preço mais recente, em base equivalente (kg/L/un).
 * entries: [{ product, price }]  (price = registro mais recente do produto)
 */
export function compareProducts(entries, { now = new Date().toISOString(), staleDays = DEFAULT_STALE_DAYS } = {}) {
  const rows = [];
  const excluded = [];
  for (const { product, price } of entries) {
    if (!price) { excluded.push({ product, reason: 'Sem preço registrado.' }); continue; }
    const n = normalizedPrice(price, product);
    if (!n) { excluded.push({ product, reason: 'Sem a medida da embalagem (g, ml, un) não é possível converter para preço por kg/L/un.' }); continue; }
    rows.push({ product, price, per: n.per, value: n.cents, stale: isStale(price.observedAt, now, staleDays) });
  }
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.per)) groups.set(r.per, []);
    groups.get(r.per).push(r);
  }
  const out = [];
  for (const [per, list] of groups) {
    list.sort((a, b) => a.value - b.value);
    const base = list[0].value;
    out.push({
      per,
      rows: list.map((r) => ({ ...r, diffAbs: r.value - base, diffPct: diffCents(base, r.value).pct })),
      cheapest: list[0],
      comparable: list.length >= 2,
    });
  }
  return { groups: out, excluded, mixed: out.length > 1 };
}

/** Última variação de preço de um produto (mesma base e embalagem). */
export function lastChange(records) {
  const sorted = [...records].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  if (sorted.length < 2) return null;
  const [cur, ...rest] = sorted;
  const prev = rest.find((r) => r.basis === cur.basis && (r.packQty ?? null) === (cur.packQty ?? null) && (r.packUnit ?? null) === (cur.packUnit ?? null));
  if (!prev || prev.cents === cur.cents) return null;
  const d = diffCents(prev.cents, cur.cents);
  return { from: prev, to: cur, abs: d.abs, pct: d.pct, direction: d.abs > 0 ? 'up' : 'down' };
}
