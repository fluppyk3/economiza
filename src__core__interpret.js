// Orquestra a interpretação de uma etiqueta: preços, nome, quantidade e código de barras,
// com confiança INDEPENDENTE por campo e decisão de preenchimento por campo.
import { scanLine, analyzePrices, scorePrice, crossCheckPrices, levelFromScore, LEVEL } from './src__core__prices.js';
import { suggestName, nameLevel } from './src__core__name.js';
import { formatBRL } from './src__core__money.js';
import { formatQuantity } from './src__core__units.js';
import { similarity, splitLines } from './src__core__text.js';

/** nível -> o que a interface deve fazer com o campo */
export function decisionFromLevel(level) {
  if (level === LEVEL.OK) return 'preencher';
  if (level === LEVEL.DOUBT) return 'confirmar';
  return 'vazio';
}

/** Aceita string, array de linhas ou { text, lines } e devolve linhas { text, confidence?, bbox?, words? }. */
export function toLines(input) {
  if (typeof input === 'string') return splitLines(input).map((text) => ({ text }));
  if (Array.isArray(input)) return input.flatMap((l) => (typeof l === 'string' ? splitLines(l).map((text) => ({ text })) : [l]));
  if (input && Array.isArray(input.lines) && input.lines.length) return toLines(input.lines);
  if (input && typeof input.text === 'string') return toLines(input.text);
  return [];
}

function pickQuantity(scanned, priceCandidates) {
  const taken = priceCandidates.map((c) => ({ lineIndex: c.lineIndex, start: c.start, end: c.end }));
  const list = [];
  for (const ln of scanned) {
    for (const m of ln.measures) {
      if (!m.baseQty || !['mass', 'volume', 'count'].includes(m.kind)) continue;
      const clash = taken.some((t) => t.lineIndex === ln.index && m.start < t.end && m.end > t.start);
      if (clash) continue;
      list.push({ ...m, lineIndex: ln.index });
    }
  }
  if (!list.length) return null;
  // prefere massa/volume a contagem (c/12 só complementa), e a primeira ocorrência
  const rank = (m) => (m.kind === 'mass' || m.kind === 'volume' ? 0 : 1);
  list.sort((a, b) => rank(a) - rank(b) || a.lineIndex - b.lineIndex || a.start - b.start);
  const main = list[0];
  const sameRank = list.filter((m) => rank(m) === rank(main));
  const distinct = new Set(sameRank.map((m) => `${m.baseQty}${m.baseUnit}`));
  return {
    baseQty: main.baseQty, baseUnit: main.baseUnit, kind: main.kind,
    text: formatQuantity(main.baseQty, main.baseUnit), raw: main.raw, lineIndex: main.lineIndex,
    multipack: !!main.multipack, ocrFixed: !!main.ocrFixed, ambiguous: distinct.size > 1,
    alternatives: distinct.size > 1
      ? sameRank.map((m) => ({ baseQty: m.baseQty, baseUnit: m.baseUnit, text: formatQuantity(m.baseQty, m.baseUnit) }))
      : [],
  };
}

/** Confiança da quantidade/unidade (independente do nome e do preço). */
function scoreQuantity(q, scanned, pa, cross) {
  const reasons = [];
  let s = 0.6;
  reasons.push(`Medida reconhecida no texto: "${q.raw.trim()}"`);
  if (q.kind === 'mass' || q.kind === 'volume') { s += 0.15; reasons.push('Unidade de peso/volume clara'); }
  else { s += 0.05; reasons.push('Contagem de unidades'); }
  const ln = scanned[q.lineIndex];
  if (pa.primary && pa.primary.lineIndex === q.lineIndex) { s += 0.05; reasons.push('Está na mesma linha do preço'); }
  if (q.ambiguous) { s -= 0.25; reasons.push('Há mais de uma medida diferente no texto'); }
  if (q.ocrFixed) { s -= 0.2; reasons.push('O "1" pode ter sido lido como letra (I): confirme a medida'); }
  if (q.multipack) { s -= 0.05; reasons.push('Embalagem com várias unidades: confira o total'); }
  if (cross === 'consistente') { s += 0.15; reasons.push('Bate com o preço por kg/L e o preço da embalagem'); }
  if (cross === 'divergente') { s -= 0.2; reasons.push('Não bate com o preço por kg/L e o preço da embalagem'); }
  const conf = ln && typeof ln.confidence === 'number' ? ln.confidence / 100 : null;
  if (conf !== null && conf < 0.9) { s *= 0.6 + 0.4 * (conf / 0.9); reasons.push(`Leitura do OCR com confiança ${Math.round(conf * 100)}%`); }
  s = Math.max(0, Math.min(1, s));
  const level = levelFromScore(s);
  return { score: s, level, decision: decisionFromLevel(level), reasons };
}

function pickBarcode(scanned) {
  const all = scanned.flatMap((l) => l.barcodes);
  if (!all.length) return null;
  const valid = all.find((b) => b.valid);
  const b = valid ?? all[0];
  return { digits: b.digits, valid: !!valid };
}

