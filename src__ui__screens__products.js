import { h, icon, fmtDateTime, fmtAgo, debounce } from './src__ui__dom.js';
import { button, badge, emptyState, textInput, selectInput, confirmDialog, modal, toast, banner, field } from './src__ui__components.js';
import { productForm } from './src__ui__form.js';
import { filterProducts } from './src__data__repo.js';
import { CATEGORIES } from './src__core__validation.js';
import { formatBRL, formatPercent } from './src__core__money.js';
import { formatQuantity, PRICE_BASIS_LABEL } from './src__core__units.js';
import { compareRecords, normalizedPrice } from './src__core__compare.js';
import { go, refresh } from './src__ui__ctx.js';
import { newId } from './src__core__text.js';
import { productList } from './src__ui__screens__home.js';

export async function render(root, params, ctx) {
  if (params[0] === 'novo') return renderNew(root, ctx);
  if (params[0] && params[1] === 'editar') return renderEdit(root, params[0], ctx);
  if (params[0]) return renderDetail(root, params[0], ctx);
  return renderList(root, ctx);
}

async function renderList(root, ctx) {
  const all = await ctx.repo.listProducts({ includeDemo: true });
  root.append(h('div', { class: 'page-title' }, h('h1', {}, 'Produtos'), button({ label: 'Novo produto', icon: 'plus', variant: 'primary', onClick: () => go('produtos/novo') })));
  if (!all.length) {
    root.append(emptyState({ title: 'Nenhum produto cadastrado', text: 'Leia uma etiqueta ou cadastre um produto manualmente.', actions: [button({ label: 'Ler etiqueta', icon: 'camera', variant: 'primary', onClick: () => go('scanner') }), button({ label: 'Cadastrar', icon: 'plus', onClick: () => go('produtos/novo') })] }));
    return;
  }
  const state = { query: '', category: '', sort: 'recent' };
  const results = h('div', { 'aria-live': 'polite' });
  const draw = () => {
    const list = filterProducts(all, state);
    results.replaceChildren(
      h('p', { class: 'muted small', id: 'result-count' }, `${list.length} ${list.length === 1 ? 'produto' : 'produtos'}`),
      list.length ? productList(list.map((p) => (p.isDemo ? { ...p, name: p.name } : p))) : emptyState({ title: 'Nada encontrado', text: 'Tente outras palavras ou limpe o filtro de categoria.', iconName: 'search' }));
  };
  const search = textInput({ id: 'q', type: 'search', placeholder: 'Buscar por nome, marca ou código', onInput: debounce(() => { state.query = search.value; draw(); }, 150) });
  search.setAttribute('aria-label', 'Buscar produtos');
  const cats = [...new Set([...CATEGORIES, ...all.map((p) => p.category)])];
  const cat = selectInput({ id: 'cat', value: '', options: [{ value: '', label: 'Todas as categorias' }, ...cats.map((c) => ({ value: c, label: c }))], onChange: () => { state.category = cat.value; draw(); } });
  cat.setAttribute('aria-label', 'Categoria');
  const sort = selectInput({ id: 'sort', value: 'recent', options: [{ value: 'recent', label: 'Mais recentes' }, { value: 'name', label: 'Nome (A–Z)' }, { value: 'price', label: 'Menor preço' }], onChange: () => { state.sort = sort.value; draw(); } });
  sort.setAttribute('aria-label', 'Ordenar');
  root.append(h('div', { class: 'toolbar' }, search, cat, sort), results);
  draw();
}

async function stores(ctx) {
  const prices = await ctx.repo.allPrices({ includeDemo: false });
  return [...new Set(prices.map((p) => p.store).filter(Boolean))].slice(0, 30);
}

async function renderNew(root, ctx) {
  root.append(h('div', { class: 'page-title' }, h('h1', {}, 'Novo produto')));
  const st = await stores(ctx);
  const settings = ctx.settings;
  const submissionId = newId('sub');
  const form = productForm({
    initial: { store: settings?.lastStore ?? '' }, stores: st, submitLabel: 'Salvar produto',
    onCancel: () => history.back(),
    onSubmit: async (v) => {
      try {
        const r = await ctx.repo.createProduct(v, { origin: 'manual', submissionId });
        if (v.store) await ctx.repo.setSettings({ lastStore: v.store });
        toast(r.duplicate ? 'Este cadastro já tinha sido salvo.' : 'Produto salvo.', { tone: 'ok' });
        go(`produtos/${r.product.id}`);
      } catch (e) { toast(e.message || 'Não foi possível salvar.', { tone: 'error' }); }
    },
  });
  root.append(h('div', { class: 'card' }, form.el));
}

