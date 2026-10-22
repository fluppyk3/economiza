// Scanner: escolher/capturar foto -> prévia (girar/recortar) -> leitura OCR -> revisão -> salvar.
import { h, icon, clear } from './src__ui__dom.js';
import { button, banner, badge, toast, confirmDialog, selectInput, field } from './src__ui__components.js';
import { productForm } from './src__ui__form.js';
import { cameraSupport, startCamera, stopCamera, captureFrame } from './src__ocr__camera.js';
import { loadImage, rotateCanvas, cropCanvas, releaseCanvas } from './src__ocr__image.js';
import { prepareSource, readLabel, ATTEMPTS } from './src__ocr__ocr.js';
import { centsToInputString, formatBRL } from './src__core__money.js';
import { similarity, newId } from './src__core__text.js';
import { PRICE_BASIS_LABEL, formatQuantity } from './src__core__units.js';
import { go } from './src__ui__ctx.js';

export async function render(root, _p, ctx) {
  const S = { stage: 'choose', canvas: null, stream: null, video: null, abort: null, scan: null, read: null, submissionId: null, objectUrl: null };
  const view = h('div', { id: 'scanner-view' });
  root.append(h('div', { class: 'page-title' }, h('h1', {}, 'Scanner de etiquetas'), h('p', {}, 'Fotografe a etiqueta de preço. O aplicativo lê o texto e você confere antes de salvar.')), view);

  const cleanupCam = () => { if (S.stream) { stopCamera(S.stream, S.video); S.stream = null; } };
  const dispose = () => { cleanupCam(); S.abort?.abort(); if (S.canvas) { releaseCanvas(S.canvas); S.canvas = null; } ctx.engine.onStatus = null; };
  const show = (...nodes) => { clear(view); view.append(...nodes.flat().filter(Boolean)); };
  const fail = (e, back = chooseStage) => { show(banner({ tone: 'error', title: 'Não deu certo', text: e?.message ?? 'Erro inesperado.', actions: [button({ label: 'Voltar', variant: 'primary', onClick: back }), button({ label: 'Cadastrar manualmente', onClick: () => go('produtos/novo') })] })); };

  /* ------------------------------ escolher ------------------------------ */
  function chooseStage() {
    cleanupCam(); S.stage = 'choose';
    if (S.canvas) { releaseCanvas(S.canvas); S.canvas = null; }
    const sup = cameraSupport();
    const mkFile = (id, capture) => {
      const inp = h('input', { type: 'file', accept: 'image/*', id, class: 'sr-only', capture: capture ? 'environment' : null });
      inp.addEventListener('change', () => { const f = inp.files?.[0]; inp.value = ''; if (f) onFile(f); });
      return inp;
    };
    const lbl = (id, ic, text, cls) => h('label', { class: `btn ${cls}`, for: id }, icon(ic, { size: 20 }), h('span', {}, text));
    show(
      h('div', { class: 'card' },
        h('div', { class: 'btn-row' },
          sup.live ? button({ label: 'Usar a câmera', icon: 'camera', variant: 'primary', id: 'btn-camera', onClick: cameraStage }) : null,
          lbl('file-capture', 'camera', 'Tirar foto', sup.live ? 'btn-secondary' : 'btn-primary'),
          lbl('file-gallery', 'image', 'Escolher da galeria', 'btn-secondary')),
        mkFile('file-capture', true), mkFile('file-gallery', false),
        !sup.live ? h('p', { class: 'muted small', style: 'margin-top:.7rem' }, sup.message) : null),
      h('div', { class: 'card flat' }, h('h2', {}, 'Para uma boa leitura'),
        h('ul', { class: 'tips' }, h('li', {}, 'Boa luz, sem reflexo sobre a etiqueta.'), h('li', {}, 'Aproxime até a etiqueta ocupar boa parte da foto.'), h('li', {}, 'Segure firme e espere a câmera focar.'), h('li', {}, 'Mantenha a etiqueta reta (sem muita inclinação).'))),
      h('p', { class: 'small' }, 'Prefere não usar foto? ', h('a', { href: '#/produtos/novo' }, 'Cadastre manualmente')));
  }

  /* ------------------------------- câmera ------------------------------- */
  async function cameraStage() {
    S.stage = 'camera';
    const video = h('video', { playsinline: true, muted: true, 'aria-label': 'Imagem da câmera' });
    S.video = video;
    const status = h('p', { class: 'muted', role: 'status' }, 'Abrindo a câmera…');
    const shoot = button({ label: 'Capturar', icon: 'camera', variant: 'primary', disabled: true, id: 'btn-capture', onClick: () => {
      try { const c = captureFrame(video); cleanupCam(); previewStage(c); } catch (e) { toast(e.message, { tone: 'error' }); } } });
    show(h('div', { class: 'camera-box' }, video, h('div', { class: 'camera-guide', 'aria-hidden': 'true' })), status,
      h('div', { class: 'btn-row' }, shoot, button({ label: 'Cancelar', variant: 'secondary', onClick: chooseStage })));
    try { S.stream = await startCamera(video); status.textContent = 'Enquadre a etiqueta dentro da moldura e toque em Capturar.'; shoot.disabled = false; }
    catch (e) { show(banner({ tone: 'warn', title: 'Câmera indisponível', text: e.message, actions: [button({ label: 'Voltar', variant: 'primary', onClick: chooseStage })] })); }
  }

  /* ------------------------------- arquivo ------------------------------ */
  async function onFile(file) {
    show(h('p', { role: 'status' }, 'Abrindo a imagem…'));
    try { const img = await loadImage(file); previewStage(img.canvas, img.warnings); }
    catch (e) { fail(e); }
  }

  /* -------------------------------- prévia ------------------------------ */
  function previewStage(canvas, warnings = []) {
    S.stage = 'preview'; S.canvas = canvas;
    const wrap = h('div', { class: 'preview-wrap', id: 'preview-wrap' });
    const crop = { l: 0, r: 0, t: 0, b: 0 };
    const box = h('div', { class: 'crop-box', hidden: true });
    const drawCanvas = () => { wrap.replaceChildren(S.canvas, box); drawBox(); };
    const drawBox = () => {
      const on = crop.l || crop.r || crop.t || crop.b;
      box.hidden = !on;
      Object.assign(box.style, { left: `${crop.l}%`, top: `${crop.t}%`, right: `${crop.r}%`, bottom: `${crop.b}%` });
    };
    const rot = (deg) => { const n = rotateCanvas(S.canvas, deg); releaseCanvas(S.canvas); S.canvas = n; Object.assign(crop, { l: 0, r: 0, t: 0, b: 0 }); drawCanvas(); };
    const slider = (key, label) => {
      const id = `crop-${key}`;
      const inp = h('input', { type: 'range', id, min: 0, max: 40, step: 1, value: 0, onInput: () => { crop[key] = Number(inp.value); drawBox(); } });
      return h('div', { class: 'field' }, h('label', { for: id }, label), inp);
    };
    const cropPanel = h('details', { class: 'raw' }, h('summary', {}, 'Recortar (opcional)'),
      h('div', { class: 'two-col' }, slider('l', 'Esquerda'), slider('r', 'Direita'), slider('t', 'Topo'), slider('b', 'Base')));
    drawCanvas();
    const read = button({ label: 'Ler etiqueta', icon: 'search', variant: 'primary', id: 'btn-read', onClick: () => {
      let c = S.canvas;
      if (crop.l || crop.r || crop.t || crop.b) {
        const x = Math.round(c.width * crop.l / 100); const y = Math.round(c.height * crop.t / 100);
        const w = Math.round(c.width * (100 - crop.l - crop.r) / 100); const hh = Math.round(c.height * (100 - crop.t - crop.b) / 100);
        if (w < 50 || hh < 50) { toast('A área recortada ficou pequena demais.', { tone: 'warn' }); return; }
        c = cropCanvas(c, { x, y, w, h: hh });
      }
      startRead(c, c !== S.canvas);
    } });
    show(warnings.length ? banner({ tone: 'warn', text: warnings.join(' ') }) : null,
      h('div', { style: 'text-align:center;margin-bottom:1rem' }, wrap),
      h('div', { class: 'btn-row' }, button({ label: 'Girar à esquerda', icon: 'rotate', variant: 'secondary', onClick: () => rot(-90) }), button({ label: 'Girar à direita', icon: 'rotate', variant: 'secondary', onClick: () => rot(90) })),
      cropPanel,
      h('div', { class: 'btn-row', style: 'margin-top:1rem' }, read, button({ label: 'Escolher outra foto', variant: 'secondary', onClick: chooseStage })));
  }

  /* ------------------------------- leitura ------------------------------ */
  async function startRead(canvas, ownsCanvas, opts = {}) {
    S.stage = 'reading';
    S.abort = new AbortController();
    const bar = h('progress', { max: 1, value: 0, 'aria-label': 'Progresso da leitura' });
    const msg = h('p', { role: 'status', id: 'read-status' }, 'Preparando…');
    const step = h('p', { class: 'muted small' });
    show(h('div', { class: 'card' }, h('h2', {}, 'Lendo a etiqueta…'), msg, bar, step,
      h('p', { class: 'muted small' }, 'A leitura acontece neste aparelho e pode levar alguns segundos. Na primeira vez o motor precisa ser carregado.'),
      button({ label: 'Cancelar', variant: 'secondary', onClick: () => { S.abort.abort(); } })));
    ctx.engine.onStatus = ({ message, progress }) => { msg.textContent = message; if (progress !== null) bar.value = progress; };
    try {
      const prepared = opts.prepared ?? prepareSource(canvas);
      S.prepared = prepared;
      const out = await readLabel(prepared, ctx.engine, {
        signal: S.abort.signal, maxAttempts: opts.maxAttempts ?? 3, startAt: opts.startAt ?? 0, previous: opts.previous ?? [],
        onAttempt: (plan, i) => { step.textContent = `Tentativa ${i + 1}: ${plan.label}`; bar.value = 0; },
      });
      S.read = out;
      S.submissionId = newId('sub');
      const r = out.result;
      const scan = await ctx.repo.addScan({ status: 'pending', rawText: r.rawText, summary: [r.name.title, r.price.cents ? formatBRL(r.price.cents) : ''].filter(Boolean).join(' — ') || 'Leitura sem resultado', attempts: out.attempts.length });
      S.scan = scan;
      reviewStage();
    } catch (e) {
      if (e.code === 'CANCELLED') { toast('Leitura cancelada.'); if (S.canvas) previewStage(S.canvas); else chooseStage(); return; }
      fail(e, () => (S.canvas ? previewStage(S.canvas) : chooseStage()));
    } finally { ctx.engine.onStatus = null; if (ownsCanvas) releaseCanvas(canvas); }
  }

  /* ------------------------------- revisão ------------------------------ */
  async function reviewStage() {
    S.stage = 'review';
    const { result: r, notes, attempts } = S.read;
    const products = await ctx.repo.listProducts({ includeDemo: false });
    const initial = { category: 'Outros', store: ctx.settings?.lastStore ?? '', basis: 'package', kind: 'regular' };
    const hints = {};
    const nameVal = r.name.title;
    if (r.name.decision !== 'vazio' && nameVal) initial.name = nameVal;
    hints.name = { decision: r.name.decision, reasons: r.name.reasons, alternatives: (r.name.alternatives ?? []).filter((a) => a.title && a.title !== nameVal).map((a) => ({ label: a.title, value: a.title })) };
    if (r.price.cents && r.price.decision !== 'vazio') {
      initial.price = centsToInputString(r.price.cents); initial.basis = r.price.basis; initial.kind = r.price.role === 'promo' ? 'promo' : 'regular';
      if (r.previousPrice?.cents && r.previousPrice.coherent) initial.previousPrice = centsToInputString(r.previousPrice.cents);
    }
    hints.price = { decision: r.price.decision, reasons: r.price.reasons, alternatives: (r.candidates ?? []).filter((c) => c.role !== 'installment' && !(c.cents === r.price.cents && c.isPrimary)).slice(0, 5).map((c) => ({ label: `${c.display}${c.basis !== 'package' ? ` ${PRICE_BASIS_LABEL[c.basis]}` : ''}${c.role === 'old' || c.role === 'previous' ? ' (preço antigo)' : ''}`, value: centsToInputString(c.cents), basis: c.basis })) };
    if (r.quantity) {
      const usable = r.quantity.decision !== 'vazio';
      if (usable) { initial.packQty = r.quantity.baseQty; initial.packUnit = r.quantity.baseUnit; }
      hints.quantity = { decision: r.quantity.decision, reasons: r.quantity.reasons, alternatives: (r.quantity.alternatives ?? []).map((a) => ({ label: a.text, ...a })) };
    }
    if (r.barcode?.digits && r.barcode.valid) initial.barcode = r.barcode.digits;

    // produto parecido já cadastrado? (para registrar só um novo preço)
    const similar = nameVal ? products.map((p) => ({ p, s: similarity(p.name, nameVal) })).filter((x) => x.s >= 0.8).sort((a, b) => b.s - a.s).slice(0, 3) : [];
    let target = 'new';
    const targetSel = similar.length ? selectInput({ id: 'target', value: 'new', options: [{ value: 'new', label: 'Cadastrar como novo produto' }, ...similar.map((x) => ({ value: x.p.id, label: `Novo preço de: ${x.p.name}` }))], onChange: () => { target = targetSel.value; } }) : null;

    const st = [...new Set((await ctx.repo.allPrices()).map((p) => p.store).filter(Boolean))].slice(0, 30);
    const form = productForm({
      initial, hints, stores: st, submitLabel: 'Confirmar e salvar',
      onCancel: discard,
      onSubmit: async (v) => {
        try {
          let res;
          if (target !== 'new') {
            if (!v.cents) { form.showErrors({ price: 'Informe o preço para registrar no produto existente.' }); return; }
            res = await ctx.repo.addPrice(target, { cents: v.cents, basis: v.basis, kind: v.kind, previousCents: v.previousCents, store: v.store }, { origin: 'scanner', submissionId: S.submissionId, scanId: S.scan.id });
            await ctx.repo.setScanStatus(S.scan.id, 'saved');
          } else {
            res = await ctx.repo.createProduct(v, { origin: 'scanner', submissionId: S.submissionId, scanId: S.scan.id });
          }
          if (v.store) await ctx.repo.setSettings({ lastStore: v.store });
          toast(res.duplicate ? 'Esta leitura já tinha sido salva.' : 'Salvo com sucesso.', { tone: 'ok' });
          dispose(); go(`produtos/${res.product.id}`);
        } catch (e) { toast(e.message || 'Não foi possível salvar.', { tone: 'error' }); }
      },
    });

    const allNotes = [...new Set([...(notes ?? []), ...(r.warnings ?? [])])];
    const more = S.read.nextPlanIndex >= 0;
    show(
      h('div', { class: 'banner banner-info' }, icon('info', { size: 20 }), h('div', { class: 'banner-body' }, h('strong', {}, 'Confira antes de salvar.'), h('div', {}, 'O que foi lido pode conter erros. Campos sem selo verde ficam em branco ou pedem confirmação. Nada é salvo até você tocar em "Confirmar e salvar".'))),
      allNotes.length ? banner({ tone: 'warn', title: 'Atenção', text: h('ul', {}, allNotes.map((n) => h('li', {}, n))) }) : null,
      h('div', { class: 'card' }, targetSel ? field({ id: 'target', label: 'Este produto já existe?', children: targetSel, hint: 'Encontramos produto(s) com nome parecido. Escolha para só registrar um novo preço.' }) : null, form.el),
      h('details', { class: 'raw card flat' }, h('summary', {}, 'Ver o texto lido pela câmera'), h('pre', {}, r.rawText || '(nenhum texto)'),
        r.rejectedNumbers?.length ? h('p', { class: 'small muted' }, `Números ignorados: ${r.rejectedNumbers.slice(0, 8).map((n) => `${n.raw} (${n.reason})`).join('; ')}`) : null,
        h('p', { class: 'small muted' }, `Tentativas de leitura: ${attempts.map((a) => a.plan.label).join(' → ')}`)),
      h('div', { class: 'btn-row' },
        more ? button({ label: 'Ler de novo com outro processamento', icon: 'rotate', variant: 'secondary', onClick: () => startRead(null, false, { prepared: S.prepared, previous: S.read.attempts, startAt: S.read.nextPlanIndex, maxAttempts: 1 }) }) : null,
        button({ label: 'Tirar outra foto', variant: 'secondary', onClick: async () => { await ctx.repo.setScanStatus(S.scan.id, 'discarded'); chooseStage(); } })));
  }

  async function discard() {
    if (!(await confirmDialog({ title: 'Descartar esta leitura?', message: 'Nada será salvo.', confirmLabel: 'Descartar', danger: true }))) return;
    await ctx.repo.setScanStatus(S.scan.id, 'discarded'); chooseStage();
  }

  chooseStage();
  return dispose;
}
