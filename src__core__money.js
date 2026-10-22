// Dinheiro: todos os valores internos são CENTAVOS INTEIROS (ex.: R$ 1.299,90 = 129990).
// Nunca usamos ponto flutuante para somar, subtrair ou comparar valores monetários.

/** Maior valor aceito: R$ 999.999,99. */
export const MAX_CENTS = 99_999_999;

export function isValidCents(c) {
  return Number.isSafeInteger(c) && c > 0 && c <= MAX_CENTS;
}

/** Formata centavos como "R$ 1.299,90". Aceita negativos ("-R$ 2,00"). */
export function formatBRL(cents, { symbol = true } = {}) {
  if (!Number.isSafeInteger(cents)) return '—';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100);
  const cent = String(abs % 100).padStart(2, '0');
  const grouped = String(reais).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const body = `${grouped},${cent}`;
  return `${neg ? '-' : ''}${symbol ? 'R$ ' : ''}${body}`;
}

/**
 * Interpreta um valor digitado ou reconhecido e devolve centavos.
 * Regras (formato brasileiro):
 *  - vírgula é o separador decimal; ponto agrupa milhares: "1.299,90" -> 129990
 *  - "12,5" vale 12,50; "12,999" é inválido
 *  - sem vírgula: "12.99" (1–2 dígitos após o ponto) é decimal; "1.299" é milhar
 * Retorna { cents, format } ou null se for inválido.
 */
export function parseMoney(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (!s) return null;
  s = s.replace(/^R\s*\$\s*/i, '').replace(/\s+/g, '');
  if (!/^[\d.,]+$/.test(s)) return null;
  if (/^[.,]|[.,]$/.test(s)) return null;

  let reais;
  let cents = '00';
  let format;

  if (s.includes(',')) {
    const parts = s.split(',');
    if (parts.length !== 2) return null;
    const [intPart, decPart] = parts;
    if (!/^\d{1,2}$/.test(decPart)) return null;
    if (!/^\d{1,3}(\.\d{3})+$|^\d+$/.test(intPart)) return null;
    reais = intPart.replace(/\./g, '');
    cents = decPart.padEnd(2, '0');
    format = 'comma';
  } else if (s.includes('.')) {
    if (/^\d+\.\d{1,2}$/.test(s)) {
      const [i, d] = s.split('.');
      reais = i;
      cents = d.padEnd(2, '0');
      format = 'dot-decimal';
    } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
      reais = s.replace(/\./g, '');
      format = 'thousands-dot';
    } else {
      return null;
    }
  } else {
    reais = s;
    format = 'integer';
  }

  if (reais.length > 8) return null;
  const value = Number(reais) * 100 + Number(cents);
  if (!Number.isSafeInteger(value)) return null;
  return { cents: value, format };
}

/** Atalho: devolve só os centavos (ou null). */
export function parseMoneyToCents(input) {
  const r = parseMoney(input);
  return r ? r.cents : null;
}

/** Texto para preencher um campo de preço a partir de centavos: 1299 -> "12,99". */
export function centsToInputString(cents) {
  return Number.isSafeInteger(cents) ? formatBRL(cents, { symbol: false }) : '';
}

/**
 * (cents * numerator) / denominator, arredondado para o centavo mais próximo
 * (metade para cima), usando apenas inteiros.
 */
export function scaleCents(cents, numerator, denominator) {
  if (!Number.isSafeInteger(cents) || !(denominator > 0) || !Number.isFinite(numerator)) return null;
  const n = cents * numerator;
  return Math.floor((2 * n + denominator) / (2 * denominator));
}

/** Diferença absoluta e percentual entre dois valores (percentual com 1 casa, ou null). */
export function diffCents(fromCents, toCents) {
  const abs = toCents - fromCents;
  const pct = fromCents > 0 ? Math.round((abs * 1000) / fromCents) / 10 : null;
  return { abs, pct };
}

/** "12,5%" / "-3,0%" */
export function formatPercent(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—';
  const s = Math.abs(pct).toFixed(1).replace('.', ',');
  return `${pct < 0 ? '-' : pct > 0 ? '+' : ''}${s}%`;
}
