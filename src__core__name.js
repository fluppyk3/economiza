// Sugestão do nome do produto a partir das linhas reconhecidas pelo OCR.
//
// Estratégia: análise ESTRUTURAL de legibilidade (vogais, grupos de consoantes, alternância
// de caixa, fragmentos curtos, símbolos). Marcas novas e nomes incomuns passam; sequências sem
// coerência ("weet 2 EOIN a IG Wo yg -l") não são aceitas como nome confiável.
// O vocabulário em words-pt.js só REFORÇA a confiança — jamais é usado para rejeitar.
import { foldText, smartTitleCase, levenshtein } from './src__core__text.js';
import { inDictionary, WORDS_PT } from './src__core__words-pt.js';
import { LABEL_NOISE } from './src__core__prices.js';

export const NAME_THRESHOLD_OK = 0.7;
export const NAME_THRESHOLD_DOUBT = 0.45;

export function nameLevel(score) {
  const s = Math.round(score * 100) / 100;
  if (s >= NAME_THRESHOLD_OK) return 'confiavel';
  if (s >= NAME_THRESHOLD_DOUBT) return 'duvidoso';
  return 'invalido';
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const VOWELS = /[aeiouáéíóúâêôãõàüäëïöy]/i;
const VOWELS_STRICT = /[aeiouáéíóúâêôãõàü]/i;

const SHORT_OK_LOWER = new Set(['dr', 'sr', 'sra', 'dra', 'de', 'da', 'do', 'em', 'ao', 'no', 'na', 'os', 'as', 'um', 'ou', 'se', 'e', 'a', 'o', 'c/', 's/', 'p/', 'pc', 'un', 'cx', 'sc', 'tp', 'gf', 'kg', 'ml', 'lt']);
const SHORT_OK_UPPER = new Set(['LG', 'TV', 'HD', 'XL', 'GG', 'PP', 'PC', 'P', 'M', 'G', 'UN', 'CX', 'SC', 'DE', 'DA', 'DO', 'EM', 'AO', 'NO', 'NA', 'OS', 'AS', 'UM', 'OU', 'E', 'A', 'O', 'C/', 'S/', 'P/', 'LT', 'KG', 'ML', 'UHT', 'PET', 'LED', 'USB', 'SSD', 'RAM', 'GPS', 'DVD', 'BBQ', 'AA', 'AAA', 'DR', 'SR', 'LCD', 'PVC']);

// pares de letras que praticamente não ocorrem em palavras reais
const IMPOSSIBLE = ['qk', 'kq', 'jk', 'kj', 'wq', 'qw', 'xz', 'zx', 'jq', 'qj', 'vq', 'qv', 'pq', 'qp', 'gq', 'qg', 'zq', 'qz', 'jx', 'xj', 'kx', 'xk', 'wx', 'xw', 'vw', 'wv', 'fq', 'qf', 'zj', 'jz', 'hx', 'xh', 'cx', 'xc', 'sx', 'dx'];

function isLetter(ch) { return /\p{L}/u.test(ch); }

function casePattern(core) {
  const letters = [...core].filter(isLetter);
  if (!letters.length) return 'none';
  const up = letters.filter((c) => c !== c.toLowerCase()).length;
  if (up === 0) return 'lower';
  if (up === letters.length) return 'upper';
  const first = letters[0];
  if (first !== first.toLowerCase() && up === 1) return 'capitalized';
  // transições minúscula -> maiúscula dentro da palavra
  let trans = 0;
  for (let i = 1; i < letters.length; i++) {
    if (letters[i - 1] === letters[i - 1].toLowerCase() && letters[i] !== letters[i].toLowerCase()) trans++;
  }
  if (trans <= 1 && letters.length >= 5) return 'camel';
  return 'mixed';
}

/**
 * Classifica um "pedaço" (separado por espaço): 'word' | 'short' | 'model' | 'num' | 'sym' | 'junk'.
 */
export function classifyToken(token) {
  const core = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%+]+$/gu, '');
  if (!core) return { kind: 'sym', core: '', letters: 0 };
  const chars = [...core];
  const letters = chars.filter(isLetter);
  const digits = chars.filter((c) => /\d/.test(c));
  const nLetters = letters.length;

  if (nLetters === 0) {
    return { kind: digits.length <= 4 ? 'num' : 'junk', core, letters: 0, why: digits.length <= 4 ? '' : 'sequência longa de números' };
  }

  // caracteres estranhos dentro do pedaço
  if (/[|~_*#@^<>{}[\]\\=]/.test(core)) return { kind: 'junk', core, letters: nLetters, why: 'símbolos estranhos' };

  if (digits.length > 0) {
    // modelos/variantes: A54, S23, 7UP, 3D, iPhone15, 55UQ8050
    if (/^[\p{L}]{1,6}\d{1,5}[\p{L}]{0,4}\d{0,5}$/u.test(core) || /^\d{1,4}[\p{L}]{1,5}(\d{1,5}[\p{L}]{0,3})?$/u.test(core)) {
      const cp = casePattern(core);
      if (cp !== 'mixed') return { kind: 'model', core, letters: nLetters };
    }
    return { kind: 'junk', core, letters: nLetters, why: 'letras e números misturados sem padrão' };
  }

  const lowerCore = core.toLowerCase();
  if (/^[A-Z]&[A-Z](['’]s)?$/.test(core)) return { kind: 'model', core, letters: nLetters };
  if (nLetters === 1) {
    if (SHORT_OK_LOWER.has(lowerCore) && core === core.toLowerCase()) return { kind: 'short', core, letters: 1 };
    if (SHORT_OK_UPPER.has(core)) return { kind: 'short', core, letters: 1 };
    return { kind: 'junk', core, letters: 1, why: 'letra isolada' };
  }
  if (nLetters === 2) {
    if (SHORT_OK_LOWER.has(lowerCore) && ['lower', 'upper', 'capitalized'].includes(casePattern(core))) return { kind: 'short', core, letters: 2 };
    if (SHORT_OK_UPPER.has(core)) return { kind: 'short', core, letters: 2 };
    return { kind: 'junk', core, letters: 2, why: 'fragmento curto' };
  }

  if (/^[Il1|OoO0]+$/.test(core)) return { kind: 'junk', core, letters: nLetters, why: 'letras confundíveis' };
  const cp = casePattern(core);
  if (cp === 'mixed') return { kind: 'junk', core, letters: nLetters, why: 'maiúsculas e minúsculas misturadas' };

  const onlyLetters = letters.join('');
  const folded = foldText(onlyLetters);
  if (SHORT_OK_UPPER.has(core) && nLetters <= 3) return { kind: 'short', core, letters: nLetters };
  const vowelCount = [...onlyLetters].filter((c) => VOWELS_STRICT.test(c)).length;
  const vowelsWithY = [...onlyLetters].filter((c) => VOWELS.test(c)).length;
  if (vowelCount === 0 && vowelsWithY === 0) {
    if (cp === 'upper' && nLetters <= 4 && !IMPOSSIBLE.some((p) => folded.toLowerCase().includes(p))) {
      return { kind: 'acro', core, letters: nLetters };
    }
    return { kind: 'junk', core, letters: nLetters, why: 'sem vogais' };
  }
  const vr = vowelsWithY / nLetters;
  if (vr < 0.18) return { kind: 'junk', core, letters: nLetters, why: 'poucas vogais' };
  if (nLetters >= 4 ? vr > 0.8 : vr > 0.67) return { kind: 'junk', core, letters: nLetters, why: 'vogais demais' };
  if (/[^aeiouy]{6,}/i.test(folded)) return { kind: 'junk', core, letters: nLetters, why: 'consoantes demais seguidas' };
  if (/([a-z])\1\1/i.test(folded) && !/^[ivxlcdm]+$/i.test(folded)) return { kind: 'junk', core, letters: nLetters, why: 'letra repetida' };
  const lowered = folded.toLowerCase();
  for (const pair of IMPOSSIBLE) if (lowered.includes(pair)) return { kind: 'junk', core, letters: nLetters, why: 'combinação de letras improvável' };
  return { kind: 'word', core, letters: nLetters };
}

/**
 * Qualidade de um texto como possível nome (0..1) com métricas e razões.
 */
export function scoreTextQuality(text) {
  const reasons = [];
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return { score: 0, reasons: ['Texto vazio'], metrics: {} };

  const rawTokens = clean.split(' ');
  const toks = rawTokens.map((t) => ({ t, ...classifyToken(t) }));
  const hasRealWord = toks.some((k) => k.kind === 'word' || k.kind === 'model');
  for (const k of toks) {
    if (k.kind === 'acro') { k.kind = hasRealWord ? 'short' : 'junk'; if (k.kind === 'junk') k.why = 'sigla isolada sem vogais'; }
  }
  const textual = toks.filter((k) => k.kind !== 'num');
  const nonSpace = clean.replace(/\s/g, '');
  const letterCount = [...nonSpace].filter(isLetter).length;

  if (letterCount < 2) return { score: 0, reasons: ['Quase sem letras'], metrics: { letterCount } };

  const wordLetters = toks.filter((k) => k.kind === 'word' || k.kind === 'model').reduce((s, k) => s + k.letters, 0);
  const shortLetters = toks.filter((k) => k.kind === 'short').reduce((s, k) => s + k.letters, 0);
  const junkLetters = toks.filter((k) => k.kind === 'junk').reduce((s, k) => s + Math.max(1, k.letters), 0);
  const symTokens = toks.filter((k) => k.kind === 'sym').length;
  const junkTokens = toks.filter((k) => k.kind === 'junk').length;
  const totalLetters = wordLetters + shortLetters + junkLetters;
  const wordFrac = totalLetters ? (wordLetters + 0.5 * shortLetters) / totalLetters : 0;
  const denom = Math.max(1, textual.length);
  const junkTokenFrac = (junkTokens + symTokens) / denom;

  // mistura de TUDO-MAIÚSCULO com minúsculo (palavras longas) é típica de lixo de OCR
  const longWords = toks.filter((k) => (k.kind === 'word') && k.letters >= 3);
  const nUpper = longWords.filter((k) => casePattern(k.core) === 'upper').length;
  const nLower = longWords.filter((k) => casePattern(k.core) === 'lower').length;
  const caseMix = nUpper > 0 && nLower > 0 ? Math.min(1, Math.min(nUpper, nLower) / Math.max(1, longWords.length) * 2) : 0;

  const symRatio = nonSpace.length ? ([...nonSpace].filter((c) => !isLetter(c) && !/\d/.test(c) && !/[-'./&+%,]/.test(c)).length) / nonSpace.length : 0;
  const letterRatio = nonSpace.length ? letterCount / nonSpace.length : 0;

  const dictHits = toks.filter((k) => (k.kind === 'word') && inDictionary(k.core)).length;
  const dictFrac = longWords.length ? dictHits / Math.max(1, toks.filter((k) => k.kind === 'word').length) : 0;

  let score = wordFrac - 0.8 * junkTokenFrac - 0.3 * caseMix - 0.6 * symRatio + 0.25 * dictFrac;
  if (letterRatio < 0.5) { score -= 0.2; reasons.push('Muitos números/símbolos em relação às letras'); }
  if (!dictHits && toks.filter((k) => k.kind === 'word').length <= 1 && textual.length === 1) score = Math.min(score, 0.85);
  score = clamp01(score);

  if (junkTokens) reasons.push(`${junkTokens} trecho(s) sem aparência de palavra`);
  if (caseMix > 0) reasons.push('Mistura de maiúsculas e minúsculas incomum');
  if (dictHits) reasons.push('Contém palavras comuns de produtos');
  if (!junkTokens && !caseMix && score >= 0.7) reasons.push('Letras formam palavras legíveis');

  return {
    score,
    reasons,
    metrics: { wordFrac, junkTokenFrac, caseMix, symRatio, letterRatio, dictFrac, tokens: toks.length },
  };
}

/** Dicas de correção ("Chocolote" -> "Chocolate") — nunca aplicadas automaticamente. */
export function suggestCorrections(text) {
  const out = [];
  for (const tok of String(text ?? '').split(/\s+/)) {
    const core = tok.replace(/[^\p{L}]/gu, '');
    if (core.length < 5 || inDictionary(core)) continue;
    const f = foldText(core);
    for (const w of WORDS_PT) {
      if (w.length < 5 || Math.abs(w.length - f.length) > 1 || w[0] !== f[0]) continue;
      if (levenshtein(f, w) === 1) { out.push({ from: core, to: w }); break; }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Limpeza das linhas e escolha do nome                                */
/* ------------------------------------------------------------------ */

/** Remove de uma linha tudo que é preço, medida, código, data ou palavra de etiqueta. */
export function cleanLineForName(scanned) {
  const text = scanned.text;
  const ranges = [];
  scanned.candidates.forEach((c) => ranges.push([c.start, c.end]));
  scanned.measures.forEach((m) => ranges.push([m.start, m.end]));
  scanned.barcodes.forEach((b) => ranges.push([b.start, b.end]));
  scanned.masks.forEach((m) => ranges.push([m.start, m.end]));
  // palavras como "DE"/"POR" só são removidas quando coladas a um preço ("DE R$ 19,99"),
  // para não destruir nomes como "MOLHO DE TOMATE".
  scanned.keywords.forEach((k) => {
    if (!k.adj) { ranges.push([k.start, k.end]); return; }
    const glued = scanned.candidates.some((c) => c.start >= k.end && text.slice(k.end, c.start).replace(/R\$|[\s:.\-–—]/g, '').length === 0);
    if (glued) ranges.push([k.start, k.end]);
  });
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [a, b] of ranges) {
    if (a > pos) out += text.slice(pos, a);
    out += ' ';
    pos = Math.max(pos, b);
  }
  out += text.slice(pos);
  out = out.replace(/R\$/g, ' ').replace(LABEL_NOISE, ' ');
  out = out.replace(/(^|\s)[-–—•·*:;,._/|\\]+(?=\s|$)/g, ' ');
  out = out.replace(/^[\s\-–—•·*:;,._/|\\]+|[\s\-–—•·*:;,._/|\\(]+$/g, '');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

function median(arr) {
  const a = arr.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Escolhe a melhor sugestão de nome.
 * @param scannedLines linhas já varridas por scanLine()
 * @param ctx { primaryLine: índice da linha do preço principal (ou null) }
 */
export function suggestName(scannedLines, ctx = {}) {
  const lines = scannedLines.map((ln) => ({ ln, text: cleanLineForName(ln) }));
  const medH = median(scannedLines.map((l) => l.height));
  const rejected = [];
  const candidates = [];

  const evalBlock = (idxs) => {
    const parts = idxs.map((i) => lines[i].text).filter(Boolean);
    if (parts.length !== idxs.length) return null;
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length < 2 || text.length > 90) return null;
    const q = scoreTextQuality(text);
    // proximidade com o preço
    let prox = 0.5;
    if (ctx.primaryLine !== null && ctx.primaryLine !== undefined) {
      const d = Math.min(...idxs.map((i) => Math.abs(i - ctx.primaryLine)));
      prox = 1 / (1 + 0.5 * d);
    }
    // destaque: altura da linha em relação à mediana e posição (primeiras linhas)
    let prom = 0.5;
    const hs = idxs.map((i) => lines[i].ln.height).filter(Boolean);
    if (hs.length && medH) prom = clamp01(0.35 + 0.35 * (Math.max(...hs) / medH));
    const topBias = 1 - Math.min(...idxs) / Math.max(1, lines.length);
    prom = clamp01(0.7 * prom + 0.3 * topBias);
    // confiança do OCR nas linhas
    const confs = idxs.map((i) => lines[i].ln.confidence).filter((c) => typeof c === 'number');
    const ocr = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length / 100 : null;
    let score = q.score * 0.72 + prox * 0.14 + prom * 0.14;
    if (ocr !== null && ocr < 0.85) score *= 0.65 + 0.35 * (ocr / 0.85);
    score = Math.min(score, q.score); // o nome nunca é mais confiável que o próprio texto
    return { text, score: clamp01(score), quality: q, idxs, ocr };
  };

  const singles = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].text) continue;
    const one = evalBlock([i]);
    if (one) { candidates.push(one); singles.set(i, one); }
  }
  // junção de linhas vizinhas: vale quando as duas partes são boas (ex.: "BISCOITO" + "CHOCOLATE RECHEADO")
  for (let i = 0; i < lines.length; i++) {
    for (const span of [2, 3]) {
      const idxs = Array.from({ length: span }, (_, k) => i + k);
      if (idxs.some((k) => !singles.has(k))) continue;
      const block = evalBlock(idxs);
      if (!block || block.quality.score < (span === 2 ? 0.6 : 0.7)) continue;
      const parts = idxs.map((k) => singles.get(k).score);
      if (Math.min(...parts) < NAME_THRESHOLD_OK) continue;
      const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
      candidates.push({ ...block, score: clamp01(Math.min(block.quality.score, avg + 0.02 - (span - 2) * 0.02)) });
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.text.length - a.text.length);
  const best = candidates[0] ?? null;

  // trechos descartados (para a tela de auditoria)
  lines.forEach((l, i) => {
    if (!l.text) return;
    const q = scoreTextQuality(l.text);
    if (q.score < NAME_THRESHOLD_DOUBT) rejected.push({ text: l.text, lineIndex: i, reason: q.reasons[0] ?? 'Sem aparência de nome' });
  });

  if (!best) {
    return { text: '', title: '', score: 0, level: 'invalido', reasons: ['Nenhum texto utilizável como nome foi encontrado'], alternatives: [], suspect: rejected[0]?.text ?? '', rejected, lineIndexes: [] };
  }

  const level = nameLevel(best.score);
  const reasons = [...best.quality.reasons];
  if (best.ocr !== null && best.ocr < 0.85) reasons.push(`Leitura do OCR com confiança ${Math.round(best.ocr * 100)}%`);
  const corrections = level === 'invalido' ? [] : suggestCorrections(best.text);
  if (corrections.length) reasons.push(`Possível erro de leitura: "${corrections[0].from}" (será que é "${corrections[0].to}"?)`);

  const alternatives = [];
  const seen = new Set([foldText(best.text)]);
  for (const c of candidates.slice(1)) {
    const k = foldText(c.text);
    if (seen.has(k) || nameLevel(c.score) === 'invalido') continue;
    seen.add(k);
    alternatives.push({ text: c.text, title: smartTitleCase(c.text), score: c.score, level: nameLevel(c.score) });
    if (alternatives.length >= 3) break;
  }

  if (level === 'invalido') {
    return {
      text: '', title: '', score: best.score, level, reasons: ['A leitura não parece um nome de produto: ' + (best.quality.reasons[0] ?? 'sequência sem coerência')],
      alternatives: [], suspect: best.text, rejected, lineIndexes: best.idxs, corrections,
    };
  }
  return {
    text: best.text, title: smartTitleCase(best.text), score: best.score, level, reasons,
    alternatives, suspect: '', rejected, lineIndexes: best.idxs, corrections,
  };
}
