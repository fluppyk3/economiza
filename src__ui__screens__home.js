import { h, icon, fmtAgo, fmtDate } from './src__ui__dom.js';
import { button, emptyState, sectionHeader, toast } from './src__ui__components.js';
import { formatBRL, formatPercent } from './src__core__money.js';
import { go, refresh } from './src__ui__ctx.js';

export async function render(root, _p, ctx) {
  const d = await ctx.repo.dashboard();
  const demo = (await ctx.repo.listProducts({ includeDemo: true })).some((p) => p.isDemo);
  const hero = h('section', { class: 'hero' },
    h('h1', {}, 'Preço certo, na hora de comprar'),
    h('p', {}, 'Fotografe a etiqueta, confira o que foi lido e salve. Tudo fica só neste aparelho.'),
    h('div', { class: 'btn-row' },
      button({ label: 'Ler etiqueta', icon: 'camera', variant: 'accent', onClick: () => go('scanner') }),
      button({ label: 'Cadastrar sem foto', icon: 'plus', variant: 'secondary', onClick: () => go('produtos/novo') })));
  root.append(hero);

  if (!d.productCount && demo) {
    root.append(emptyState({
      title: 'Só há exemplos por enquanto', text: 'Os números do início contam apenas os seus dados reais. Os exemplos (marcados como demonstração) estão em Produtos.',
      actions: [button({ label: 'Ver exemplos', variant: 'secondary', onClick: () => go('produtos') }), button({ label: 'Ler etiqueta', icon: 'camera', variant: 'primary', onClick: () => go('scanner') })],
    }));
    return;
  }
  if (!d.productCount) {
    root.append(emptyState({
      title: 'Nenhum produto ainda', text: 'Comece lendo uma etiqueta ou cadastrando um produto. Se quiser só conhecer o app, carregue exemplos (marcados como demonstração).',
      actions: [button({ label: 'Carregar exemplos', variant: 'secondary', onClick: async () => { await ctx.repo.loadDemo(); toast('Exemplos carregados (demonstração).', { tone: 'ok' }); go('produtos'); } })],
    }));
    return;
  }
  root.append(h('div', { class: 'stats' },
    h('div', { class: 'stat' }, h('b', {}, String(d.productCount)), h('span', {}, d.productCount === 1 ? 'produto' : 'produtos')),
    h('div', { class: 'stat' }, h('b', {}, String(d.priceCount)), h('span', {}, d.priceCount === 1 ? 'preço registrado' : 'preços registrados'))));
  if (demo) root.append(h('p', { class: 'muted small' }, 'Há dados de demonstração. Você pode removê-los em Ajustes.'));

  if (d.changes.length) {
    root.append(sectionHeader('Variações recentes'));
    root.append(h('ul', { class: 'list' }, d.changes.map((c) => h('li', {}, h('a', { class: 'row', href: `#/produtos/${c.product.id}` },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, c.product.name),
        h('div', { class: 'meta' }, `${formatBRL(c.from.cents)} → ${formatBRL(c.to.cents)} · ${fmtAgo(c.to.observedAt)}`)),
      h('span', { class: c.direction === 'up' ? 'delta-up' : 'delta-down' }, `${c.direction === 'up' ? '▲' : '▼'} ${formatPercent(Math.abs(c.pct))}`))))));
  }
  root.append(sectionHeader('Adicionados recentemente', button({ label: 'Ver todos', variant: 'ghost', onClick: () => go('produtos') })));
  root.append(productList(d.recentAdded));
  if (d.recentViewed.length) { root.append(sectionHeader('Vistos por último')); root.append(productList(d.recentViewed)); }
  if (d.scans.length) {
    root.append(sectionHeader('Últimas leituras'));
    root.append(h('ul', { class: 'list' }, d.scans.map((s) => h('li', { class: 'row' },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, s.summary || 'Leitura de etiqueta'), h('div', { class: 'meta' }, `${fmtDate(s.at)} · ${s.status === 'saved' ? 'salva' : s.status === 'discarded' ? 'descartada' : 'não salva'}`))))));
  }
}

export function productList(products) {
  return h('ul', { class: 'list' }, products.map((p) => h('li', {}, h('a', { class: 'row', href: `#/produtos/${p.id}` },
    h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name), h('div', { class: 'meta' }, [p.brand, p.category].filter(Boolean).join(' · ') + (p.lastPrice ? ` · ${fmtAgo(p.lastPrice.observedAt)}` : ''))),
    p.lastPrice ? h('span', { class: 'price' }, formatBRL(p.lastPrice.cents)) : h('span', { class: 'badge badge-muted' }, 'sem preço')))));
}
