// Formulário de produto + preço (usado no cadastro manual, na revisão do scanner e na edição).
import { h } from './src__ui__dom.js';
import { field, textInput, selectInput, levelBadge, button } from './src__ui__components.js';
import { CATEGORIES, BASES, PACK_UNITS, validateProductInput } from './src__core__validation.js';
import { centsToInputString } from './src__core__money.js';
import { qtyToForm } from './src__core__units.js';

/**
 * opts: { initial, hints: {name:{decision,reasons,alternatives}, price, quantity}, withPrice, submitLabel, onSubmit(value), onCancel,
 *         stores:[...], priceOnly }
 * initial: { name, brand, category, packQty, packUnit, barcode, price(text), basis, kind, previousPrice(text), store, notes }
 */
export function productForm(opts) {
  const { initial = {}, hints = {}, withPrice = true, submitLabel = 'Salvar', onSubmit, onCancel, stores = [], priceOnly = false } = opts;
  const q = initial.packQty ? qtyToForm(initial.packQty, initial.packUnit) : { amount: initial.packAmount ?? '', unit: initial.packUnit ?? 'g' };
  const ids = {}; const errs = {};
  const els = {};
  const mk = (k) => { ids[k] = `f-${k}`; return ids[k]; };

  const hintBlock = (key, setter) => {
    const hnt = hints[key];
    if (!hnt) return null;
    const alts = (hnt.alternatives ?? []).filter((a) => a.label);
    return h('div', {},
      hnt.reasons?.length ? h('ul', { class: 'reasons' }, hnt.reasons.slice(0, 4).map((r) => h('li', {}, r))) : null,
      alts.length ? h('div', { class: 'chips', role: 'group', 'aria-label': 'Outras leituras possíveis' }, alts.map((a) => h('button', { type: 'button', class: 'chip', onClick: () => setter(a) }, a.label))) : null);
  };
  const labelRow = (key, text, required) => h('div', { class: 'field-head' }, h('label', { for: ids[key] }, text, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null), hints[key] ? levelBadge(hints[key].decision) : null);

  els.name = textInput({ id: mk('name'), value: initial.name ?? '', maxlength: 120, required: true, autocomplete: 'off' });
  els.brand = textInput({ id: mk('brand'), value: initial.brand ?? '', maxlength: 60 });
  els.category = selectInput({ id: mk('category'), value: CATEGORIES.includes(initial.category) ? initial.category : 'Outros', options: CATEGORIES.map((c) => ({ value: c, label: c })) });
  els.packAmount = textInput({ id: mk('packAmount'), value: q.amount, inputmode: 'decimal', placeholder: 'ex.: 500' });
  els.packUnit = selectInput({ id: mk('packUnit'), value: q.unit, options: PACK_UNITS }); els.packUnit.setAttribute('aria-label', 'Unidade da medida');
  els.barcode = textInput({ id: mk('barcode'), value: initial.barcode ?? '', inputmode: 'numeric', maxlength: 20 });
  els.price = textInput({ id: mk('price'), value: initial.price ?? '', inputmode: 'decimal', placeholder: 'ex.: 12,99' });
  els.basis = selectInput({ id: mk('basis'), value: initial.basis ?? 'package', options: BASES.map((b) => ({ value: b.value, label: b.label })) });
  els.kind = selectInput({ id: mk('kind'), value: initial.kind ?? 'regular', options: [{ value: 'regular', label: 'Preço normal' }, { value: 'promo', label: 'Promoção' }] });
  els.previousPrice = textInput({ id: mk('previousPrice'), value: initial.previousPrice ?? '', inputmode: 'decimal', placeholder: 'opcional' });
  els.store = textInput({ id: mk('store'), value: initial.store ?? '', maxlength: 60, placeholder: 'ex.: Mercado Central' });
  if (stores.length) els.store.setAttribute('list', 'stores-list');
  els.notes = h('textarea', { id: mk('notes'), class: 'input', maxlength: 500 }); els.notes.value = initial.notes ?? '';

  const errorSlots = {};
  const wrap = (key, label, input, { hint, required, head } = {}) => {
    const slot = h('div', { id: `${key}-slot` });
    errorSlots[key] = slot;
    return h('div', { class: 'field', id: `fld-${key}` },
      head ?? h('label', { for: ids[key] }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
      input, hint ? h('div', { class: 'hint' }, hint) : null, slot);
  };

  const nameHint = hintBlock('name', (a) => { els.name.value = a.value; els.name.focus(); });
  const priceHint = hintBlock('price', (a) => { els.price.value = a.value; if (a.basis) els.basis.value = a.basis; els.price.focus(); });
  const qtyHint = hintBlock('quantity', (a) => { const f = qtyToForm(a.baseQty, a.baseUnit); els.packAmount.value = f.amount; els.packUnit.value = f.unit; });

  const root = h('form', { class: 'form', novalidate: true, autocomplete: 'off' });
  const fields = [];
  if (!priceOnly) {
    fields.push(wrap('name', 'Nome do produto', els.name, { required: true, head: labelRow('name', 'Nome do produto', true) }));
    if (nameHint) fields.push(nameHint);
    fields.push(h('div', { class: 'two-col' },
      wrap('brand', 'Marca', els.brand),
      wrap('category', 'Categoria', els.category)));
    fields.push(wrap('packAmount', 'Quantidade da embalagem', h('div', { class: 'inline' }, els.packAmount, els.packUnit),
      { head: labelRow('packAmount', 'Quantidade da embalagem', false), hint: 'Peso, volume ou unidades. Necessário para comparar preço por kg/L.' }));
    if (qtyHint) fields.push(qtyHint);
    fields.push(wrap('barcode', 'Código de barras', els.barcode, { hint: 'Opcional. 8 a 14 números.' }));
  }
  if (withPrice) {
    fields.push(wrap('price', 'Preço (R$)', els.price, { head: labelRow('price', 'Preço (R$)', false), hint: 'Deixe em branco se não souber — nenhum preço será registrado.' }));
    if (priceHint) fields.push(priceHint);
    fields.push(h('div', { class: 'two-col' }, wrap('basis', 'Tipo de preço', els.basis), wrap('kind', 'Situação', els.kind)));
    fields.push(wrap('previousPrice', 'Preço anterior (R$)', els.previousPrice, { hint: 'Opcional: o preço "de" quando houver promoção.' }));
    fields.push(wrap('store', 'Loja / mercado', els.store));
  }
  if (!priceOnly) fields.push(wrap('notes', 'Observações', els.notes));
  if (stores.length) fields.push(h('datalist', { id: 'stores-list' }, stores.map((s) => h('option', { value: s }))));

  const submit = button({ label: submitLabel, variant: 'primary', type: 'submit', icon: 'check' });
  const actions = h('div', { class: 'btn-row' }, submit, onCancel ? button({ label: 'Cancelar', variant: 'secondary', onClick: onCancel }) : null);
  root.append(...fields, actions);

  function showErrors(errors) {
    for (const [k, slot] of Object.entries(errorSlots)) {
      while (slot.firstChild) slot.removeChild(slot.firstChild);
      const input = els[k];
      if (input) input.removeAttribute('aria-invalid');
      if (errors[k]) {
        slot.appendChild(h('div', { class: 'error-text', role: 'alert' }, errors[k]));
        if (input) input.setAttribute('aria-invalid', 'true');
      }
    }
    const first = Object.keys(errors)[0];
    if (first && els[first]) els[first].focus();
  }

  function read() {
    return {
      name: els.name.value, brand: els.brand.value, category: els.category.value,
      packAmount: els.packAmount.value, packUnit: els.packUnit.value, barcode: els.barcode.value,
      price: els.price.value, basis: els.basis.value, kind: els.kind.value,
      previousPrice: els.previousPrice.value, store: els.store.value, notes: els.notes.value,
    };
  }

  let busy = false;
  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const raw = read();
    if (priceOnly) { raw.name = initial.name || 'Produto'; }
    const v = validateProductInput(raw, { requirePrice: priceOnly });
    if (!v.ok) { showErrors(v.errors); return; }
    showErrors({});
    busy = true; submit.disabled = true;
    try { await onSubmit(v.value, raw); } finally { busy = false; submit.disabled = false; }
  });

  return { el: root, els, read, showErrors };
}
