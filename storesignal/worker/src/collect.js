// StoreSignal collector. Pure module: every number it returns is read from a
// public endpoint. It never estimates, never fills gaps, never randomizes.
// A step that fails is reported in `errors` and its field stays null.

export const UA = 'StoreSignalBot/1.0 (public storefront signals; low volume; cached)';

const NOISE_RE = /gift.?card|store.?credit|\bcredit\b|protection|insurance|personali[sz]ation|shipping|warranty|\bsample\b|add.?on|route.?package|\btip\b|donation/i;

const TECH = [
  ['Shopify', '平台', /cdn\.shopify\.com|Shopify\.theme/i],
  ['WooCommerce', '平台', /woocommerce|wp-content\/plugins\/woocommerce/i],
  ['BigCommerce', '平台', /cdn\d*\.bigcommerce\.com/i],
  ['Magento', '平台', /mage\/cookies|Magento_/i],
  ['Meta Pixel', '广告像素', /connect\.facebook\.net|fbq\(/i],
  ['TikTok Pixel', '广告像素', /analytics\.tiktok\.com/i],
  ['Google Ads / GTM', '广告像素', /googletagmanager\.com|googleadservices\.com/i],
  ['Pinterest Tag', '广告像素', /s\.pinimg\.com\/ct|pintrk\(/i],
  ['Snap Pixel', '广告像素', /sc-static\.net\/scevent/i],
  ['Microsoft Ads', '广告像素', /bat\.bing\.com/i],
  ['Klaviyo', '邮件短信', /klaviyo\.com|klaviyo\.js|_learnq/i],
  ['Attentive', '邮件短信', /attn\.tv|attentivemobile/i],
  ['Postscript', '邮件短信', /postscript\.io/i],
  ['Omnisend', '邮件短信', /omnisend\.com|omnisrc\.com/i],
  ['Okendo', '评价', /okendo\.io|data-oke-/i],
  ['Judge.me', '评价', /cdn\.judge\.me|jdgm-/i],
  ['Loox', '评价', /loox\.io/i],
  ['Yotpo', '评价', /staticw2\.yotpo\.com|yotpo-widget/i],
  ['Stamped', '评价', /stamped\.io/i],
  ['Trustpilot', '评价', /widget\.trustpilot\.com/i],
  ['Shop Pay', '支付分期', /shop_pay|shop-pay|shopify_pay/i],
  ['Afterpay', '支付分期', /afterpay\.com|static\.afterpay/i],
  ['Klarna', '支付分期', /klarna\.com|klarnaservices/i],
  ['Triple Whale', '归因', /triplewhale|config-security\.com/i],
  ['Northbeam', '归因', /northbeam/i],
  ['Elevar', '归因', /getelevar|elevar_/i],
  ['Recharge', '订阅', /rechargeapps|rechargecdn/i],
  ['Rebuy', '加购推荐', /rebuyengine/i],
  ['Gorgias', '客服', /gorgias\.chat|gorgias\.io/i],
  ['Hotjar', '行为分析', /static\.hotjar\.com/i],
  ['Microsoft Clarity', '行为分析', /clarity\.ms/i],
];

export function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').replace(/[\/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
  if (d.length > 253 || !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(d)) return null;
  return d;
}

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return +(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)).toFixed(2);
};

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

export function detectTech(html) {
  return TECH.filter(([, , re]) => re.test(html)).map(([name, category]) => ({ name, category }));
}

export function parseTranco(json) {
  const ranks = (json && Array.isArray(json.ranks) ? json.ranks : []).filter((r) => r && r.rank > 0)
    .map((r) => ({ date: r.date, rank: r.rank })).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!ranks.length) return { ranked: false, series: [] };
  const series = ranks.slice(-30);
  const latest = series[series.length - 1], first = series[0];
  const avg30 = Math.round(series.reduce((s, r) => s + r.rank, 0) / series.length);
  // Positive = rank number got smaller = the site moved up.
  const improvementPct = +(((first.rank - latest.rank) / first.rank) * 100).toFixed(1);
  return { ranked: true, latest, avg30, days: series.length, improvementPct, series };
}

