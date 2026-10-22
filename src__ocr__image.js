// Carregamento, análise de qualidade e pré-processamento de imagens (canvas).
// As transformações são MODERADAS de propósito: vírgulas, pontos e "R$" são pequenos e
// podem sumir com filtros agressivos.
import { AppError } from './src__core__errors.js';

export const LIMITS = {
  maxFileBytes: 25 * 1024 * 1024, // arquivos maiores são recusados
  maxDecodeSide: 6000,            // imagens gigantes são reduzidas logo ao abrir
  workSide: 2000,                 // imagens maiores que isso são reduzidas
  smallSide: 640,                 // só imagens menores que isso são ampliadas (até 2x)
  smallTarget: 1000,              // tamanho-alvo da ampliação
  minSide: 320,                   // abaixo disso, a leitura é pouco provável
};

const ACCEPT = /^image\/(png|jpe?g|webp|bmp|gif|heic|heif|avif)$/i;

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function releaseCanvas(c) {
  if (c) { c.width = 1; c.height = 1; }
}

/** Abre um arquivo de imagem validando tipo, tamanho e decodificação. */
export async function loadImage(file) {
  if (!file) throw new AppError('NO_FILE', 'Nenhuma imagem foi selecionada.');
  if (file.size === 0) throw new AppError('EMPTY_FILE', 'O arquivo está vazio.');
  if (file.size > LIMITS.maxFileBytes) {
    throw new AppError('FILE_TOO_BIG', `A imagem é grande demais (${(file.size / 1048576).toFixed(1)} MB). O limite é ${LIMITS.maxFileBytes / 1048576} MB.`);
  }
  if (file.type && !ACCEPT.test(file.type)) {
    throw new AppError('NOT_IMAGE', 'Este arquivo não é uma imagem que o aplicativo consiga abrir (use JPG, PNG ou WebP).');
  }
  let bitmap = null;
  let img = null;
  let w; let h;
  try {
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      w = bitmap.width; h = bitmap.height;
    }
  } catch { bitmap = null; }
  if (!bitmap) {
    const url = URL.createObjectURL(file);
    try {
      img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('decode'));
        el.src = url;
      });
      w = img.naturalWidth; h = img.naturalHeight;
    } catch (e) {
      throw new AppError('DECODE_FAILED', 'Não foi possível abrir a imagem. O arquivo pode estar corrompido ou não ser uma foto.', e);
    } finally { URL.revokeObjectURL(url); }
  }
  if (!w || !h) throw new AppError('DECODE_FAILED', 'A imagem não tem dimensões válidas.');
  const scale = Math.min(1, LIMITS.maxDecodeSide / Math.max(w, h));
  const canvas = makeCanvas(w * scale, h * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap ?? img, 0, 0, canvas.width, canvas.height);
  if (bitmap && bitmap.close) bitmap.close();
  const warnings = [];
  if (Math.max(canvas.width, canvas.height) < LIMITS.minSide) warnings.push('A imagem é muito pequena; a leitura pode falhar. Aproxime-se da etiqueta.');
  return { canvas, width: canvas.width, height: canvas.height, warnings };
}

/** Lê pixels como escala de cinza (0..255). */
export function toGray(canvas) {
  const { width: w, height: h } = canvas;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
  return { gray, w, h };
}

export function grayToCanvas(gray, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(w, h);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    out.data[i] = out.data[i + 1] = out.data[i + 2] = gray[j];
    out.data[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

/* ------------------------- análise de qualidade ------------------------- */

/** Mede brilho, contraste e nitidez (variância do Laplaciano) e gera avisos úteis. */
export function analyzeQuality(canvas) {
  // reduz para análise rápida
  const side = 640;
  const k = Math.min(1, side / Math.max(canvas.width, canvas.height));
  const small = makeCanvas(canvas.width * k, canvas.height * k);
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
  const { gray, w, h } = toGray(small);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const mean = sum / gray.length;
  let varSum = 0;
  for (let i = 0; i < gray.length; i++) varSum += (gray[i] - mean) ** 2;
  const std = Math.sqrt(varSum / gray.length);
  let lap = 0; let n = 0; let lapMean = 0;
  const vals = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      vals.push(v); lapMean += v; n++;
    }
  }
  lapMean /= Math.max(1, n);
  for (const v of vals) lap += (v - lapMean) ** 2;
  const sharpness = lap / Math.max(1, n);
  releaseCanvas(small);

  const warnings = [];
  const dark = mean < 70;
  const bright = mean > 225 && std < 35; // papel branco com texto escuro NÃO é foto estourada
  const lowContrast = std < 28;
  const blurry = sharpness < 60;
  if (dark) warnings.push('A foto está escura. Procure um local mais iluminado ou use o flash.');
  if (bright) warnings.push('A foto está muito clara/estourada. Evite reflexos e luz direta sobre a etiqueta.');
  if (lowContrast && !dark && !bright) warnings.push('A foto tem pouco contraste. Aproxime-se e centralize a etiqueta.');
  if (blurry) warnings.push('A foto parece desfocada. Segure firme, espere focar e tire novamente.');
  return { mean, std, sharpness, dark, bright, lowContrast, blurry, warnings };
}

