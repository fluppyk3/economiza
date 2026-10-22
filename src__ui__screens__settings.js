import { h, icon, fmtDateTime, downloadFile } from './src__ui__dom.js';
import { button, banner, confirmDialog, modal, toast, field, selectInput } from './src__ui__components.js';
import { refresh, refreshSettings } from './src__ui__ctx.js';
import { AppError } from './src__core__errors.js';

const MAX_IMPORT_BYTES = 30 * 1024 * 1024;
const stamp = () => new Date().toISOString().slice(0, 10);

export async function render(root, _p, ctx) {
  const repo = ctx.repo;
  const settings = await repo.getSettings();
  const snap = await repo.hasImportSnapshot();
  const demo = (await repo.listProducts({ includeDemo: true })).some((p) => p.isDemo);
  const counts = { p: (await repo.listProducts()).length, r: (await repo.allPrices()).length };

  root.append(h('div', { class: 'page-title' }, h('h1', {}, 'Ajustes e dados')));

  /* ---- privacidade ---- */
  root.append(h('section', { class: 'card', 'aria-labelledby': 'priv-h' },
    h('h2', { id: 'priv-h' }, h('span', {}, icon('shield', { size: 20 }), ' Privacidade')),
    h('ul', { class: 'priv' },
      h('li', {}, 'Seus produtos, preços e configurações ficam somente neste aparelho, no armazenamento do navegador.'),
      h('li', {}, 'Não existe conta, login, nem envio de dados para servidores.'),
      h('li', {}, 'A leitura das fotos (OCR) acontece dentro do seu navegador. As fotos não são enviadas nem guardadas — só o texto que você confirma.'),
      h('li', {}, 'Limpar os dados do navegador ou desinstalar o app apaga tudo. Faça backups com frequência.'))));

  /* ---- backup ---- */
  const lastBackup = settings.lastBackupAt ? fmtDateTime(settings.lastBackupAt) : 'nunca';
  root.append(h('section', { class: 'card', 'aria-labelledby': 'bk-h' },
    h('h2', { id: 'bk-h' }, 'Backup e exportação'),
    h('p', { class: 'muted' }, `${counts.p} produto(s) e ${counts.r} preço(s) reais. Último backup: ${lastBackup}.`),
    h('div', { class: 'btn-row' },
      button({ label: 'Baixar backup (JSON)', icon: 'download', variant: 'primary', onClick: async () => {
        try { const b = await repo.exportBackup(); downloadFile(`precocerto-backup-${stamp()}.json`, JSON.stringify(b, null, 2), 'application/json'); await repo.setSettings({ lastBackupAt: new Date().toISOString() }); toast(`Backup gerado: ${b.counts.products} produto(s), ${b.counts.prices} preço(s).`, { tone: 'ok' }); } catch (e) { toast(e.message, { tone: 'error' }); } } }),
      button({ label: 'Exportar planilha (CSV)', icon: 'download', onClick: async () => {
        try { downloadFile(`precocerto-precos-${stamp()}.csv`, await repo.exportCsv(), 'text/csv;charset=utf-8'); toast('Planilha CSV gerada.', { tone: 'ok' }); } catch (e) { toast(e.message, { tone: 'error' }); } } })),
    h('hr', { style: 'border:0;border-top:1px solid var(--line);margin:1rem 0' }),
    h('h3', {}, 'Restaurar de um backup'),
    h('p', { class: 'muted small' }, 'Você verá um resumo antes de qualquer alteração. "Mesclar" só adiciona o que não existe; "Substituir" troca os dados atuais (e pode ser desfeito).'),
    importControls(ctx),
    snap ? banner({ tone: 'info', title: 'Importação por substituição recente', text: `Feita em ${fmtDateTime(snap.at)}. Você pode voltar ao estado anterior.`, actions: [button({ label: 'Desfazer importação', variant: 'secondary', onClick: async () => {
      if (!(await confirmDialog({ title: 'Desfazer a última importação?', message: 'Os dados voltam ao estado anterior à importação.', confirmLabel: 'Desfazer' }))) return;
      try { await repo.undoLastImport(); toast('Importação desfeita.', { tone: 'ok' }); refresh(); } catch (e) { toast(e.message, { tone: 'error' }); } } })] }) : null));

  /* ---- preferências ---- */
  const stale = selectInput({ id: 'stale', value: String(settings.staleDays), options: [7, 15, 30, 60, 90].map((d) => ({ value: String(d), label: `${d} dias` })), onChange: async () => { await repo.setSettings({ staleDays: Number(stale.value) }); await refreshSettings(); toast('Preferência salva.', { tone: 'ok' }); } });
  root.append(h('section', { class: 'card' }, h('h2', {}, 'Preferências'),
    field({ id: 'stale', label: 'Considerar um preço desatualizado depois de', hint: 'Usado nos avisos de comparação.', children: stale })));

  /* ---- demonstração e manutenção ---- */
  root.append(h('section', { class: 'card' }, h('h2', {}, 'Dados de exemplo e manutenção'),
    h('div', { class: 'btn-row' },
      demo ? button({ label: 'Remover exemplos', variant: 'secondary', onClick: async () => { await repo.removeDemo(); toast('Exemplos removidos.', { tone: 'ok' }); refresh(); } })
        : button({ label: 'Carregar exemplos', variant: 'secondary', onClick: async () => { await repo.loadDemo(); toast('Exemplos (demonstração) carregados.', { tone: 'ok' }); refresh(); } }),
      button({ label: 'Verificar integridade', variant: 'secondary', onClick: async () => {
        const r = await repo.verifyIntegrity();
        if (r.ok) { toast(`Tudo certo: ${r.products} produto(s), ${r.prices} preço(s).`, { tone: 'ok' }); return; }
        if (await confirmDialog({ title: 'Inconsistências encontradas', message: `${r.orphanPrices.length} preço(s) sem produto e ${r.mismatched.length} produto(s) com resumo desatualizado. Corrigir agora?`, confirmLabel: 'Corrigir' })) {
          await repo.verifyIntegrity({ repair: true }); toast('Dados corrigidos.', { tone: 'ok' }); refresh(); } } }),
      button({ label: 'Apagar todos os dados', icon: 'trash', variant: 'danger', onClick: async () => {
        const ok = await confirmDialog({ title: 'Apagar TODOS os dados?', message: 'Todos os produtos, preços e leituras serão apagados deste aparelho. Baixe um backup antes se quiser guardar.', confirmLabel: 'Apagar tudo', danger: true, requireText: 'APAGAR' });
        if (!ok) return;
        await repo.clearAll(); await repo.setSettings({ lastStore: '' }); toast('Todos os dados foram apagados.', { tone: 'ok' }); refresh(); } }))));

  /* ---- sobre / offline ---- */
  const sw = 'serviceWorker' in navigator;
  root.append(h('section', { class: 'card flat' }, h('h2', {}, 'Sobre o uso sem internet'),
    h('p', {}, 'Depois do primeiro acesso, o aplicativo e o motor de leitura ficam guardados no navegador e funcionam sem internet. Isso exige abrir por endereço https:// ou localhost.'),
    h('p', { class: 'muted small', id: 'sw-state' }, sw ? 'Verificando…' : 'Este navegador não oferece modo offline instalável.'),
    h('p', { class: 'muted small' }, 'PreçoCerto 1.0.0 · leitura por Tesseract.js (Apache-2.0) · dados em IndexedDB.')));
  if (sw) navigator.serviceWorker.getRegistration().then((r) => { const el = document.getElementById('sw-state'); if (el) el.textContent = r?.active ? 'Modo offline pronto: arquivos guardados neste aparelho.' : 'Modo offline ainda não está ativo (abra por https:// ou localhost e recarregue).'; });
  if (navigator.storage?.persist) navigator.storage.persisted?.().then(async (p) => { if (!p) { try { await navigator.storage.persist(); } catch { /* ignora */ } } });
}

