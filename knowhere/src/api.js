const PROD_API_BASE = 'https://ksp-datathon-2026-60073723389.development.catalystserverless.in/server/ksp_datathon_2026_function';

export const API_BASE = import.meta.env.DEV ? '' : PROD_API_BASE;

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}
