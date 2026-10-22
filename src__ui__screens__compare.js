import { h, fmtDate } from './src__ui__dom.js';
import { button, banner, emptyState, selectInput, textInput } from './src__ui__components.js';
import { formatBRL, formatPercent } from './src__core__money.js';
import { compareRecords, compareProducts } from './src__core__compare.js';
import { formatQuantity, PRICE_BASIS_LABEL } from './src__core__units.js';
import { describeRecord } from './src__ui__screens__products.js';
import { go } from './src__ui__ctx.js';
import { foldText } from './src__core__text.js';

const PER = { kg: 'por kg', l: 'por litro', un: 'por unidade' };

export async function render(root, _p, ctx) {
  const [products, prices] = await Promise.all([ctx.repo.listProducts({ includeDemo: true }), ctx.repo.allPrices({ includeDemo: true })]);
  const settings = ctx.settings;
  root.append(h('div', { class: 'page-title' }, h('h1', {}, 'Comparar preços'), h('p', {}, 'Só comparamos valores equivalentes. Quando as embalagens diferem, convertemos para preço por kg, litro ou unidade — se houver a medida.')));
  if (!prices.length) { root.append(emptyState({ title: 'Sem preços para comparar', text: 'Registre pelo menos dois preços.', iconName: 'compare', actions: [button({ label: 'Ler etiqueta', icon: 'camera', variant: 'primary', onClick: () => go('scanner') })] })); return; }
  const byProduct = new Map();
  for (const r of prices) { if (!byProduct.has(r.productId)) byProduct.set(r.productId, []); byProduct.get(r.productId).push(r); }

  const body = h('div', { 'aria-live': 'polite' });
  let mode = 'produto';
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const mkTab = (key, label) => { const b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(mode === key), onClick: () => { mode = key; drawTabs(); drawBody(); } }, label); return b; };
  const drawTabs = () => tabs.replaceChildren(mkTab('produto', 'Um produto'), mkTab('entre', 'Entre produtos'));

  const withHistory = products.filter((p) => (byProduct.get(p.id)?.length ?? 0) >= 1).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const sel = selectInput({ id: 'cmp-prod', value: withHistory.find((p) => (byProduct.get(p.id)?.length ?? 0) >= 2)?.id ?? withHistory[0]?.id ?? '', options: withHistory.map((p) => ({ value: p.id, label: `${p.name} (${byProduct.get(p.id).length})` })), onChange: () => drawBody() });
  sel.setAttribute('aria-label', 'Produto');
  const search = textInput({ id: 'cmp-q', type: 'search', placeholder: 'Filtrar produtos (ex.: arroz)', onInput: () => drawBody() });
  search.setAttribute('aria-label', 'Filtrar produtos');

  const recordRow = (r, p, extra) => h('li', { class: `row${extra?.best ? ' cmp-best' : ''}` },
    h('div', { class: 'grow' }, h('div', { class: 'title' }, extra?.title ?? formatBRL(r.cents)),
      h('div', { class: 'meta' }, [fmtDate(r.observedAt), describeRecord(r, p), r.store, r.stale ? 'desatualizado' : ''].filter(Boolean).join(' · '))),
    extra?.right ?? null);

  function drawOne() {
    const p = products.find((x) => x.id === sel.value);
    const recs = p ? byProduct.get(p.id) ?? [] : [];
    const cmp = compareRecords(recs, p, { staleDays: settings?.staleDays });
    const out = [h('div', { class: 'field' }, h('label', { for: 'cmp-prod' }, 'Produto'), sel)];
    if (!cmp.comparable) out.push(banner({ tone: 'warn', text: cmp.reason }));
    else {
      out.push(h('div', { class: 'card' }, h('p', {}, `Base: ${cmp.label}`),
        h('p', {}, h('strong', {}, 'Mais barato: '), `${formatBRL(cmp.min.cents)}${cmp.min.store ? ` — ${cmp.min.store}` : ''} (${fmtDate(cmp.min.observedAt)})`),
        h('p', {}, h('strong', {}, 'Mais caro: '), `${formatBRL(cmp.max.cents)}${cmp.max.store ? ` — ${cmp.max.store}` : ''} (${fmtDate(cmp.max.observedAt)})`),
        h('p', {}, cmp.sameValue ? 'Os valores são iguais.' : `Diferença: ${formatBRL(cmp.diffAbs)} (${formatPercent(cmp.diffPct)} a mais no mais caro).`),
        cmp.staleCount ? h('p', { class: 'small muted' }, `Atenção: ${cmp.staleCount} registro(s) com mais de ${settings?.staleDays ?? 30} dias.`) : null));
    }
    out.push(h('ul', { class: 'list' }, cmp.items.map((r) => recordRow(r, p, {
      best: cmp.comparable && cmp.min.id === r.id && !cmp.sameValue,
      title: cmp.per && r.normalized ? `${formatBRL(r.normalized.cents)} ${PER[r.normalized.per]}  (pago ${formatBRL(r.cents)})` : formatBRL(r.cents),
    }))));
    return out;
  }

  function drawBetween() {
    const terms = foldText(search.value).split(' ').filter(Boolean);
    const entries = products.filter((p) => terms.every((t) => (p.searchKey ?? '').includes(t))).map((p) => ({ product: p, price: (byProduct.get(p.id) ?? [])[0] ?? null }));
    const res = compareProducts(entries, { staleDays: settings?.staleDays });
    const out = [h('div', { class: 'field' }, h('label', { for: 'cmp-q' }, 'Filtrar produtos'), search, h('div', { class: 'hint' }, 'Compara o preço mais recente de cada produto, convertido para kg, litro ou unidade.'))];
    if (res.mixed) out.push(banner({ tone: 'info', text: 'Há produtos medidos em bases diferentes (kg, litro, unidade). Cada grupo é comparado separadamente.' }));
    for (const g of res.groups) {
      out.push(h('h2', {}, `Preço ${PER[g.per]}`));
      if (!g.comparable) out.push(h('p', { class: 'muted small' }, 'Apenas um produto nesta base — nada a comparar ainda.'));
      out.push(h('ul', { class: 'list' }, g.rows.map((r, i) => h('li', { class: `row${i === 0 && g.comparable ? ' cmp-best' : ''}` },
        h('div', { class: 'grow' }, h('a', { class: 'title', href: `#/produtos/${r.product.id}` }, r.product.name),
          h('div', { class: 'meta' }, [`pago ${formatBRL(r.price.cents)}`, r.product.packQty ? formatQuantity(r.product.packQty, r.product.packUnit) : '', r.price.store, fmtDate(r.price.observedAt), r.stale ? 'desatualizado' : ''].filter(Boolean).join(' · '))),
        h('div', { style: 'text-align:right' }, h('div', { class: 'price' }, `${formatBRL(r.value)}`), i === 0 ? h('span', { class: 'badge badge-ok' }, 'mais barato') : h('span', { class: 'delta-up small' }, `+${formatPercent(r.diffPct)}`))))));
    }
    if (res.excluded.length) {
      out.push(h('details', { class: 'raw' }, h('summary', {}, `${res.excluded.length} produto(s) fora da comparação`),
        h('ul', { class: 'tips' }, res.excluded.map((x) => h('li', {}, `${x.product.name}: ${x.reason}`)))));
    }
    if (!res.groups.length && !res.excluded.length) out.push(h('p', { class: 'muted' }, 'Nenhum produto corresponde ao filtro.'));
    return out;
  }
  const drawBody = () => { const keep = document.activeElement?.id; body.replaceChildren(...(mode === 'produto' ? drawOne() : drawBetween())); if (keep) document.getElementById(keep)?.focus(); };
  drawTabs(); drawBody();
  root.append(tabs, body);
}
