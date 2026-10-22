// Validação de entradas de produto/preço. Nada aqui transforma campo vazio em zero:
// preço vazio significa "sem preço informado" e nenhum registro de preço é criado.
import { parseMoney, isValidCents, MAX_CENTS, formatBRL } from './src__core__money.js';
import { toBaseQty } from './src__core__units.js';
import { validEAN } from './src__core__prices.js';

export const CATEGORIES = [
  'Mercearia', 'Bebidas', 'Padaria', 'Açougue e frios', 'Hortifrúti', 'Laticínios',
  'Congelados', 'Limpeza', 'Higiene e beleza', 'Pet', 'Casa', 'Eletrônicos', 'Outros',
];

export const BASES = [
  { value: 'package', label: 'Preço da embalagem' },
  { value: 'kg', label: 'Preço por kg' },
  { value: 'l', label: 'Preço por litro' },
  { value: 'un', label: 'Preço por unidade' },
];

export const PACK_UNITS = [
  { value: 'g', label: 'g' }, { value: 'kg', label: 'kg' },
  { value: 'ml', label: 'ml' }, { value: 'l', label: 'L' }, { value: 'un', label: 'un' },
];

const str = (v) => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim();

/** Valida só o texto de preço. Retorna { cents } ou { error } ou { empty: true }. */
export function validatePriceText(text) {
  const t = str(text);
  if (!t) return { empty: true };
  const p = parseMoney(t);
  if (!p) return { error: 'Valor inválido. Use o formato 12,99 (vírgula para os centavos).' };
  if (p.cents <= 0) return { error: 'Informe um valor maior que zero.' };
  if (p.cents > MAX_CENTS) return { error: `O valor máximo é ${formatBRL(MAX_CENTS)}.` };
  return { cents: p.cents, format: p.format };
}

/**
 * Valida os dados de cadastro (manual ou vindos do scanner, já revisados pelo usuário).
 * Retorna { ok, errors: {campo: mensagem}, value }.
 */
export function validateProductInput(input, { requirePrice = false } = {}) {
  const errors = {};
  const value = {};

  const name = str(input.name);
  if (!name) errors.name = 'Informe o nome do produto.';
  else if (name.length < 2) errors.name = 'O nome precisa ter pelo menos 2 caracteres.';
  else if (name.length > 120) errors.name = 'O nome pode ter no máximo 120 caracteres.';
  value.name = name;

  const brand = str(input.brand);
  if (brand.length > 60) errors.brand = 'A marca pode ter no máximo 60 caracteres.';
  value.brand = brand;

  const category = str(input.category);
  if (category.length > 40) errors.category = 'A categoria pode ter no máximo 40 caracteres.';
  value.category = category || 'Outros';

  const notes = str(input.notes);
  if (notes.length > 500) errors.notes = 'As observações podem ter no máximo 500 caracteres.';
  value.notes = notes;

  const store = str(input.store);
  if (store.length > 60) errors.store = 'O nome da loja pode ter no máximo 60 caracteres.';
  value.store = store;

  // código de barras (opcional)
  const bc = str(input.barcode).replace(/[\s-]/g, '');
  if (bc) {
    if (!/^\d{8,14}$/.test(bc)) errors.barcode = 'O código de barras deve ter de 8 a 14 números.';
    else value.barcodeChecksumOk = validEAN(bc);
  }
  value.barcode = bc || null;

  // embalagem (opcional, mas quantidade e unidade andam juntas)
  const amount = str(input.packAmount);
  const unit = str(input.packUnit);
  if (amount || (input.packQty && !amount)) {
    if (input.packQty && !amount && Number.isSafeInteger(input.packQty)) {
      value.packQty = input.packQty; value.packUnit = str(input.packUnit) || null;
    } else {
      const q = toBaseQty(amount, unit || 'g');
      if (!q || !['mass', 'volume', 'count'].includes(q.kind)) errors.packAmount = 'Medida inválida. Exemplo: 500 g, 1,5 L, 12 un.';
      else { value.packQty = q.qty; value.packUnit = q.unit; }
    }
  } else {
    value.packQty = null; value.packUnit = null;
  }

  // preço (opcional por padrão)
  const price = validatePriceText(input.price);
  if (price.error) errors.price = price.error;
  else if (price.empty) {
    value.cents = null;
    if (requirePrice) errors.price = 'Informe o preço.';
  } else value.cents = price.cents;

  const basis = str(input.basis) || 'package';
  if (!BASES.some((b) => b.value === basis)) errors.basis = 'Tipo de preço inválido.';
  value.basis = basis;

  const kind = str(input.kind) || 'regular';
  value.kind = kind === 'promo' ? 'promo' : 'regular';

  if (str(input.previousPrice)) {
    const prev = validatePriceText(input.previousPrice);
    if (prev.error) errors.previousPrice = prev.error;
    else if (value.cents !== null && prev.cents <= value.cents) errors.previousPrice = 'O preço anterior deve ser maior que o preço atual.';
    else value.previousCents = prev.cents;
  }
  value.previousCents = value.previousCents ?? null;

  return { ok: Object.keys(errors).length === 0, errors, value };
}

export function isValidPriceRecord(r) {
  return !!r && typeof r.id === 'string' && typeof r.productId === 'string'
    && isValidCents(r.cents) && ['package', 'kg', 'l', 'un'].includes(r.basis)
    && typeof r.observedAt === 'string' && !Number.isNaN(Date.parse(r.observedAt));
}
