import { collect, normalizeDomain } from './collect.js';

const CACHE_SECONDS = 6 * 3600;

function cors(env, request) {
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim());
  const origin = request.headers.get('Origin') || '';
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0];
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' };
}

const reply = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const h = cors(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (request.method !== 'GET') return reply({ error: '只支持 GET' }, 405, h);
    if (url.pathname === '/' || url.pathname === '/health') return reply({ ok: true, service: 'storesignal', usage: '/api/analyze?domain=example.com' }, 200, h);
    if (url.pathname !== '/api/analyze') return reply({ error: '路径不存在' }, 404, h);

    const domain = normalizeDomain(url.searchParams.get('domain'));
    if (!domain) return reply({ error: '域名格式不对，请输入类似 example.com 的域名' }, 400, h);

    const fresh = url.searchParams.get('fresh') === '1';
    const cacheKey = new Request(`https://storesignal.cache/analyze/${domain}`);
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    if (cache && !fresh) {
      const hit = await cache.match(cacheKey);
      if (hit) { const body = await hit.json(); return reply({ ...body, cached: true }, 200, h); }
    }

    const data = await collect(domain, { fetchFn: (u, init) => fetch(u, init) });
    if (cache && data.tranco) ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_SECONDS}` } })));
    return reply({ ...data, cached: false }, 200, h);
  },
};