async function renderEdit(root, id, ctx) {
  const p = await ctx.repo.getProduct(id);
  if (!p) { root.append(notFound()); return; }
  root.append(h('div', { class: 'page-title' }, h('h1', {}, 'Editar produto')));
  const form = productForm({
    initial: p, withPrice: false, submitLabel: 'Salvar alterações', onCancel: () => go(`produtos/${id}`),
    onSubmit: async (v) => {
      try {
        await ctx.repo.updateProduct(id, { name: v.name, brand: v.brand, category: v.category, packQty: v.packQty, packUnit: v.packUnit, barcode: v.barcode, notes: v.notes });
        toast('Alterações salvas. O histórico de preços foi mantido.', { tone: 'ok' });
        go(`produtos/${id}`);
      } catch (e) { toast(e.message || 'Não foi possível salvar.', { tone: 'error' }); }
    },
  });
  root.append(h('div', { class: 'card' }, form.el));
}

const notFound = () => emptyState({ title: 'Produto não encontrado', text: 'Ele pode ter sido excluído.', actions: [button({ label: 'Ver produtos', onClick: () => go('produtos') })] });

export function describeRecord(r, product) {
  const parts = [PRICE_BASIS_LABEL[r.basis]];
  if (r.basis === 'package') { const q = r.packQty ?? product?.packQty; const u = r.packUnit ?? product?.packUnit; if (q && u) parts.push(formatQuantity(q, u)); }
  if (r.kind === 'promo') parts.push('promoção');
  return parts.join(' · ');
}