export function summarizeCatalog(products, nowMs) {
  const rows = products.map((p) => {
    const vs = Array.isArray(p.variants) ? p.variants : [];
    const prices = vs.map((v) => parseFloat(v.price)).filter((n) => isFinite(n));
    const price = prices.length ? Math.min(...prices) : null;
    const cmp = vs.filter((v) => parseFloat(v.price) === price).map((v) => parseFloat(v.compare_at_price)).filter((n) => isFinite(n) && n > 0);
    const compareAt = cmp.length ? Math.max(...cmp) : null;
    const noise = price === null || price <= 0 || NOISE_RE.test(`${p.handle} ${p.title} ${p.product_type}`);
    return { handle: p.handle, title: decode(p.title), type: p.product_type || '', price, compareAt, available: vs.some((v) => v.available), publishedAt: p.published_at || p.created_at || null, noise };
  });
  const real = rows.filter((r) => !r.noise);
  const prices = real.map((r) => r.price).sort((a, b) => a - b);
  const onSale = real.filter((r) => r.compareAt && r.compareAt > r.price);
  const discounts = onSale.map((r) => (1 - r.price / r.compareAt) * 100).sort((a, b) => a - b);
  const byMonth = {};
  let newLast90d = 0, oldest = null;
  for (const r of real) {
    if (!r.publishedAt) continue;
    const t = Date.parse(r.publishedAt);
    if (!isFinite(t)) continue;
    const m = new Date(t).toISOString().slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + 1;
    if (nowMs - t <= 90 * 864e5) newLast90d++;
    if (!oldest || t < oldest) oldest = t;
  }
  const months = [];
  const now = new Date(nowMs);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    months.push({ month: key, count: byMonth[key] || 0 });
  }
  // Price histogram on fixed, readable bins.
  const edges = [0, 25, 50, 75, 100, 150, 200, 300, 500, Infinity];
  const histogram = edges.slice(0, -1).map((from, i) => ({ from, to: edges[i + 1] === Infinity ? null : edges[i + 1], count: prices.filter((p) => p >= from && p < edges[i + 1]).length }));
  const types = {};
  for (const r of real) { const t = (r.type || '未分类').split('>')[0].trim() || '未分类'; types[t] = (types[t] || 0) + 1; }
  return {
    rows,
    summary: {
      total: rows.length, priced: real.length, noiseExcluded: rows.length - real.length,
      inStockPct: real.length ? +((real.filter((r) => r.available).length / real.length) * 100).toFixed(1) : null,
      price: prices.length ? { min: prices[0], p25: quantile(prices, 0.25), median: quantile(prices, 0.5), p75: quantile(prices, 0.75), max: prices[prices.length - 1] } : null,
      onSalePct: real.length ? +((onSale.length / real.length) * 100).toFixed(1) : null,
      medianDiscountPct: discounts.length ? +quantile(discounts, 0.5).toFixed(1) : null,
      publishedByMonth: months, newLast90d,
      oldestPublished: oldest ? new Date(oldest).toISOString().slice(0, 10) : null,
      typesTop: Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([type, count]) => ({ type, count })),
      histogram,
    },
  };
}

export function parseBestsellerHandles(html, limit = 12) {
  const start = html.search(/<main[\s>]/i);
  const body = start >= 0 ? html.slice(start) : html;
  const seen = [];
  const re = /href="(?:https?:\/\/[^"\/]+)?\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:collections\/[^"\/]+\/)?products\/([^"\/?#]+)/gi;
  let m;
  while ((m = re.exec(body)) && seen.length < limit) {
    let h; try { h = decodeURIComponent(m[1]); } catch { h = m[1]; }
    if (!seen.includes(h)) seen.push(h);
  }
  return { handles: seen, scopedToMain: start >= 0 };
}

