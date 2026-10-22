// Estado compartilhado do aplicativo (repositório, motor de OCR, navegação).
export const ctx = { repo: null, engine: null, settings: null };

export function go(path) { location.hash = `#/${path}`; }
export function hashFor(path) { return `#/${path}`; }

export async function refreshSettings() { ctx.settings = await ctx.repo.getSettings(); return ctx.settings; }

/** Redesenha a tela atual (sem recarregar a página). */
export function refresh() { window.dispatchEvent(new Event('hashchange')); }
