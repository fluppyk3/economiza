// Utilitários de texto: normalização de saída de OCR, busca sem acentos, escape de HTML.
// Tudo aqui é puro (sem DOM) para poder ser testado em Node.

/** Escapa texto para inserção segura em HTML. O texto do OCR é dado não confiável. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Minúsculas, sem acentos, espaços colapsados: usado em busca e comparação. */
export function foldText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const SPACE_LIKE = /[   -   　\t\r\f\v]/g;
const ZERO_WIDTH = /[​-‍⁠﻿]/g;
const DASHES = /[‐-―−]/g;
const QUOTES = /[‘’‛′]/g;

/**
 * Normaliza um trecho de texto vindo do OCR sem destruir vírgulas, pontos ou "R$".
 * Retorna o texto novo e a lista de correções feitas (para auditoria).
 */
export function normalizeOcrText(input) {
  const changes = [];
  let s = String(input ?? '');
  const original = s;
  s = s.normalize('NFC').replace(ZERO_WIDTH, '').replace(SPACE_LIKE, ' ');
  s = s.replace(DASHES, '-').replace(QUOTES, "'");
  s = s.replace(/[“”]/g, '"');
  // Símbolo de moeda lido como RS / R5 / R§ antes de um número: "RS 12,99" -> "R$ 12,99".
  s = s.replace(/(^|[^A-Za-zÀ-ÿ0-9])R\s?[S5§Ş$]\s?(?=\d)/g, (m, pre) => {
    if (!/R\s?\$/.test(m)) changes.push('moeda');
    return `${pre}R$ `;
  });
  // "R $ 12,99" -> "R$ 12,99"
  s = s.replace(/R\s+\$/g, 'R$');
  s = s.replace(/[ ]{2,}/g, ' ');
  s = s.replace(/^ +| +$/g, '');
  if (s !== original && !changes.length) changes.push('espacos');
  return { text: s, changes };
}

/** Divide em linhas não vazias, preservando a ordem. */
export function splitLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 0);
}

/** Distância de Levenshtein (strings curtas). */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Similaridade 0..1 entre dois textos (ignora acentos e caixa). */
export function similarity(a, b) {
  const x = foldText(a);
  const y = foldText(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

const SMALL_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'com', 'sem', 'para', 'por', 'a', 'o', 'ao', 'no', 'na', 'ou']);
const KEEP_UPPER = new Set(['UHT', 'PET', 'LED', 'LG', 'TV', 'HD', 'USB', 'XL', 'GG', 'PP', 'BBQ', 'DVD', 'SSD', 'RAM', 'GPS']);

/** Converte "BISCOITO DE CHOCOLATE" em "Biscoito de Chocolate" (só se o texto estiver todo em maiúsculas). */
export function smartTitleCase(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  const letters = s.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (!letters || letters !== letters.toUpperCase()) return s;
  return s
    .split(' ')
    .map((w, i) => {
      if (KEEP_UPPER.has(w)) return w;
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.replace(/(^|[-'/(])([a-zà-ÿ])/g, (_, p, c) => p + c.toUpperCase());
    })
    .join(' ');
}

/** Gera um identificador estável e único (não depende de crypto em Node antigo). */
export function newId(prefix = 'id') {
  const rnd = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 20)
    : Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  return `${prefix}_${rnd}`;
}