/* ------------------------------ geometria ------------------------------ */

export function rotateCanvas(canvas, degrees) {
  const rad = (degrees * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  const w = canvas.width * cos + canvas.height * sin;
  const h = canvas.width * sin + canvas.height * cos;
  const out = makeCanvas(w, h);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(rad);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

/** Recorta por retângulo em frações (0..1) da imagem. */
export function cropCanvas(canvas, { x, y, w, h }) {
  const sx = Math.max(0, Math.round(x * canvas.width));
  const sy = Math.max(0, Math.round(y * canvas.height));
  const sw = Math.min(canvas.width - sx, Math.round(w * canvas.width));
  const sh = Math.min(canvas.height - sy, Math.round(h * canvas.height));
  if (sw < 20 || sh < 20) throw new AppError('CROP_TOO_SMALL', 'A área de recorte é pequena demais.');
  const out = makeCanvas(sw, sh);
  out.getContext('2d', { willReadFrequently: true }).drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return out;
}

export function scaleToSide(canvas, targetSide, { allowUpscale = true, maxUpscale = 2 } = {}) {
  const longSide = Math.max(canvas.width, canvas.height);
  let k = targetSide / longSide;
  if (k > 1) k = allowUpscale ? Math.min(k, maxUpscale) : 1;
  if (Math.abs(k - 1) < 0.02) return canvas;
  const out = makeCanvas(canvas.width * k, canvas.height * k);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

/* ------------------------------ inclinação ------------------------------ */

/** Limiar de Otsu sobre histograma de 256 níveis. */
export function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i] | 0]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0; let wB = 0; let best = 0; let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/**
 * Estima o ângulo de inclinação do texto (graus) pelo perfil de projeção:
 * o ângulo em que as linhas de texto ficam mais "concentradas" em faixas horizontais.
 */
export function estimateSkew(canvas) {
  const side = 700;
  const k = Math.min(1, side / Math.max(canvas.width, canvas.height));
  const small = makeCanvas(canvas.width * k, canvas.height * k);
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
  const { gray, w, h } = toGray(small);
  releaseCanvas(small);
  const thr = otsu(gray);
  // pontos "tinta": o lado menos frequente (texto é minoria)
  let dark = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] < thr) dark++;
  const inkIsDark = dark <= gray.length / 2;
  const pts = [];
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const isInk = inkIsDark ? gray[y * w + x] < thr : gray[y * w + x] >= thr;
      if (isInk) pts.push(x, y);
    }
  }
  if (pts.length < 200) return { angle: 0, confidence: 0 };
  const diag = Math.ceil(Math.hypot(w, h)) + 2;
  const scoreFor = (deg) => {
    const rad = (deg * Math.PI) / 180;
    const sin = Math.sin(rad); const cos = Math.cos(rad);
    const bins = new Uint32Array(diag * 2);
    for (let i = 0; i < pts.length; i += 2) {
      const yr = pts[i + 1] * cos - pts[i] * sin + diag;
      bins[yr | 0]++;
    }
    let s = 0;
    for (let i = 0; i < bins.length; i++) s += bins[i] * bins[i];
    return s;
  };
  const base = scoreFor(0);
  let best = 0; let bestScore = base;
  for (let a = -15; a <= 15; a += 1) {
    const s = scoreFor(a);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  for (let a = best - 0.8; a <= best + 0.8; a += 0.2) {
    const s = scoreFor(a);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  const gain = base > 0 ? bestScore / base - 1 : 0;
  return { angle: Math.round(best * 10) / 10, confidence: gain };
}

/** Corrige a inclinação só quando há ganho claro (evita "consertar" o que já está reto). */
export function deskew(canvas) {
  const { angle, confidence } = estimateSkew(canvas);
  if (Math.abs(angle) < 0.8 || confidence < 0.04) return { canvas, angle: 0, applied: false, detected: angle };
  // o texto inclinado em +angle precisa ser girado em -angle
  return { canvas: rotateCanvas(canvas, -angle), angle, applied: true, detected: angle };
}

/* ----------------------------- pré-processamento ----------------------------- */

function stretchContrast(gray, lowPct = 0.01, highPct = 0.99) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  let acc = 0; let lo = 0; let hi = 255;
  const total = gray.length;
  for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc >= total * lowPct) { lo = t; break; } }
  acc = 0;
  for (let t = 255; t >= 0; t--) { acc += hist[t]; if (acc >= total * (1 - highPct)) { hi = t; break; } }
  if (hi - lo < 20) return gray;
  const out = new Uint8ClampedArray(gray.length);
  const scale = 255 / (hi - lo);
  for (let i = 0; i < gray.length; i++) out[i] = (gray[i] - lo) * scale;
  return out;
}

