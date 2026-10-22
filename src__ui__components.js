// Componentes reutilizáveis: botões, campos, selos de confiança, diálogos e avisos.
import { h, icon, clear } from './src__ui__dom.js';

export function button({ label, icon: ic, variant = 'secondary', onClick, type = 'button', disabled = false, ariaLabel, block = false, id } = {}) {
  const b = h('button', { type, id, class: `btn btn-${variant}${block ? ' btn-block' : ''}`, 'aria-label': ariaLabel, onClick }, ic ? icon(ic, { size: 20 }) : null, label ? h('span', {}, label) : null);
  if (disabled) b.disabled = true;
  return b;
}

export function badge(text, tone = 'neutral') {
  return h('span', { class: `badge badge-${tone}` }, text);
}

/** Selo de confiança por campo: confiável / confirmar / sem preenchimento. */
export function levelBadge(decision) {
  if (decision === 'preencher') return h('span', { class: 'badge badge-ok' }, icon('check', { size: 14 }), 'Leitura confiável — confira');
  if (decision === 'confirmar') return h('span', { class: 'badge badge-warn' }, icon('alert', { size: 14 }), 'Confirme este valor');
  return h('span', { class: 'badge badge-muted' }, 'Não preenchido — digite');
}

export function field({ id, label, hint, error, children, required = false, className = '' }) {
  return h('div', { class: `field${error ? ' has-error' : ''} ${className}`.trim() },
    h('label', { for: id }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
    children,
    hint ? h('div', { class: 'hint', id: `${id}-hint` }, hint) : null,
    error ? h('div', { class: 'error-text', id: `${id}-err`, role: 'alert' }, error) : null);
}

export function textInput({ id, value = '', type = 'text', placeholder, inputmode, maxlength, autocomplete = 'off', onInput, required = false, name }) {
  return h('input', {
    id, name: name ?? id, type, value, placeholder, inputmode, maxlength, autocomplete, required: required || null,
    class: 'input', onInput, autocapitalize: type === 'text' ? 'sentences' : 'off', spellcheck: 'false',
  });
}

export function selectInput({ id, value = '', options, onChange }) {
  const s = h('select', { id, class: 'input', onChange }, options.map((o) => h('option', { value: o.value }, o.label)));
  s.value = value;
  return s;
}

export function emptyState({ title, text, actions = [], iconName = 'tag' }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-art', 'aria-hidden': 'true' }, icon(iconName, { size: 44 })),
    h('h2', {}, title), text ? h('p', {}, text) : null,
    actions.length ? h('div', { class: 'empty-actions' }, actions) : null);
}

export function sectionHeader(title, action) {
  return h('div', { class: 'section-head' }, h('h2', {}, title), action ?? null);
}

/* ------------------------------ avisos ------------------------------ */

let toastRegion;
function region() {
  if (!toastRegion) {
    toastRegion = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastRegion);
  }
  return toastRegion;
}

export function toast(message, { tone = 'info', ms = 4200, action } = {}) {
  const el = h('div', { class: `toast toast-${tone}` },
    h('span', {}, message),
    action ? h('button', { type: 'button', class: 'toast-action', onClick: () => { action.onClick(); el.remove(); } }, action.label) : null,
    h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Fechar aviso', onClick: () => el.remove() }, icon('x', { size: 16 })));
  region().appendChild(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

export function banner({ tone = 'info', title, text, actions = [] }) {
  const ic = tone === 'error' || tone === 'warn' ? 'alert' : 'info';
  return h('div', { class: `banner banner-${tone}`, role: tone === 'error' ? 'alert' : null },
    icon(ic, { size: 20 }),
    h('div', { class: 'banner-body' }, title ? h('strong', {}, title) : null, text ? h('div', {}, text) : null,
      actions.length ? h('div', { class: 'banner-actions' }, actions) : null));
}

/* ------------------------------ diálogos ------------------------------ */

function openDialog(build, { label }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    dlg.setAttribute('aria-label', label);
    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(undefined); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(undefined); });
    dlg.appendChild(build(close));
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    const focusable = dlg.querySelector('[data-autofocus]') ?? dlg.querySelector('input,select,textarea,button');
    focusable?.focus();
  });
}

/** Confirmação. Com requireText exige digitar uma palavra (ações irreversíveis). */
export function confirmDialog({ title, message, details, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false, requireText = null }) {
  return openDialog((close) => {
    const confirmBtn = button({ label: confirmLabel, variant: danger ? 'danger' : 'primary', onClick: () => close(true) });
    let input = null;
    if (requireText) {
      confirmBtn.disabled = true;
      input = h('input', { class: 'input', type: 'text', autocomplete: 'off', 'aria-label': `Digite ${requireText} para confirmar`, 'data-autofocus': '', onInput: () => { confirmBtn.disabled = input.value.trim().toUpperCase() !== requireText.toUpperCase(); } });
    }
    return h('div', { class: 'dialog-body' },
      h('h2', {}, title),
      message ? h('p', {}, message) : null,
      details ? h('div', { class: 'dialog-details' }, details) : null,
      requireText ? h('div', { class: 'field' }, h('label', {}, `Digite ${requireText} para confirmar`), input) : null,
      h('div', { class: 'dialog-actions' }, button({ label: cancelLabel, variant: 'ghost', onClick: () => close(false) }), confirmBtn));
  }, { label: title }).then((v) => v === true);
}

/** Diálogo genérico: build(close) deve devolver um elemento. */
export function modal(build, label) {
  return openDialog((close) => h('div', { class: 'dialog-body' }, build(close)), { label });
}

export function skeleton() {
  return h('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Carregando' }, h('div', { class: 'sk-line' }), h('div', { class: 'sk-line short' }), h('div', { class: 'sk-card' }));
}

export function setChildren(el, ...children) {
  clear(el);
  for (const c of children.flat()) if (c) el.appendChild(c);
}
