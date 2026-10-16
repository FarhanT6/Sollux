/**
 * Sample API answers for scripts/screens.mjs. Shapes follow the backend
 * routes; amounts and names are made up. Anything not listed answers an
 * empty list (or object for a path ending in an id).
 */
export function handle(method, path, query, body) {
  if (method !== 'GET') return { body: { ok: true } };
  const hit = Object.entries(GET).find(([p]) => new RegExp(`^${p}$`).test(path));
  if (hit) return { body: typeof hit[1] === 'function' ? hit[1](path, query) : hit[1] };
  return { body: /\/[a-z0-9]{20,}$/i.test(path) ? {} : [] };
}

const GET = {};