function meanOcr(scanned) {
  const c = scanned.map((l) => l.confidence).filter((n) => typeof n === 'number');
  return c.length ? Math.round(c.reduce((a, b) => a + b, 0) / c.length) : null;
}

/**
 * Interpreta o texto de UMA leitura de OCR.
 * @returns objeto com name, price, previousPrice, unitPrice, quantity, barcode, candidates, warnings…
 */
export function interpretLabel(input) {
  const lines = toLines(input);
  const scanned = lines.map((l, i) => scanLine(l, i));
  const pa = analyzePrices(scanned);
  const warnings = [...pa.warnings];

  const quantity = pickQuantity(scanned, pa.allOccurrences);
  const barcode = pickBarcode(scanned);

  const cross = crossCheckPrices(pa.primary, pa.unitPrice, quantity);
  if (quantity) Object.assign(quantity, scoreQuantity(quantity, scanned, pa, cross));

  // pontua todos os candidatos (para as alternativas na tela de revisão)
  const nonInst = pa.candidates.filter((c) => c.role !== 'installment');
  const resolvedPair = !!(pa.primary && pa.previous && pa.primary.role === 'promo' && pa.previous.cents > pa.primary.cents);
  const scoredCandidates = pa.candidates.map((c) => {
    const isPrimary = pa.primary && c.id === pa.primary.id;
    const sc = scorePrice(c, {
      single: pa.candidates.length === 1,
      resolvedPair: resolvedPair && (isPrimary || (pa.previous && c.id === pa.previous.id)),
      ambiguous: !pa.primary && nonInst.length > 1 && ['regular', 'promo', 'cash'].includes(c.role),
      crossCheck: isPrimary ? cross : null,
    });
    return {
      id: c.id, cents: c.cents, display: formatBRL(c.cents), role: c.role, basis: c.basis,
      level: sc.level, score: sc.score, reasons: sc.reasons, flags: c.flags, line: c.lineIndex,
      occurrences: c.occurrences, installments: c.installments, keywords: c.keywords,
      isPrimary: !!isPrimary,
    };
  });
  const byId = new Map(scoredCandidates.map((c) => [c.id, c]));

  let price = {
    cents: null, display: '', basis: 'package', role: null, level: LEVEL.BAD, score: 0, decision: 'vazio',
    reasons: [], candidateId: null, flags: [],
  };
  if (pa.primary) {
    const sc = byId.get(pa.primary.id);
    price = {
      cents: pa.primary.cents, display: formatBRL(pa.primary.cents), basis: pa.primary.basis,
      role: pa.primary.role, level: sc.level, score: sc.score, decision: decisionFromLevel(sc.level),
      reasons: sc.reasons, candidateId: pa.primary.id, flags: pa.primary.flags,
    };
  } else if (pa.candidates.length) {
    price.reasons = [pa.ambiguity ?? 'Os valores encontrados não permitem identificar o preço principal.'];
  } else {
    price.reasons = ['Nenhum valor em reais foi identificado.'];
  }

  const previousPrice = pa.previous
    ? { cents: pa.previous.cents, display: formatBRL(pa.previous.cents), basis: pa.previous.basis, candidateId: pa.previous.id, coherent: !pa.primary || pa.previous.cents > pa.primary.cents }
    : null;
  const unitPrice = pa.unitPrice
    ? { cents: pa.unitPrice.cents, display: formatBRL(pa.unitPrice.cents), per: pa.unitPrice.basis, candidateId: pa.unitPrice.id }
    : null;
  if (cross === 'divergente') warnings.push('O preço por kg/L não confere com o preço da embalagem e a quantidade lidos. Confira os dois.');

  const nm = suggestName(scanned, { primaryLine: pa.primary ? pa.primary.lineIndex : null });
  const name = {
    value: nm.text, title: nm.title, level: nm.level, score: nm.score, decision: decisionFromLevel(nm.level),
    reasons: nm.reasons, alternatives: nm.alternatives, suspect: nm.suspect, corrections: nm.corrections ?? [],
  };
  if (nm.level === 'invalido' && nm.suspect) warnings.push('O texto lido para o nome parece desordenado e não foi preenchido. Digite o nome.');
  if (nm.level === 'invalido' && !nm.suspect) warnings.push('Não foi possível identificar o nome do produto. Digite o nome.');
  if (quantity?.ambiguous) warnings.push('Mais de uma medida foi lida (por exemplo, peso e volume). Confira a embalagem.');

  return {
    version: 1,
    rawText: lines.map((l) => l.text).join('\n'),
    normalizedText: scanned.map((l) => l.text).join('\n'),
    lines: scanned.map((l) => ({ text: l.text, confidence: l.confidence })),
    ocrConfidence: meanOcr(scanned),
    name, price, previousPrice, unitPrice, quantity, barcode,
    candidates: scoredCandidates,
    rejectedNumbers: pa.rejected.map((r) => ({ raw: r.raw, reason: r.reason, line: r.lineIndex })),
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Várias tentativas de OCR                                            */
/* ------------------------------------------------------------------ */

/** Pontuação "útil" de uma leitura (para escolher a melhor e decidir se vale tentar de novo). */
export function resultQuality(r) {
  const p = r.price.cents !== null ? r.price.score : 0;
  const n = r.name.level !== 'invalido' ? r.name.score : 0;
  return 0.6 * p + 0.4 * n;
}

/** Vale a pena tentar outro processamento? */
export function looksPoor(r) {
  return r.price.cents === null || r.price.level === LEVEL.BAD || r.name.level === 'invalido';
}

/**
 * Combina leituras de tentativas diferentes. Cada campo é decidido separadamente:
 * concordância entre tentativas aumenta a confiança; discordância diminui.
 */
export function mergeAttempts(results) {
  const list = results.filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return { ...list[0], attempts: 1 };

  const best = [...list].sort((a, b) => resultQuality(b) - resultQuality(a))[0];
  const merged = JSON.parse(JSON.stringify(best));
  merged.attempts = list.length;

  // preço
  const withPrice = list.filter((r) => r.price.cents !== null);
  if (withPrice.length) {
    const top = [...withPrice].sort((a, b) => b.price.score - a.price.score)[0];
    const agree = withPrice.filter((r) => r.price.cents === top.price.cents && r.price.basis === top.price.basis).length;
    const disagree = withPrice.length - agree;
    merged.price = JSON.parse(JSON.stringify(top.price));
    let s = merged.price.score;
    if (agree >= 2) { s = Math.min(1, s + 0.1); merged.price.reasons.push(`${agree} tentativas leram o mesmo valor`); }
    if (disagree > 0) { s = Math.max(0, s - 0.15); merged.price.reasons.push('Tentativas diferentes leram valores diferentes: confira'); merged.warnings.push('As tentativas de leitura divergiram no preço. Confira o valor.'); }
    merged.price.score = s;
    merged.price.level = levelFromScore(s);
    merged.price.decision = decisionFromLevel(merged.price.level);
    merged.previousPrice = top.previousPrice;
    merged.unitPrice = top.unitPrice;
  } else {
    // nenhuma tentativa achou preço principal: mantém as alternativas de todas
    merged.price = best.price;
  }

  // nome
  const named = list.filter((r) => r.name.value);
  if (named.length) {
    const top = [...named].sort((a, b) => b.name.score - a.name.score)[0];
    merged.name = JSON.parse(JSON.stringify(top.name));
    const sims = named.filter((r) => r !== top).map((r) => similarity(r.name.value, top.name.value));
    let s = merged.name.score;
    if (sims.some((x) => x >= 0.85)) { s = Math.min(1, s + 0.1); merged.name.reasons.push('Tentativas diferentes leram o mesmo nome'); }
    else if (sims.length && sims.every((x) => x < 0.5)) { s = Math.max(0, s - 0.15); merged.name.reasons.push('Tentativas diferentes leram nomes diferentes'); }
    merged.name.score = s;
    merged.name.level = nameLevel(s);
    merged.name.decision = decisionFromLevel(merged.name.level);
  }

  // quantidade/unidade: concordância reforça, divergência rebaixa (ex.: "500 g" x "200 g")
  const withQty = list.filter((r) => r.quantity);
  if (withQty.length) {
    const groups = new Map();
    for (const r of withQty) {
      const k = `${r.quantity.baseQty}${r.quantity.baseUnit}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const bestScore = (g) => Math.max(...g.map((x) => x.quantity.score));
    const ranked = [...groups.values()].sort((a, b) => b.length - a.length || bestScore(b) - bestScore(a));
    const top = [...ranked[0]].sort((a, b) => b.quantity.score - a.quantity.score)[0];
    merged.quantity = JSON.parse(JSON.stringify(top.quantity));
    let q = merged.quantity.score;
    if (groups.size > 1) {
      q = Math.max(0, q - 0.3);
      const seenTexts = [...groups.values()].map((g) => g[0].quantity.text).join(' / ');
      merged.quantity.reasons.push(`Tentativas diferentes leram medidas diferentes (${seenTexts})`);
      merged.warnings.push(`As tentativas leram medidas diferentes (${seenTexts}). Confira o peso/volume na embalagem.`);
    } else if (ranked[0].length >= 2) {
      q = Math.min(1, q + 0.1);
      merged.quantity.reasons.push(`${ranked[0].length} tentativas leram a mesma medida`);
    } else if (list.length >= 2) {
      q = Math.max(0, q - 0.1);
      merged.quantity.reasons.push('Só uma das tentativas leu a medida');
    }
    merged.quantity.score = q;
    merged.quantity.level = levelFromScore(q);
    merged.quantity.decision = decisionFromLevel(merged.quantity.level);
  }

  // candidatos: união por valor/base/papel
  const seen = new Map();
  for (const r of list) for (const c of r.candidates) {
    const key = `${c.cents}|${c.basis}|${c.role}`;
    if (!seen.has(key) || seen.get(key).score < c.score) seen.set(key, c);
  }
  merged.candidates = [...seen.values()].sort((a, b) => b.score - a.score);
  merged.warnings = [...new Set(merged.warnings)];
  return merged;
}
