const PROD_API_BASE = 'https://ksp-datathon-2026-60073723389.development.catalystserverless.in/server/ksp_datathon_2026_function';

export const API_BASE = import.meta.env.DEV ? '' : PROD_API_BASE;

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

// Appends the auth token as a query param instead of a custom header.
// Custom headers force a CORS preflight (OPTIONS) request, which Catalyst's
// gateway answers itself without the function's CORS headers — breaking
// cross-origin calls from the Slate-hosted frontend. Query params and
// text/plain bodies keep requests "simple" and preflight-free.
export function withToken(path, token) {
  const sep = path.includes('?') ? '&' : '?';
  return `${apiUrl(path)}${sep}token=${encodeURIComponent(token)}`;
}