async function renderDetail(root, id, ctx) {
  const p = await ctx.repo.getProduct(id);
  if (!p) { root.append(notFound()); return; }
  ctx.repo.touchProduct(id).catch(() => {});
  const prices = await ctx.repo.getPrices(id);
  const settings = ctx.settings;
  const q = p.packQty ? formatQuantity(p.packQty, p.packUnit) : '';

  root.append(h('div', { class: 'page-title' }, h('div', {}, h('h1', {}, p.name), h('div', { class: 'muted' }, [p.brand, p.category, q].filter(Boolean).join(' · '))),
    h('div', { class: 'btn-row' }, button({ label: 'Editar', icon: 'edit', onClick: () => go(`produtos/${id}/editar`) }), button({ label: 'Excluir', icon: 'trash', variant: 'secondary', onClick: onDelete }))));
  if (p.isDemo) root.append(banner({ tone: 'info', text: 'Este é um produto de demonstração. Os preços não são reais.' }));

  const last = prices[0];
  root.append(h('div', { class: 'card' },
    last ? h('div', {}, h('div', { class: 'muted small' }, `Último preço · ${fmtDateTime(last.observedAt)} (${fmtAgo(last.observedAt)})`),
      h('div', { class: 'price big' }, formatBRL(last.cents)),
      h('div', { class: 'muted' }, [describeRecord(last, p), last.store].filter(Boolean).join(' · ')),
      last.previousCents ? h('div', { class: 'muted small' }, `Preço anterior informado: ${formatBRL(last.previousCents)}`) : null,
      (() => { const n = normalizedPrice(last, p); return n && last.basis === 'package' ? h('div', { class: 'small muted' }, `Equivale a ${formatBRL(n.cents)} ${PRICE_BASIS_LABEL[n.per]}`) : null; })())
      : h('p', { class: 'muted' }, 'Nenhum preço registrado ainda.'),
    h('div', { class: 'btn-row', style: 'margin-top:.8rem' }, button({ label: 'Registrar novo preço', icon: 'plus', variant: 'primary', onClick: addPriceDialog }))));

  if (p.barcode || p.notes) root.append(h('div', { class: 'card flat' }, h('dl', { class: 'kv' },
    p.barcode ? [h('dt', {}, 'Código'), h('dd', {}, p.barcode)] : null, p.notes ? [h('dt', {}, 'Notas'), h('dd', {}, p.notes)] : null)));

  const cmp = compareRecords(prices, p, { staleDays: settings?.staleDays });
  if (prices.length >= 2) {
    root.append(h('h2', {}, 'Comparação entre registros'));
    if (cmp.comparable) {
      root.append(h('div', { class: 'card' },
        h('p', {}, `Base de comparação: ${cmp.label}.`),
        h('p', {}, h('strong', {}, 'Menor: '), `${formatBRL(cmp.min.cents)}${cmp.min.store ? ` (${cmp.min.store})` : ''} em ${fmtDateTime(cmp.min.observedAt)}`),
        h('p', {}, h('strong', {}, 'Maior: '), `${formatBRL(cmp.max.cents)}${cmp.max.store ? ` (${cmp.max.store})` : ''} em ${fmtDateTime(cmp.max.observedAt)}`),
        h('p', {}, cmp.sameValue ? 'Os valores são iguais.' : `Diferença: ${formatBRL(cmp.diffAbs)} (${formatPercent(cmp.diffPct)})`),
        cmp.staleCount ? h('p', { class: 'small muted' }, `${cmp.staleCount} registro(s) com mais de ${settings?.staleDays ?? 30} dias — o preço pode ter mudado.`) : null));
    } else root.append(banner({ tone: 'warn', text: cmp.reason }));
  }

  root.append(h('h2', {}, `Histórico de preços (${prices.length})`));
  if (!prices.length) root.append(h('p', { class: 'muted' }, 'Sem registros.'));
  else root.append(h('ul', { class: 'list', id: 'price-history' }, prices.map((r) => h('li', { class: 'row' },
    h('span', { class: `dot${r.kind === 'promo' ? ' promo' : ''}`, 'aria-hidden': 'true' }),
    h('div', { class: 'grow' }, h('div', { class: 'title' }, formatBRL(r.cents)), h('div', { class: 'meta' }, [fmtDateTime(r.observedAt), describeRecord(r, p), r.store, r.origin === 'scanner' ? 'lido pela câmera' : r.origin === 'import' ? 'importado' : 'manual'].filter(Boolean).join(' · '))),
    r.kind === 'promo' ? badge('Promoção', 'warn') : null,
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': `Excluir registro de ${formatBRL(r.cents)}`, onClick: () => delPrice(r) }, icon('trash', { size: 18 }))))));

  async function delPrice(r) {
    if (!(await confirmDialog({ title: 'Excluir este registro de preço?', message: `${formatBRL(r.cents)} em ${fmtDateTime(r.observedAt)}. O produto continua cadastrado.`, confirmLabel: 'Excluir registro', danger: true }))) return;
    try { await ctx.repo.deletePrice(r.id); toast('Registro excluído.', { tone: 'ok' }); refresh(); } catch (e) { toast(e.message, { tone: 'error' }); }
  }
  async function onDelete() {
    const ok = await confirmDialog({ title: 'Excluir produto e histórico?', message: `"${p.name}" e seus ${prices.length} registro(s) de preço serão apagados deste aparelho. Isso não pode ser desfeito.`, confirmLabel: 'Excluir tudo', danger: true });
    if (!ok) return;
    try { await ctx.repo.deleteProduct(id); toast('Produto excluído.', { tone: 'ok' }); go('produtos'); } catch (e) { toast(e.message, { tone: 'error' }); }
  }
  async function addPriceDialog() {
    const st = await stores(ctx);
    const sid = newId('sub');
    await modal((close) => {
      const form = productForm({
        priceOnly: true, initial: { name: p.name, basis: last?.basis ?? 'package', store: settings?.lastStore ?? '' }, stores: st, submitLabel: 'Salvar preço', onCancel: () => close(false),
        onSubmit: async (v) => {
          try {
            const r = await ctx.repo.addPrice(id, { cents: v.cents, basis: v.basis, kind: v.kind, previousCents: v.previousCents, store: v.store }, { origin: 'manual', submissionId: sid });
            if (v.store) await ctx.repo.setSettings({ lastStore: v.store });
            toast(r.duplicate ? 'Esse preço já estava registrado.' : 'Preço registrado.', { tone: r.duplicate ? 'info' : 'ok' });
            close(true); refresh();
          } catch (e) { toast(e.message, { tone: 'error' }); }
        },
      });
      return h('div', {}, h('h2', {}, 'Registrar novo preço'), form.el);
    }, 'Registrar novo preço');
  }
}