/** Média local rápida com imagem integral (raio r). */
function boxMean(gray, w, h, r) {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let row = 0;
    for (let x = 1; x <= w; x++) {
      row += gray[(y - 1) * w + (x - 1)];
      integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r); const y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r); const x1 = Math.min(w - 1, x + r);
      const a = integral[(y1 + 1) * (w + 1) + (x1 + 1)] - integral[y0 * (w + 1) + (x1 + 1)] - integral[(y1 + 1) * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      out[y * w + x] = a / ((y1 - y0 + 1) * (x1 - x0 + 1));
    }
  }
  return out;
}

/** Nivela iluminação irregular dividindo pelo fundo estimado (borrão grande). */
function flattenIllumination(gray, w, h) {
  const r = Math.max(12, Math.round(Math.min(w, h) / 10));
  const bg = boxMean(gray, w, h, r);
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const b = Math.max(40, bg[i]);
    out[i] = Math.min(255, (gray[i] / b) * 215);
  }
  return out;
}

/** Nitidez leve (máscara de desfoque 3x3, intensidade controlada). */
function mildSharpen(gray, w, h, amount = 0.5) {
  const out = new Uint8ClampedArray(gray.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { out[i] = gray[i]; continue; }
      const blur = (gray[i] * 4 + gray[i - 1] * 2 + gray[i + 1] * 2 + gray[i - w] * 2 + gray[i + w] * 2
        + gray[i - w - 1] + gray[i - w + 1] + gray[i + w - 1] + gray[i + w + 1]) / 16;
      out[i] = gray[i] + amount * (gray[i] - blur);
    }
  }
  return out;
}

/** Limiar adaptativo (Sauvola) — último recurso para iluminação muito irregular. */
function sauvola(gray, w, h) {
  const r = Math.max(8, Math.round(Math.min(w, h) / 40));
  const mean = boxMean(gray, w, h, r);
  const sq = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) sq[i] = gray[i] * gray[i];
  const mean2 = boxMean(sq, w, h, r);
  const out = new Uint8ClampedArray(gray.length);
  const k = 0.2; const R = 128;
  for (let i = 0; i < gray.length; i++) {
    const std = Math.sqrt(Math.max(0, mean2[i] - mean[i] * mean[i]));
    const t = mean[i] * (1 + k * (std / R - 1));
    out[i] = gray[i] > t ? 255 : 0;
  }
  return out;
}

export const PREPROCESS_MODES = {
  padrao: 'Padrão (cinza + contraste)',
  contraste: 'Iluminação nivelada + nitidez',
  binario: 'Preto e branco adaptativo',
};

/**
 * Gera a imagem de trabalho para o OCR.
 * @param mode 'padrao' | 'contraste' | 'binario'
 */
export function preprocess(canvas, mode = 'padrao') {
  // Escala conservadora: ampliar demais ou reduzir demais piora a leitura de dígitos pequenos.
  const longSide = Math.max(canvas.width, canvas.height);
  let sized = canvas;
  if (longSide < LIMITS.smallSide) sized = scaleToSide(canvas, LIMITS.smallTarget, { allowUpscale: true, maxUpscale: 2 });
  else if (longSide > LIMITS.workSide) sized = scaleToSide(canvas, LIMITS.workSide, { allowUpscale: false });
  let { gray, w, h } = toGray(sized);
  if (mode === 'padrao') {
    gray = stretchContrast(gray);
  } else if (mode === 'contraste') {
    gray = flattenIllumination(gray, w, h);
    gray = stretchContrast(gray, 0.005, 0.995);
    gray = mildSharpen(gray, w, h, 0.6);
  } else if (mode === 'binario') {
    gray = flattenIllumination(gray, w, h);
    gray = sauvola(gray, w, h);
  }
  const out = grayToCanvas(gray, w, h);
  if (sized !== canvas) releaseCanvas(sized);
  return out;
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new AppError('ENCODE_FAILED', 'Não foi possível preparar a imagem para leitura.'))), type, quality);
  });
}
