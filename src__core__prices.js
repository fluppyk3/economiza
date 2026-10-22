// Extração e classificação de valores monetários em texto de etiquetas.
//
// Princípios:
//  * nunca escolher "o primeiro número" nem "o menor preço";
//  * números isolados (500, 5, 7891234567890) NÃO são preço;
//  * quando o contexto não basta, devolver as alternativas e deixar o usuário decidir;
//  * todo valor é CENTAVOS INTEIROS.
import { normalizeOcrText } from './src__core__text.js';
import { parseMoney, isValidCents, formatBRL } from './src__core__money.js';
import { findMeasures, packagePriceFromUnit, canonicalUnit } from './src__core__units.js';

export const LEVEL = { OK: 'confiavel', DOUBT: 'duvidoso', BAD: 'invalido' };
export const THRESHOLD_OK = 0.72;
export const THRESHOLD_DOUBT = 0.4;

export function levelFromScore(score) {
  const s = Math.round(score * 100) / 100; // evita 0,3999999 virar "inválido"
  if (s >= THRESHOLD_OK) return LEVEL.OK;
  if (s >= THRESHOLD_DOUBT) return LEVEL.DOUBT;
  return LEVEL.BAD;
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/* ------------------------------------------------------------------ */
/* Código de barras                                                    */
/* ------------------------------------------------------------------ */

/** Valida dígito verificador de EAN-8, UPC-A (12), EAN-13 e GTIN-14. */
export function validEAN(digits) {
  if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) return false;
  const nums = digits.split('').map(Number);
  const check = nums.pop();
  let sum = 0;
  nums.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

/* ------------------------------------------------------------------ */
/* Palavras-chave                                                      */
/* ------------------------------------------------------------------ */

// adj: a palavra precisa estar colada ao preço (sem outras palavras no meio).
const KEYWORDS = [
  { role: 'previous', adj: true, re: /(?<![\p{L}\d])(?:de|era|antes)(?![\p{L}\d])/giu, label: 'DE' },
  { role: 'promo', adj: true, re: /(?<![\p{L}\d])(?:por|agora|s[oó]|somente|apenas)(?![\p{L}\d])/giu, label: 'POR' },
  { role: 'previous', re: /(?<![\p{L}\d])(?:pre[cç]o|valor)\s+(?:normal|anterior|antigo|original|cheio|regular|de\s+tabela|sem\s+desconto)(?![\p{L}\d])/giu, label: 'PREÇO NORMAL' },
  { role: 'previous', adj: true, re: /(?<![\p{L}\d])normal\s*:/giu, label: 'NORMAL' },
  { role: 'promo', re: /(?<![\p{L}\d])(?:oferta|ofertas|promo|promo[cç][aã]o|promocional|desconto|liquida[cç][aã]o|queima|pre[cç]o\s+(?:especial|promocional|oferta))(?![\p{L}\d])/giu, label: 'OFERTA' },
  { role: 'cash', re: /(?<![\p{L}\d])(?:[àa]\s*vista|no\s+pix|pix|no\s+dinheiro)(?![\p{L}\d])/giu, label: 'À VISTA' },
  { role: 'installment', re: /(?<![\p{L}\d])(?:parcel\w*|sem\s+juros|em\s+at[eé]|no\s+cart[aã]o|cr[eé]dito|mensais?)(?![\p{L}\d])/giu, label: 'PARCELADO' },
];

/** Palavras que, sozinhas numa linha, não são nome de produto. */
export const LABEL_NOISE = /(?<![\p{L}\d])(?:oferta|ofertas|promo|promo[cç][aã]o|promocional|desconto|liquida[cç][aã]o|queima|pre[cç]o|valor|normal|anterior|original|[àa]\s*vista|pix|parcelado|parcelas?|sem\s+juros|em\s+at[eé]|c[oó]digo|c[oó]d|ref|sku|plu|validade|val|fab|fabrica[cç][aã]o|lote|venc|vencimento|unidade|kg|total|cada|aproveite|loja|mercado|supermercado)(?![\p{L}\d])/giu;

function findKeywords(text) {
  const out = [];
  for (const k of KEYWORDS) {
    for (const m of text.matchAll(k.re)) {
      out.push({ role: k.role, adj: !!k.adj, start: m.index, end: m.index + m[0].length, raw: m[0], label: k.label });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ */
/* Varredura de uma linha                                              */
/* ------------------------------------------------------------------ */

const MASK_PATTERNS = [
  ['cnpj', /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g],
  ['cpf', /\d{3}\.\d{3}\.\d{3}-\d{2}/g],
  ['telefone', /(?:\(\d{2}\)\s?)?(?<!\d)\d{4,5}-\d{4}(?!\d)/g],
  ['data', /(?<!\d)\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(?!\d)/g],
  ['data', /(?<![\d,.])\d{1,2}\/\d{2,4}(?![\d,])/g],
  ['hora', /(?<!\d)\d{1,2}(?::|h)\d{2}(?!\d)/gi],
  ['percentual', /\d+(?:[.,]\d+)?\s*%/g],
];

const DATE_CONTEXT = /(?:val(?:idade)?|fab(?:rica[cç][aã]o)?|venc(?:imento)?|lote|data)\.?\s*:?\s*[\d./-]+/giu;

function overlaps(a, b) { return a.start < b.end && a.end > b.start; }

const LOOKALIKE = { O: '0', o: '0', l: '1', I: '1', '|': '1' };

/** Troca O/l/I por 0/1 apenas logo depois de "R$" (mesmo tamanho: posições preservadas). */
function repairLookalikes(text) {
  const repaired = [];
  const out = text.replace(/(R\$\s*)([0-9OolI|]{1,6}[,.][0-9OolI|]{2})(?![\p{L}\d])/gu, (m, pre, num, offset) => {
    if (!/\d/.test(num) || !/[OolI|]/.test(num)) return m;
    const fixed = num.replace(/[OolI|]/g, (c) => LOOKALIKE[c]);
    repaired.push([offset + pre.length, offset + pre.length + num.length]);
    return pre + fixed;
  });
  return { text: out, repaired };
}

/**
 * Varre UMA linha de texto e devolve candidatos a preço, números rejeitados,
 * medidas, códigos de barras e palavras-chave — tudo com posições.
 */
export function scanLine(input, lineIndex = 0) {
  const line = typeof input === 'string' ? { text: input } : input;
  const { text: n0, changes } = normalizeOcrText(line.text ?? '');
  const { text: norm, repaired } = repairLookalikes(n0);

  const masks = [];
  for (const [kind, re] of MASK_PATTERNS) {
    for (const m of norm.matchAll(re)) masks.push({ kind, start: m.index, end: m.index + m[0].length });
  }
  for (const m of norm.matchAll(DATE_CONTEXT)) masks.push({ kind: 'data', start: m.index, end: m.index + m[0].length });

  // Códigos de barras: sequências de 8+ dígitos, ou grupos de dígitos separados por espaço (EAN impresso).
  const barcodes = [];
  for (const m of norm.matchAll(/(?<![\d,.])\d{8,}(?![\d,.]\d)/g)) {
    barcodes.push({ digits: m[0], valid: validEAN(m[0]), start: m.index, end: m.index + m[0].length });
  }
  for (const m of norm.matchAll(/(?<![\d,.])\d{1,4}(?:[ -]\d{3,7}){2,}(?![\d,.]\d)/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 8 && !barcodes.some((b) => overlaps(b, { start: m.index, end: m.index + m[0].length }))) {
      barcodes.push({ digits, valid: validEAN(digits), start: m.index, end: m.index + m[0].length, spaced: true });
    }
  }
  for (const b of barcodes) masks.push({ kind: 'codigo', start: b.start, end: b.end });

  const measures = findMeasures(norm);
  const keywords = findKeywords(norm);

  const candidates = [];
  const rejected = [];
  const consumed = []; // faixas já usadas por candidatos (evita contar a mesma ocorrência duas vezes)

  const tokenRe = /\d[\d.,]*\d|\d/g;
  const tokens = [...norm.matchAll(tokenRe)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));

  for (let ti = 0; ti < tokens.length; ti++) {
    const tk = tokens[ti];
    const span = { start: tk.start, end: tk.end };

    // moeda imediatamente antes?
    const beforeText = norm.slice(0, tk.start);
    const cur = /R\$\s{0,2}$/.exec(beforeText);
    const hasCurrency = !!cur;
    const fullStart = cur ? tk.start - cur[0].length : tk.start;

    const maskHit = masks.find((mk) => overlaps(mk, span));
    if (maskHit) {
      rejected.push({ raw: tk.text, reason: maskHit.kind, lineIndex, start: tk.start });
      continue;
    }
    const measureHit = measures.find((mm) => overlaps(mm, span));
    if (measureHit && !hasCurrency) {
      rejected.push({ raw: tk.text, reason: 'medida', lineIndex, start: tk.start });
      continue;
    }

    // vírgula/ponto final colado ao token é pontuação, não parte do número
    let text = tk.text;
    const flags = [];
    let format;
    let cents = null;
    let end = tk.end;

    if (/^\d{1,3}(\.\d{3})*,\d{2}$/.test(text) || /^\d+,\d{2}$/.test(text)) {
      const p = parseMoney(text);
      cents = p ? p.cents : null; format = 'comma';
      if (/^\d{4,},\d{2}$/.test(text)) flags.push('semMilhar');
    } else if (/^\d{1,3}(\.\d{3})*,\d$/.test(text) || /^\d+,\d$/.test(text)) {
      if (!hasCurrency) { rejected.push({ raw: text, reason: 'uma-casa-decimal', lineIndex, start: tk.start }); continue; }
      const p = parseMoney(text);
      cents = p ? p.cents : null; format = 'comma'; flags.push('umaCasa');
    } else if (/^\d+\.\d{2}$/.test(text)) {
      const p = parseMoney(text);
      cents = p ? p.cents : null; format = 'dot'; flags.push('pontoDecimal');
    } else if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
      if (!hasCurrency) { rejected.push({ raw: text, reason: 'milhar-sem-moeda', lineIndex, start: tk.start }); continue; }
      const p = parseMoney(text);
      cents = p ? p.cents : null; format = 'integer'; flags.push('semCentavos');
    } else if (/^\d+$/.test(text)) {
      if (text.length >= 8) { rejected.push({ raw: text, reason: 'codigo', lineIndex, start: tk.start }); continue; }
      if (!hasCurrency) { rejected.push({ raw: text, reason: 'numero-isolado', lineIndex, start: tk.start }); continue; }
      // "R$ 12 99": inteiro grande + centavos pequenos separados
      const next = tokens[ti + 1];
      const gap = next ? norm.slice(tk.end, next.start) : null;
      if (next && /^\d{2}$/.test(next.text) && /^ {1,2}$/.test(gap)
          && !measures.some((mm) => overlaps(mm, next))
          && !masks.some((mk) => overlaps(mk, next))) {
        cents = Number(text) * 100 + Number(next.text);
        format = 'split'; flags.push('centavosSeparados');
        end = next.end;
        ti++;
      } else {
        cents = Number(text) * 100; format = 'integer'; flags.push('semCentavos');
      }
    } else {
      rejected.push({ raw: text, reason: 'formato-invalido', lineIndex, start: tk.start });
      continue;
    }

    if (!isValidCents(cents)) {
      rejected.push({ raw: text, reason: cents === 0 ? 'zero' : 'fora-da-faixa', lineIndex, start: tk.start });
      continue;
    }
    if (cents < 10) flags.push('valorMuitoBaixo');
    if (cents > 5_000_000) flags.push('valorMuitoAlto');
    if (repaired.some(([a, b]) => tk.start >= a && tk.end <= b)) flags.push('corrigidoOCR');
    if (changes.includes('moeda') && hasCurrency) flags.push('moedaCorrigida');

    const range = { start: fullStart, end };
    if (consumed.some((c) => overlaps(c, range))) continue; // mesma ocorrência já contada
    consumed.push(range);

    candidates.push({
      id: `p${lineIndex}_${range.start}`,
      lineIndex, start: range.start, end: range.end,
      raw: norm.slice(range.start, range.end), numberText: text,
      cents, hasCurrency, format, flags,
      role: 'regular', basis: 'package', basisFrom: null,
      keywords: [], installments: null, occurrences: 1,
    });
  }

  candidates.sort((a, b) => a.start - b.start);

  // --- contexto de cada candidato: o que vem antes/depois, base (kg/L/un), parcelamento, palavra-chave ---
  candidates.forEach((c, i) => {
    const prevEnd = i > 0 ? candidates[i - 1].end : 0;
    const nextStart = i < candidates.length - 1 ? candidates[i + 1].start : norm.length;
    const before = norm.slice(prevEnd, c.start);
    const after = norm.slice(c.end, nextStart);
    c.before = before.slice(-60);
    c.after = after.slice(0, 40);

    // base do preço: sufixo "/KG", "POR LITRO", "KG" (com R$); prefixo "R$/KG", "PREÇO POR KG"
    const suf = /^\s*(\/\s*|-\s*|por\s+|p\/\s*|a\s+|o\s+)?(100\s?g|kg|quilos?|litros?|lts?|l|unidade|unid|und|un)(?![\p{L}\d])/iu.exec(after);
    if (suf) {
      const word = suf[2].toLowerCase().replace(/\s+/g, '');
      const explicit = !!suf[1];
      const isL = /^(l|lt|lts|litro|litros)$/.test(word);
      const isKg = /^(kg|quilo|quilos)$/.test(word);
      const isUn = /^(un|und|unid|unidade)$/.test(word);
      const is100 = word === '100g';
      if ((explicit || c.hasCurrency) && (isKg || isL || isUn || is100)) {
        if (is100) { c.cents *= 10; c.basis = 'kg'; c.flags.push('por100g'); }
        else c.basis = isKg ? 'kg' : isL ? 'l' : 'un';
        c.basisFrom = explicit ? 'sufixo' : 'unidadeColada';
        c.end += suf[0].length;
        c.raw = norm.slice(c.start, c.end);
      }
    }
    if (c.basis === 'package') {
      const pre = /(?:R\$\s*\/\s*|pre[cç]o\s+(?:por|p\/|do|da)?\s*|valor\s+(?:por|p\/|do|da)?\s*|(?<![\p{L}\d])(?:por|p\/)\s+)(kg|quilo|litro|lt|l|unidade|un)\s*[:=-]?\s*(?:R\$\s*)?$/iu.exec(before);
      if (pre && !measures.some((mm) => mm.end >= c.start - 12 && mm.start <= c.start && /\d/.test(mm.raw))) {
        const w = pre[1].toLowerCase();
        c.basis = /^(l|lt|litro)$/.test(w) ? 'l' : /^(un|unidade)$/.test(w) ? 'un' : 'kg';
        c.basisFrom = 'prefixo';
      } else {
        const pre2 = /R\$\s*\/\s*(kg|l|un)\s*:?\s*$/iu.exec(norm.slice(0, c.start + 0));
        if (pre2) { c.basis = canonicalUnit(pre2[1]) === 'l' ? 'l' : canonicalUnit(pre2[1]) === 'un' ? 'un' : 'kg'; c.basisFrom = 'prefixo'; }
      }
    }

    // parcelamento: "10x R$ 1,99", "3 X DE 33,30"
    const instMatch = /(\d{1,2})\s*[xX×]\s*(?:de\s+)?$/iu.exec(norm.slice(0, c.start));
    if (instMatch && Number(instMatch[1]) >= 2 && Number(instMatch[1]) <= 24) {
      c.installments = { count: Number(instMatch[1]), total: Number(instMatch[1]) * c.cents };
      c.role = 'installment';
      c.keywords.push(`${instMatch[1]}x`);
    }

    // palavra-chave mais próxima ANTES do valor (depois do candidato anterior)
    const kwBefore = keywords
      .filter((k) => k.end <= c.start && k.start >= prevEnd)
      .filter((k) => {
        if (!k.adj) return c.start - k.end <= 45;
        const between = norm.slice(k.end, c.start).replace(/R\$|[\s:.\-–—]/g, '');
        return between.length === 0;
      })
      .pop();
    if (kwBefore && c.role !== 'installment') { c.role = kwBefore.role; c.keywords.push(kwBefore.label); }
    else if (kwBefore && kwBefore.role === 'installment') c.keywords.push(kwBefore.label);

    // palavra-chave logo DEPOIS (só as fortes): "12,99 À VISTA", "9,99 PROMOÇÃO"
    if (c.role === 'regular') {
      const kwAfter = keywords
        .filter((k) => k.start >= c.end && k.start < nextStart && ['cash', 'promo', 'previous', 'installment'].includes(k.role))
        .filter((k) => !k.adj && k.start - c.end <= 14)[0];
      if (kwAfter) {
        if (kwAfter.role === 'installment') { c.role = 'installment'; }
        else c.role = kwAfter.role;
        c.keywords.push(kwAfter.label);
      }
    }
    if (c.role === 'regular' && /parcel|sem\s+juros|cart[aã]o/i.test(before)) { c.role = 'installment'; c.keywords.push('PARCELADO'); }
  });

  // confiança do OCR nas palavras que contêm o número
  const ocrConf = lineOcrConfidence(line, candidates);
  candidates.forEach((c, i) => { c.ocrConfidence = ocrConf[i]; });

  const keywordOnly = candidates.length === 0 && keywords.length > 0;
  return {
    index: lineIndex, raw: line.text ?? '', text: norm, normalizeChanges: changes,
    confidence: typeof line.confidence === 'number' ? line.confidence : null,
    bbox: line.bbox ?? null, words: line.words ?? null,
    height: line.bbox ? Math.max(1, line.bbox.y1 - line.bbox.y0) : null,
    candidates, rejected, measures, barcodes, keywords, masks, keywordOnly,
  };
}

function lineOcrConfidence(line, candidates) {
  const words = Array.isArray(line.words) ? line.words : null;
  return candidates.map((c) => {
    if (words) {
      const digitsOnly = c.numberText.replace(/\D/g, '');
      const hits = words.filter((w) => {
        const wd = String(w.text ?? '').replace(/\D/g, '');
        return wd.length > 0 && (digitsOnly.includes(wd) || wd.includes(digitsOnly)) && typeof w.confidence === 'number';
      });
      if (hits.length) return Math.min(...hits.map((w) => w.confidence)) / 100;
    }
    return typeof line.confidence === 'number' ? line.confidence / 100 : null;
  });
}

/* ------------------------------------------------------------------ */
/* Análise entre linhas                                                */
/* ------------------------------------------------------------------ */

function median(arr) {
  const a = arr.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Cabeçalho "OFERTA" numa linha sem preço vale para o primeiro preço da linha seguinte (ou o mais próximo no espaço). */
function applyHeaderKeywords(lines) {
  lines.forEach((ln, i) => {
    const targets = ln.candidates.filter((c) => c.role === 'regular' && c.keywords.length === 0);
    if (!targets.length) return;
    // 1) palavra-chave na linha anterior sem preços
    const prev = lines[i - 1];
    let header = null;
    if (prev && prev.keywordOnly) header = prev;
    // 2) por geometria: linha-cabeçalho logo acima, alinhada à esquerda do valor
    if (!header && ln.bbox) {
      const lh = ln.height || 20;
      header = lines.find((o) => o !== ln && o.keywordOnly && o.bbox
        && o.bbox.y1 <= ln.bbox.y0 + lh * 0.3 && ln.bbox.y0 - o.bbox.y1 <= lh * 2.2
        && o.bbox.x0 <= ln.bbox.x1 && o.bbox.x1 >= ln.bbox.x0) ?? null;
    }
    if (!header) return;
    const kw = header.keywords.filter((k) => !k.adj || ['previous', 'promo'].includes(k.role)).pop();
    if (!kw) return;
    const t = targets[0];
    if (kw.role === 'installment') { t.role = 'installment'; }
    else t.role = kw.role;
    t.keywords.push(`${kw.label} (linha acima)`);
    t.flags.push('palavraNaLinhaAcima');
  });
}

/**
 * Analisa todas as linhas: classifica papéis, descarta duplicatas da mesma ocorrência,
 * escolhe o preço principal (ou nenhum, se houver ambiguidade) e as alternativas.
 */
export function analyzePrices(inputLines, opts = {}) {
  const lines = inputLines.map((l, i) => (l && l.candidates ? l : scanLine(l, i)));
  applyHeaderKeywords(lines);

  const all = lines.flatMap((l) => l.candidates);
  const rejected = lines.flatMap((l) => l.rejected);
  const barcodes = lines.flatMap((l) => l.barcodes);
  const warnings = [];

  // Promove valor "preço normal" isolado a preço comum
  const hasShelfLike = all.some((c) => ['promo', 'cash', 'regular'].includes(c.role));
  if (!hasShelfLike) {
    const prevOnes = all.filter((c) => c.role === 'previous');
    if (new Set(prevOnes.map((c) => c.cents)).size === 1) {
      prevOnes.forEach((c) => { c.role = 'regular'; c.flags.push('apenasPrecoNormal'); });
    }
  }

  // "DE 19,99 R$ 14,99" -> o outro valor vira promocional (inferido) quando é menor
  const previous = all.filter((c) => c.role === 'previous');
  if (previous.length) {
    const others = all.filter((c) => c.role === 'regular' && c.basis === previous[0].basis);
    if (others.length === 1 && others[0].cents < previous[0].cents) {
      others[0].role = 'promo'; others[0].flags.push('promocaoInferida');
    }
  }

  // Agrupa repetições (mesmo valor/base/papel em locais diferentes) em uma só entrada
  const groups = new Map();
  for (const c of all) {
    const key = `${c.cents}|${c.basis}|${c.role}`;
    if (!groups.has(key)) groups.set(key, { main: c, items: [c] });
    else groups.get(key).items.push(c);
  }
  const unique = [...groups.values()].map(({ main, items }) => {
    main.occurrences = items.length;
    main.occurrenceIds = items.map((i) => i.id);
    if (items.length > 1) main.flags.push('repetido');
    return main;
  });

  const heights = lines.map((l) => l.height).filter(Boolean);
  const medH = median(heights);
  unique.forEach((c) => {
    const ln = lines[c.lineIndex];
    c.heightRatio = ln.height && medH ? ln.height / medH : null;
  });

  const byRole = (role, basisSet) => unique.filter((c) => c.role === role && (!basisSet || basisSet.includes(c.basis)));
  const pkgShelf = unique.filter((c) => ['promo', 'cash', 'regular'].includes(c.role) && c.basis === 'package');
  const unitShelf = unique.filter((c) => ['promo', 'cash', 'regular'].includes(c.role) && c.basis !== 'package');

  const shelf = pkgShelf.length ? pkgShelf : unitShelf;
  let primary = null;
  let ambiguity = null;

  const pick = (list, why) => {
    const cents = new Set(list.map((c) => c.cents));
    if (cents.size === 1) return list.sort((a, b) => b.occurrences - a.occurrences)[0];
    ambiguity = `Há ${cents.size} valores diferentes (${why}); não foi possível saber qual é o principal.`;
    return null;
  };

  if (shelf.length) {
    const promos = shelf.filter((c) => c.role === 'promo');
    const cashes = shelf.filter((c) => c.role === 'cash');
    const regs = shelf.filter((c) => c.role === 'regular');
    if (promos.length) primary = pick(promos, 'promocionais');
    else if (cashes.length) primary = pick(cashes, 'à vista');
    else if (regs.length) {
      primary = pick(regs, 'sem indicação de qual é o preço da etiqueta');
      if (!primary && regs.every((c) => c.heightRatio)) {
        const sorted = [...regs].sort((a, b) => b.heightRatio - a.heightRatio);
        if (sorted[0].heightRatio >= sorted[1].heightRatio * 1.35) {
          primary = sorted[0]; primary.flags.push('maiorDestaque'); ambiguity = null;
        }
      }
    }
  } else if (unique.length && unique.every((c) => c.role === 'installment')) {
    // só existe parcelamento: não vale como preço
    ambiguity = 'Só foram encontrados valores de parcelas; o preço total não aparece.';
  }

  // preço anterior (de) coerente com o principal
  let prevPrice = null;
  const prevCands = byRole('previous', primary ? [primary.basis] : undefined);
  if (prevCands.length) {
    prevPrice = prevCands.sort((a, b) => b.cents - a.cents)[0];
    if (primary && prevPrice.cents <= primary.cents) {
      warnings.push('O valor "anterior" não é maior que o valor atual. Confira qual é qual.');
      prevPrice.flags.push('anteriorIncoerente');
    }
  }

  // preço por kg/L quando o principal é da embalagem
  let unitPrice = null;
  if (primary && primary.basis === 'package') {
    const u = unique.filter((c) => c.basis !== 'package' && ['promo', 'cash', 'regular'].includes(c.role));
    if (u.length) unitPrice = u.sort((a, b) => b.occurrences - a.occurrences)[0];
  }

  // Avisos
  const distinctShelf = new Set(shelf.map((c) => `${c.cents}|${c.basis}`)).size;
  if (ambiguity) warnings.push(ambiguity);
  if (primary && primary.basis !== 'package') {
    const label = primary.basis === 'kg' ? 'quilo' : primary.basis === 'l' ? 'litro' : 'unidade';
    warnings.push(`Este valor é o preço por ${label}, não necessariamente o preço total da embalagem.`);
  }
  if (!unique.length) warnings.push('Nenhum valor em reais foi identificado no texto.');
  if (unique.length && unique.every((c) => c.role === 'installment')) {
    warnings.push('Só há valores de parcelas; o preço total não foi identificado.');
  }

  return {
    candidates: unique, allOccurrences: all, rejected, barcodes, lines,
    primary, previous: prevPrice, unitPrice, ambiguity, warnings, distinctShelf,
  };
}

/* ------------------------------------------------------------------ */
/* Confiança do preço                                                  */
/* ------------------------------------------------------------------ */

const FLAG_TEXT = {
  pontoDecimal: 'Usa ponto como decimal (12.99): confirme',
  centavosSeparados: 'Centavos separados do valor inteiro: confirme',
  semCentavos: 'Valor sem centavos: confirme',
  corrigidoOCR: 'Caracteres parecidos com números foram corrigidos: confirme',
  umaCasa: 'Apenas uma casa decimal: confirme',
  valorMuitoBaixo: 'Valor muito baixo',
  valorMuitoAlto: 'Valor muito alto',
};

/**
 * Pontua um candidato (0..1) com razões legíveis. Não usa a confiança do OCR como se
 * fosse "probabilidade de estar certo": ela só reduz a nota quando é baixa.
 */
export function scorePrice(c, ctx = {}) {
  let s = 0.35;
  const reasons = [];
  if (c.hasCurrency) { s += 0.25; reasons.push('Tem o símbolo R$'); }
  else reasons.push('Sem o símbolo R$: a decisão depende do contexto');
  if (c.format === 'comma' && !c.flags.includes('umaCasa')) { s += 0.15; reasons.push('Formato brasileiro (vírgula e 2 casas decimais)'); }
  if (ctx.single) { s += 0.1; reasons.push('É o único valor monetário no texto'); }
  if (ctx.resolvedPair) { s += 0.15; reasons.push('Pares "de/por" coerentes (anterior maior que o atual)'); }
  if (c.keywords.length && ['promo', 'previous', 'cash'].includes(c.role)) {
    s += 0.1; reasons.push(`Indicado por "${c.keywords[0]}"`);
  }
  if (c.occurrences > 1) { s += 0.05; reasons.push('O valor aparece mais de uma vez'); }
  if (c.basisFrom === 'sufixo' || c.basisFrom === 'prefixo') { s += 0.05; reasons.push('Unidade (kg/L) indicada junto ao valor'); }
  if (ctx.crossCheck === 'consistente') { s += 0.1; reasons.push('Bate com o preço por kg/L e a quantidade'); }
  if (ctx.crossCheck === 'divergente') { s -= 0.15; reasons.push('Não bate com o preço por kg/L e a quantidade'); }
  if (c.flags.includes('maiorDestaque')) { s -= 0.05; reasons.push('Escolhido por ter o maior destaque na etiqueta'); }

  const penalties = { pontoDecimal: 0.2, centavosSeparados: 0.3, semCentavos: 0.35, corrigidoOCR: 0.15, umaCasa: 0.25, valorMuitoBaixo: 0.2, valorMuitoAlto: 0.3, promocaoInferida: 0.1, anteriorIncoerente: 0.2, semMilhar: 0.05 };
  for (const f of c.flags) {
    if (penalties[f]) { s -= penalties[f]; if (FLAG_TEXT[f]) reasons.push(FLAG_TEXT[f]); }
  }
  if (ctx.ambiguous) { s -= 0.3; reasons.push('Há outros valores possíveis'); }
  if (c.role === 'installment') { s = Math.min(s, 0.35); reasons.push('É valor de parcela, não o preço total'); }

  if (typeof c.ocrConfidence === 'number') {
    const k = c.ocrConfidence;
    if (k < 0.9) { s *= 0.6 + 0.4 * (k / 0.9); reasons.push(`Leitura do OCR com confiança ${Math.round(k * 100)}%`); }
  }
  s = clamp01(s);
  return { score: s, level: levelFromScore(s), reasons };
}

/** Verificação cruzada entre preço da embalagem, preço por kg/L e quantidade. */
export function crossCheckPrices(primary, unitPrice, quantity) {
  if (!primary || !unitPrice || !quantity || primary.basis !== 'package') return null;
  const expected = packagePriceFromUnit(unitPrice.cents, unitPrice.basis, quantity.baseQty, quantity.baseUnit);
  if (expected === null) return null;
  const tol = Math.max(3, Math.round(primary.cents * 0.02));
  return Math.abs(expected - primary.cents) <= tol ? 'consistente' : 'divergente';
}

export function describeCandidate(c) {
  const roleLabel = { previous: 'preço anterior', promo: 'promocional', cash: 'à vista', installment: 'parcela', regular: 'preço' }[c.role] ?? c.role;
  const basis = { package: '', kg: ' por kg', l: ' por litro', un: ' por unidade' }[c.basis] ?? '';
  return `${formatBRL(c.cents)}${basis} · ${roleLabel}`;
}
