// Ponto de entrada: abre o banco, monta o menu e roteia as telas.
import { h, icon, clear } from './src__ui__dom.js';
import { banner, button, skeleton, toast } from './src__ui__components.js';
import { ctx, refreshSettings } from './src__ui__ctx.js';
import { Repo } from './src__data__repo.js';
import { OcrEngine } from './src__ocr__ocr.js';

const ROUTES = [
  { key: 'inicio', label: 'Início', icon: 'home', load: () => import('./src__ui__screens__home.js') },
  { key: 'scanner', label: 'Scanner', icon: 'scan', load: () => import('./src__ui__screens__scanner.js') },
  { key: 'produtos', label: 'Produtos', icon: 'box', load: () => import('./src__ui__screens__products.js') },
  { key: 'historico', label: 'Histórico', icon: 'history', load: () => import('./src__ui__screens__history.js') },
  { key: 'comparar', label: 'Comparar', icon: 'compare', load: () => import('./src__ui__screens__compare.js') },
  { key: 'config', label: 'Ajustes', icon: 'gear', load: () => import('./src__ui__screens__settings.js') },
];

const MARK = () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 32 32'); s.setAttribute('class', 'brand-mark'); s.setAttribute('aria-hidden', 'true');
  const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  for (const [k, v] of Object.entries({ x: 1, y: 1, width: 30, height: 30, rx: 8, fill: '#e3a02f' })) r.setAttribute(k, v);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M8 17.5 13.5 23 24 10'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', '#0f4c4a'); p.setAttribute('stroke-width', '3.4'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
  s.append(r, p); return s;
};

let cleanup = null;
let token = 0;
let mainEl; let navEl; let offlineEl;

function parse() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  return { key: parts[0] || 'inicio', params: parts.slice(1) };
}

async function route() {
  const my = ++token;
  const { key, params } = parse();
  const def = ROUTES.find((r) => r.key === key) ?? ROUTES[0];
  if (cleanup) { try { await cleanup(); } catch { /* ignora */ } cleanup = null; }
  for (const a of navEl.querySelectorAll('a')) a.removeAttribute('aria-current');
  for (const a of navEl.querySelectorAll('a')) if (a.dataset.key === def.key) a.setAttribute('aria-current', 'page');
  clear(mainEl).appendChild(skeleton());
  document.title = `${def.label} — PreçoCerto`;
  try {
    const mod = await def.load();
    if (my !== token) return;
    clear(mainEl);
    const out = await mod.render(mainEl, params, ctx);
    if (my !== token) { if (typeof out === 'function') out(); return; }
    cleanup = typeof out === 'function' ? out : null;
    window.scrollTo(0, 0);
    mainEl.focus({ preventScroll: true });
  } catch (e) {
    console.error(e);
    if (my !== token) return;
    clear(mainEl).appendChild(banner({ tone: 'error', title: 'Não foi possível abrir esta tela', text: e?.message ?? 'Erro inesperado.', actions: [button({ label: 'Tentar de novo', onClick: route })] }));
  }
}

function buildShell() {
  const app = document.getElementById('app');
  clear(app);
  navEl = h('nav', { class: 'nav', 'aria-label': 'Principal' },
    h('div', { class: 'nav-brand' }, MARK(), 'PreçoCerto'),
    ROUTES.map((r) => h('a', { href: `#/${r.key}`, 'data-key': r.key, onClick: () => { if (location.hash === `#/${r.key}`) route(); } }, icon(r.icon), h('span', {}, r.label))));
  mainEl = h('main', { id: 'main', tabindex: '-1' });
  offlineEl = h('div', { class: 'offline-banner', hidden: true, role: 'status' }, 'Sem internet — o aplicativo continua funcionando com os arquivos já carregados.');
  const status = h('span', { class: 'status-pill', id: 'status-pill' }, 'Dados só neste aparelho');
  const wrap = h('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column' },
    h('header', { class: 'topbar' }, h('div', { class: 'brand' }, MARK(), h('div', {}, 'PreçoCerto')), status),
    offlineEl, mainEl);
  app.append(wrap, navEl);
  const upd = () => { offlineEl.hidden = navigator.onLine; };
  window.addEventListener('online', upd); window.addEventListener('offline', upd); upd();
}

async function boot() {
  buildShell();
  try {
    ctx.repo = await Repo.open();
    ctx.engine = new OcrEngine();
    await refreshSettings();
  } catch (e) {
    clear(mainEl).appendChild(banner({ tone: 'error', title: 'O armazenamento não está disponível', text: `${e?.message ?? ''} Sem ele não é possível salvar produtos. Se estiver em janela anônima, abra o aplicativo em uma janela normal.` }));
    return;
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('pagehide', () => ctx.engine?.terminate());
  window.__precocerto = ctx; // usado nos testes automatizados
  registerSW();
  await route();
}

function registerSW() {
  if (!('serviceWorker' in navigator) || !(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* funciona sem service worker */ });
}

boot();