export function parseReviews(html) {
  // 1) Okendo product aggregate with star distribution.
  let m = html.match(/"reviewCount"\s*:\s*(\d+)\s*,\s*"reviewCountByLevel"\s*:\s*\{([^}]*)\}/);
  if (m) {
    const count = +m[1], lv = {};
    for (const x of m[2].matchAll(/"level(\d)Count"\s*:\s*(\d+)/g)) lv[x[1]] = +x[2];
    const n = [1, 2, 3, 4, 5].reduce((s, k) => s + (lv[k] || 0), 0);
    if (count > 0 && n > 0) {
      const rating = [1, 2, 3, 4, 5].reduce((s, k) => s + k * (lv[k] || 0), 0) / n;
      return { count, rating: +rating.toFixed(2), source: 'Okendo 评价挂件', distribution: [1, 2, 3, 4, 5].map((k) => ({ stars: k, count: lv[k] || 0 })) };
    }
  }
  // 2) schema.org aggregateRating in JSON-LD.
  m = html.match(/"aggregateRating"\s*:\s*\{([^}]*)\}/i);
  if (m) {
    const rv = m[1].match(/"ratingValue"\s*:\s*"?([\d.]+)/i), rc = m[1].match(/"(?:reviewCount|ratingCount)"\s*:\s*"?(\d+)/i);
    if (rv && rc && +rc[1] > 0) return { count: +rc[1], rating: +(+rv[1]).toFixed(2), source: '页面结构化数据 aggregateRating' };
  }
  // 3) Judge.me badge attributes.
  const jc = html.match(/data-number-of-reviews=['"](\d+)['"]/i), jr = html.match(/data-average-rating=['"]([\d.]+)['"]/i);
  if (jc && jr && +jc[1] > 0) return { count: +jc[1], rating: +(+jr[1]).toFixed(2), source: 'Judge.me 评价挂件' };
  // 4) Loox.
  m = html.match(/data-rating=['"]([\d.]+)['"][^>]*data-raters=['"](\d+)['"]/i);
  if (m && +m[2] > 0) return { count: +m[2], rating: +(+m[1]).toFixed(2), source: 'Loox 评价挂件' };
  return null;
}

export function classifyPath(url) {
  let p = url; try { p = new URL(url).pathname; } catch { /* keep raw */ }
  if (/\/products?\//i.test(p)) return 'products';
  if (/\/collections?\/|\/category\/|\/product-category\//i.test(p)) return 'collections';
  if (/\/blogs?\/|\/articles?\/|\/news\/|\/journal\//i.test(p)) return 'blogs';
  if (/\/pages?\/|\/policies\//i.test(p)) return 'pages';
  return 'other';
}

const locs = (xml) => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((m) => decode(m[1]));

export async function collect(domain, { fetchFn, now = Date.now(), timeoutMs = 12000 }) {
  const errors = [];
  const base = `https://${domain}`;
  const get = async (url, as = 'text') => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : '*/*' }, redirect: 'follow', signal: ctl.signal });
      const text = await res.text();
      return { ok: res.ok, status: res.status, ms: Date.now() - t0, text, url: res.url || url };
    } finally { clearTimeout(timer); }
  };
  const step = async (name, fn) => { try { return await fn(); } catch (e) { errors.push({ step: name, message: String((e && e.message) || e).slice(0, 160) }); return null; } };
  const json = (r, name) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); try { return JSON.parse(r.text); } catch { throw new Error(`${name} 返回的不是 JSON`); } };

  const [tranco, home, meta, productsRaw, bestHtml, sitemap, rdap] = await Promise.all([
    step('Tranco 排名', async () => parseTranco(json(await get(`https://tranco-list.eu/api/ranks/domain/${domain}`, 'json'), 'Tranco'))),
    step('店铺首页', async () => get(`${base}/`)),
    step('Shopify meta.json', async () => { const r = await get(`${base}/meta.json`, 'json'); return r.ok ? JSON.parse(r.text) : null; }),
    step('Shopify products.json', async () => {
      const all = []; let truncated = false;
      for (let page = 1; page <= 4; page++) {
        const r = await get(`${base}/products.json?limit=250&page=${page}`, 'json');
        if (!r.ok) { if (page === 1) throw new Error(`HTTP ${r.status}`); break; }
        const list = JSON.parse(r.text).products || [];
        all.push(...list);
        if (list.length < 250) break;
        if (page === 4) truncated = true;
      }
      return { all, truncated };
    }),
    step('畅销排序页', async () => { const r = await get(`${base}/collections/all?sort_by=best-selling`); return r.ok ? r.text : null; }),
    step('Sitemap', async () => {
      const r = await get(`${base}/sitemap.xml`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const counts = { products: 0, collections: 0, blogs: 0, pages: 0, other: 0 };
      let truncated = false, subs = 0;
      if (/<sitemapindex/i.test(r.text)) {
        const all = locs(r.text); subs = all.length;
        const pick = all.slice(0, 8); truncated = all.length > 8;
        const bodies = await Promise.all(pick.map((u) => get(u).then((x) => (x.ok ? x.text : '')).catch(() => '')));
        for (const b of bodies) for (const u of locs(b.replace(/<image:loc>[\s\S]*?<\/image:loc>/gi, ''))) counts[classifyPath(u)]++;
      } else {
        for (const u of locs(r.text.replace(/<image:loc>[\s\S]*?<\/image:loc>/gi, ''))) counts[classifyPath(u)]++;
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return { found: true, subSitemaps: subs, truncated, counts, total };
    }),
    step('RDAP 域名注册', async () => {
      const j = json(await get(`https://rdap.org/domain/${domain}`, 'json'), 'RDAP');
      const ev = (j.events || []).find((e) => e.eventAction === 'registration');
      if (!ev) throw new Error('RDAP 没有注册日期');
      return { registeredAt: ev.eventDate.slice(0, 10), years: +((now - Date.parse(ev.eventDate)) / (365.25 * 864e5)).toFixed(1), source: 'RDAP' };
    }),
  ]);

  let storefront = null;
  if (home) {
    const t = home.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const tech = detectTech(home.text);
    const platform = (tech.find((x) => x.category === '平台') || {}).name || '未识别';
    storefront = { reachable: home.ok, status: home.status, responseMs: home.ms, title: t ? decode(t[1]).slice(0, 140) : null, platform, tech };
  }

  const shop = meta && meta.name ? {
    name: decode(meta.name), country: meta.country || null, currency: meta.currency || null,
    productsCount: meta.published_products_count ?? null, collectionsCount: meta.published_collections_count ?? null,
    shipsToCount: Array.isArray(meta.ships_to_countries) ? meta.ships_to_countries.length : null,
    shopPayInstallments: !!meta.offers_shop_pay_installments,
  } : null;

  let catalog = null, bestsellers = null, rows = [];
  if (productsRaw && productsRaw.all.length) {
    const s = summarizeCatalog(productsRaw.all, now);
    rows = s.rows;
    catalog = { source: 'products.json', truncated: productsRaw.truncated, ...s.summary };
  }
  if (bestHtml && rows.length) {
    const { handles, scopedToMain } = parseBestsellerHandles(bestHtml, 40);
    const map = new Map(rows.map((r) => [r.handle, r]));
    const items = handles.map((h) => map.get(h)).filter((r) => r && !r.noise).slice(0, 12)
      .map((r) => ({ handle: r.handle, title: r.title, price: r.price, compareAt: r.compareAt, available: r.available }));
    if (items.length >= 3) {
      const ps = items.map((i) => i.price).sort((a, b) => a - b);
      bestsellers = { source: '/collections/all?sort_by=best-selling', scopedToMain, items, medianPrice: quantile(ps, 0.5), p25: quantile(ps, 0.25), p75: quantile(ps, 0.75) };
    }
  }

  // Reviews: read the aggregate shown on the top bestseller's product page.
  let reviews = null;
  const topHandle = bestsellers ? bestsellers.items[0].handle : rows.find((r) => !r.noise && r.available)?.handle;
  if (topHandle) {
    reviews = await step('评价数', async () => {
      const r = await get(`${base}/products/${encodeURIComponent(topHandle)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rv = parseReviews(r.text);
      return rv ? { ...rv, scope: `商品页 /products/${topHandle}` } : null;
    });
  }
  if (!reviews && home) { const rv = parseReviews(home.text); if (rv) reviews = { ...rv, scope: '首页' }; }

  let fx = null;
  const cur = shop && shop.currency;
  if (cur && cur !== 'USD') {
    fx = await step('汇率', async () => {
      const j = json(await get('https://open.er-api.com/v6/latest/USD', 'json'), '汇率');
      const rate = j.rates && j.rates[cur];
      if (!rate) throw new Error(`没有 ${cur} 汇率`);
      return { currency: cur, usdPerUnit: +(1 / rate).toFixed(6), date: (j.time_last_update_utc || '').slice(5, 16), source: 'open.er-api.com' };
    });
  }

  return {
    schema: 1, domain, collectedAt: new Date(now).toISOString(),
    tranco, storefront, shop, catalog, bestsellers, sitemap, domainAge: rdap, reviews, fx, errors,
  };
}
