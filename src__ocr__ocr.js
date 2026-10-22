// Integração com o Tesseract.js (OCR real, executado no próprio aparelho/navegador).
// Os arquivos do motor ficam em vendor/tesseract/ (nada é enviado a servidores externos).
import { AppError } from './src__core__errors.js';
import { interpretLabel, mergeAttempts, looksPoor, resultQuality } from './src__core__interpret.js';
import { analyzeQuality, deskew, preprocess, canvasToBlob, releaseCanvas } from './src__ocr__image.js';

const VENDOR = new URL('./', import.meta.url);
export const OCR_LANG = 'por';
export const ATTEMPT_TIMEOUT_MS = 60_000;
export const TOTAL_BUDGET_MS = 120_000;

/** Plano de tentativas: cada uma usa outro pré-processamento e outro modo de segmentação. */
export const ATTEMPTS = [
  { id: 'a1', pre: 'padrao', psm: 3, regroup: false, label: 'Leitura padrão' },
  { id: 'a2', pre: 'contraste', psm: 11, regroup: true, label: 'Iluminação nivelada, texto esparso' },
  { id: 'a3', pre: 'binario', psm: 6, regroup: true, label: 'Preto e branco adaptativo, bloco único' },
];

const STATUS_PT = {
  'loading tesseract core': 'Carregando o motor de leitura…',
  'initializing tesseract': 'Iniciando o motor de leitura…',
  'loading language traineddata': 'Carregando o idioma português…',
  'initializing api': 'Preparando a leitura…',
  'recognizing text': 'Lendo o texto da etiqueta…',
};

let scriptPromise = null;
function loadTesseractScript() {
  if (typeof globalThis.Tesseract !== 'undefined') return Promise.resolve(globalThis.Tesseract);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('tesseract.min.js', VENDOR).href;
    s.async = true;
    s.onload = () => (globalThis.Tesseract ? resolve(globalThis.Tesseract) : reject(new Error('Tesseract ausente')));
    s.onerror = () => reject(new Error('script'));
    document.head.appendChild(s);
  }).catch((e) => {
    scriptPromise = null;
    throw new AppError('OCR_LOAD_FAILED', 'Não foi possível carregar o motor de leitura (OCR). Verifique se os arquivos do motor OCR estão junto do aplicativo e, se estiver usando o aplicativo pela internet, se há conexão. Você ainda pode cadastrar o produto manualmente.', e);
  });
  return scriptPromise;
}

/* ------------------------- conversão do resultado ------------------------- */

const cleanText = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/** Linhas do Tesseract -> { text, confidence, bbox, words[] } */
export function linesFromData(data) {
  const out = [];
  for (const block of data?.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const ln of para.lines ?? []) {
        const words = (ln.words ?? []).map((w) => ({ text: cleanText(w.text), confidence: w.confidence, bbox: w.bbox })).filter((w) => w.text);
        const text = cleanText(ln.text) || words.map((w) => w.text).join(' ');
        if (!text) continue;
        out.push({ text, confidence: ln.confidence, bbox: ln.bbox, words });
      }
    }
  }
  return out;
}

/** Reagrupa palavras em linhas pela sobreposição vertical (útil no modo de texto esparso). */
export function regroupWords(lines) {
  const words = lines.flatMap((l) => l.words ?? []).filter((w) => w.bbox);
  if (!words.length) return lines;
  const hs = words.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
  const med = hs[Math.floor(hs.length / 2)] || 20;
  const sorted = [...words].sort((a, b) => (a.bbox.y0 + a.bbox.y1) - (b.bbox.y0 + b.bbox.y1));
  const groups = [];
  for (const w of sorted) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    const g = groups.find((gr) => {
      const overlap = Math.min(gr.y1, w.bbox.y1) - Math.max(gr.y0, w.bbox.y0);
      return overlap >= 0.5 * Math.min(gr.y1 - gr.y0, w.bbox.y1 - w.bbox.y0) && Math.abs(cy - gr.cy) < med * 0.8;
    });
    if (g) {
      g.words.push(w);
      g.y0 = Math.min(g.y0, w.bbox.y0); g.y1 = Math.max(g.y1, w.bbox.y1);
      g.cy = (g.y0 + g.y1) / 2;
    } else groups.push({ words: [w], y0: w.bbox.y0, y1: w.bbox.y1, cy });
  }
  return groups.sort((a, b) => a.y0 - b.y0).map((g) => {
    const ws = g.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const lenSum = ws.reduce((s, w) => s + w.text.length, 0) || 1;
    return {
      text: ws.map((w) => w.text).join(' '),
      confidence: ws.reduce((s, w) => s + (w.confidence ?? 0) * w.text.length, 0) / lenSum,
      bbox: { x0: Math.min(...ws.map((w) => w.bbox.x0)), y0: g.y0, x1: Math.max(...ws.map((w) => w.bbox.x1)), y1: g.y1 },
      words: ws,
    };
  });
}

/* --------------------------------- motor --------------------------------- */

export class OcrEngine {
  constructor({ idleMs = 120_000 } = {}) {
    this.worker = null;
    this.creating = null;
    this.idleMs = idleMs;
    this.idleTimer = null;
    this.onStatus = null;
    this.currentPsm = null;
    this.busy = false;
  }

  status(message, progress = null) { if (this.onStatus) this.onStatus({ message, progress }); }