function importControls(ctx) {
  const input = h('input', { type: 'file', accept: '.json,application/json', class: 'sr-only', id: 'import-file', 'aria-label': 'Escolher arquivo de backup' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0]; input.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new AppError('TOO_BIG', 'O arquivo é grande demais para ser um backup do PreçoCerto.');
      let obj;
      try { obj = JSON.parse(await file.text()); } catch { throw new AppError('BAD_JSON', 'O arquivo não é um JSON válido.'); }
      const preview = await ctx.repo.previewImport(obj, 'merge');
      if (!preview.ok) { await modal((close) => h('div', {}, h('h2', {}, 'Backup recusado'), h('p', {}, 'Nada foi importado. Motivos:'), h('ul', {}, preview.errors.slice(0, 8).map((e) => h('li', {}, e))), h('div', { class: 'dialog-actions' }, button({ label: 'Fechar', variant: 'primary', onClick: () => close() }))), 'Backup recusado'); return; }
      await importDialog(ctx, obj, preview);
    } catch (e) { toast(e.message || 'Não foi possível ler o arquivo.', { tone: 'error' }); }
  });
  return h('div', { class: 'btn-row' }, h('label', { class: 'btn btn-secondary', for: 'import-file' }, icon('upload', { size: 20 }), h('span', {}, 'Escolher arquivo de backup')), input);
}

async function importDialog(ctx, obj, first) {
  let mode = 'merge'; let preview = first;
  await modal((close) => {
    const summary = h('div', { class: 'dialog-details', 'aria-live': 'polite' });
    const draw = () => {
      const pl = preview.plan;
      summary.replaceChildren(h('div', {}, `No arquivo: ${preview.data.products.length} produto(s), ${preview.data.prices.length} preço(s).`),
        h('div', {}, mode === 'merge' ? `Serão adicionados: ${pl.willAddProducts} produto(s) e ${pl.willAddPrices} preço(s). ${pl.skippedProducts} produto(s) e ${pl.skippedPrices} preço(s) já existem e serão ignorados.`
          : `Os dados reais atuais (${pl.willDeleteProducts} produto(s), ${pl.willDeletePrices} preço(s)) serão substituídos pelos do arquivo.`),
        ...(preview.warnings ?? []).slice(0, 4).map((w) => h('div', { class: 'small muted' }, `Aviso: ${w}`)));
    };
    const sel = selectInput({ id: 'imp-mode', value: 'merge', options: [{ value: 'merge', label: 'Mesclar (adiciona o que falta)' }, { value: 'replace', label: 'Substituir os dados atuais' }], onChange: async () => { mode = sel.value; preview = await ctx.repo.previewImport(obj, mode); draw(); } });
    draw();
    const go = button({ label: 'Importar', variant: 'primary', onClick: async () => {
      go.disabled = true;
      try { const r = await ctx.repo.importBackup(obj, mode); toast(`Importação concluída: ${r.addedProducts} produto(s) e ${r.addedPrices} preço(s) adicionados.`, { tone: 'ok' }); close(true); refresh(); }
      catch (e) { toast(e.message, { tone: 'error' }); go.disabled = false; } } });
    return h('div', {}, h('h2', {}, 'Importar backup'), field({ id: 'imp-mode', label: 'Como importar', children: sel }), summary,
      h('div', { class: 'dialog-actions' }, button({ label: 'Cancelar', variant: 'ghost', onClick: () => close(false) }), go));
  }, 'Importar backup');
}
