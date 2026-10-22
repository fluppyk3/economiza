import { h, icon, fmtDateTime, debounce } from './src__ui__dom.js';
import { button, badge, emptyState, selectInput, textInput, confirmDialog, toast } from './src__ui__components.js';
import { formatBRL } from './src__core__money.js';
import { foldText } from './src__core__text.js';
import { describeRecord } from './src__ui__screens__products.js';
import { go, refresh } from './src__ui__ctx.js';

export async function render(root, _p, ctx) {
  const [products, prices] = await Promise.all([ctx.repo.listProducts({ includeDemo: true }), ctx.repo.allPrices({ includeDemo: true })]);
  const byId = new Map(products.map((p) => [p.id, p]));
  root.append(h('div', { class: 'page-title' }, h('h1', {}, 'Histórico de preços'), h('p', {}, 'Todos os preços registrados, do mais recente ao mais antigo. Nada é sobrescrito.')));
  if (!prices.length) { root.append(emptyState({ title: 'Nenhum preço registrado', text: 'Quando você salvar preços, eles aparecerão aqui.', iconName: 'history', actions: [button({ label: 'Ler etiqueta', icon: 'camera', variant: 'primary', onClick: () => go('scanner') })] })); return; }
  const state = { q: '', period: '0', origin: '' };
  const out = h('div', { 'aria-live': 'polite' });
  const draw = () => {
    const terms = foldText(state.q).split(' ').filter(Boolean);
    const since = state.period === '0' ? 0 : Date.now() - Number(state.period) * 86_400_000;
    const list = prices.filter((r) => {
      const p = byId.get(r.productId);
      const hay = foldText(`${p?.name ?? ''} ${p?.brand ?? ''} ${r.store ?? ''}`);
      return terms.every((t) => hay.includes(t)) && Date.parse(r.observedAt) >= since && (!state.origin || r.origin === state.origin);
    });
    out.replaceChildren(h('p', { class: 'muted small' }, `${list.length} registro(s)`),
      list.length ? h('ul', { class: 'list' }, list.slice(0, 300).map((r) => {
        const p = byId.get(r.productId);
        return h('li', { class: 'row' }, h('span', { class: `dot${r.kind === 'promo' ? ' promo' : ''}`, 'aria-hidden': 'true' }),
          h('div', { class: 'grow' }, h('a', { class: 'title', href: `#/produtos/${r.productId}` }, p?.name ?? 'Produto removido'),
            h('div', { class: 'meta' }, [fmtDateTime(r.observedAt), p ? describeRecord(r, p) : '', r.store, r.origin === 'scanner' ? 'câmera' : r.origin === 'import' ? 'importado' : 'manual', r.isDemo ? 'demonstração' : ''].filter(Boolean).join(' · '))),
          h('span', { class: 'price' }, formatBRL(r.cents)),
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': `Excluir registro de ${formatBRL(r.cents)}`, onClick: async () => {
            if (!(await confirmDialog({ title: 'Excluir este registro?', message: `${p?.name ?? ''} — ${formatBRL(r.cents)} em ${fmtDateTime(r.observedAt)}.`, confirmLabel: 'Excluir', danger: true }))) return;
            try { await ctx.repo.deletePrice(r.id); toast('Registro excluído.', { tone: 'ok' }); refresh(); } catch (e) { toast(e.message, { tone: 'error' }); }
          } }, icon('trash', { size: 18 })));
      })) : emptyState({ title: 'Nada encontrado', iconName: 'search' }),
      list.length > 300 ? h('p', { class: 'muted small' }, 'Mostrando os 300 mais recentes. Use a busca para refinar.') : null);
  };
  const q = textInput({ id: 'hq', type: 'search', placeholder: 'Buscar produto ou loja', onInput: debounce(() => { state.q = q.value; draw(); }, 150) });
  q.setAttribute('aria-label', 'Buscar no histórico');
  const per = selectInput({ id: 'hp', value: '0', options: [{ value: '0', label: 'Todo o período' }, { value: '7', label: 'Últimos 7 dias' }, { value: '30', label: 'Últimos 30 dias' }, { value: '90', label: 'Últimos 90 dias' }], onChange: () => { state.period = per.value; draw(); } });
  per.setAttribute('aria-label', 'Período');
  const org = selectInput({ id: 'ho', value: '', options: [{ value: '', label: 'Toda origem' }, { value: 'scanner', label: 'Lidos pela câmera' }, { value: 'manual', label: 'Manuais' }, { value: 'import', label: 'Importados' }], onChange: () => { state.origin = org.value; draw(); } });
  org.setAttribute('aria-label', 'Origem');
  root.append(h('div', { class: 'toolbar' }, q, per, org), out);
  draw();
}