  async #create() {
    const T = await loadTesseractScript();
    this.status('Carregando o motor de leitura…', 0);
    try {
      const worker = await T.createWorker(OCR_LANG, 1, {
        workerPath: new URL('worker.min.js', VENDOR).href,
        // Os arquivos foram achatados na raiz para facilitar o upload pelo celular.
        // O Tesseract deve procurar os motores WASM e o idioma diretamente nessa raiz.
        corePath: VENDOR.href,
        langPath: VENDOR.href,
        gzip: true,
        workerBlobURL: false,
        cacheMethod: 'none',
        logger: (m) => {
          const msg = STATUS_PT[m.status];
          if (msg) this.status(msg, typeof m.progress === 'number' ? m.progress : null);
        },
      });
      await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
      return worker;
    } catch (e) {
      throw new AppError('OCR_INIT_FAILED', 'O motor de leitura não conseguiu iniciar. Os arquivos do OCR podem estar ausentes ou indisponíveis offline. Você ainda pode cadastrar o produto manualmente.', e);
    }
  }

  async ensure() {
    clearTimeout(this.idleTimer);
    if (this.worker) return this.worker;
    if (!this.creating) {
      this.creating = this.#create().then((w) => { this.worker = w; this.creating = null; return w; }, (e) => { this.creating = null; throw e; });
    }
    return this.creating;
  }

  /** Reconhece uma imagem (Blob). Respeita tempo limite e cancelamento. */
  async recognize(blob, { psm = 3, signal, timeoutMs = ATTEMPT_TIMEOUT_MS } = {}) {
    if (this.busy) throw new AppError('OCR_BUSY', 'Já existe uma leitura em andamento.');
    this.busy = true;
    let timer; let onAbort;
    try {
      const worker = await this.ensure();
      if (signal?.aborted) throw new AppError('CANCELLED', 'Leitura cancelada.');
      if (this.currentPsm !== psm) { await worker.setParameters({ tessedit_pageseg_mode: String(psm) }); this.currentPsm = psm; }
      const guard = new Promise((_, reject) => {
        timer = setTimeout(() => { this.terminate(); reject(new AppError('OCR_TIMEOUT', 'A leitura demorou demais e foi interrompida. Tente uma foto menor ou mais nítida.')); }, timeoutMs);
        if (signal) {
          onAbort = () => { this.terminate(); reject(new AppError('CANCELLED', 'Leitura cancelada.')); };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      const result = await Promise.race([worker.recognize(blob, {}, { blocks: true, text: true }), guard]);
      return result.data;
    } catch (e) {
      if (e instanceof AppError) throw e;
      this.terminate();
      throw new AppError('OCR_FAILED', 'A leitura da imagem falhou. Tente novamente com outra foto.', e);
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      this.busy = false;
      this.#scheduleIdle();
    }
  }

  #scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.terminate(), this.idleMs);
  }

  /** Encerra o worker (libera memória). Uma nova leitura cria outro automaticamente. */
  terminate() {
    clearTimeout(this.idleTimer);
    const w = this.worker;
    this.worker = null; this.creating = null; this.currentPsm = null;
    if (w) { try { w.terminate(); } catch { /* já encerrado */ } }
  }
}

/* ------------------------------ pipeline ------------------------------ */

/** Prepara a imagem (qualidade + correção de inclinação) uma única vez por foto. */
export function prepareSource(canvas) {
  const quality = analyzeQuality(canvas);
  const d = deskew(canvas);
  return { canvas: d.canvas, original: canvas, quality, deskew: { angle: d.angle, applied: d.applied, detected: d.detected } };
}

export async function runAttempt(prepared, plan, engine, { signal } = {}) {
  const t0 = performance.now();
  const work = preprocess(prepared.canvas, plan.pre);
  let blob;
  try { blob = await canvasToBlob(work, 'image/png'); } finally { releaseCanvas(work); }
  const data = await engine.recognize(blob, { psm: plan.psm, signal });
  let lines = linesFromData(data);
  if (plan.regroup) lines = regroupWords(lines);
  const interpretation = interpretLabel(lines);
  return { plan, ms: Math.round(performance.now() - t0), interpretation, lineCount: lines.length };
}

/**
 * Lê a etiqueta. Tenta o processamento padrão e, se o resultado for fraco, uma alternativa
 * (até `maxAttempts`, dentro do orçamento de tempo). Cada campo é combinado separadamente.
 * @param previous tentativas anteriores (para "tentar de novo com outro processamento")
 */
export async function readLabel(prepared, engine, { signal, maxAttempts = 3, startAt = 0, previous = [], onAttempt } = {}) {
  const started = performance.now();
  const attempts = [...previous];
  const plans = ATTEMPTS.slice(startAt, startAt + maxAttempts);
  for (const plan of plans) {
    if (signal?.aborted) throw new AppError('CANCELLED', 'Leitura cancelada.');
    if (attempts.length && performance.now() - started > TOTAL_BUDGET_MS) break;
    onAttempt?.(plan, attempts.length);
    const a = await runAttempt(prepared, plan, engine, { signal });
    attempts.push(a);
    // Sempre confere com pelo menos 2 leituras; a 3ª só se o resultado for fraco ou houver divergência.
    if (attempts.length >= 2) {
      const m = mergeAttempts(attempts.map((x) => x.interpretation));
      const diverged = m.warnings.some((w) => /divergiram|diferentes/.test(w));
      if (!looksPoor(m) && !diverged) break;
    }
  }
  const merged = mergeAttempts(attempts.map((x) => x.interpretation));
  const notes = [...prepared.quality.warnings];
  if (prepared.deskew.applied) notes.push(`A foto estava inclinada (${prepared.deskew.angle}°) e foi endireitada.`);
  if (!attempts.some((a) => a.lineCount > 0)) notes.push('Nenhum texto foi reconhecido. Aproxime-se da etiqueta, melhore a luz e mantenha o celular firme.');
  return { result: merged, attempts, notes, quality: prepared.quality, score: resultQuality(merged), nextPlanIndex: ATTEMPTS.findIndex((p) => !attempts.some((a) => a.plan.id === p.id)) };
}
