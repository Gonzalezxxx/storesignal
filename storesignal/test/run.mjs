// Offline tests: parsing logic against shapes captured from real endpoints.
import assert from 'node:assert/strict';
import { collect, normalizeDomain, parseTranco, summarizeCatalog, parseBestsellerHandles, parseReviews, classifyPath, detectTech } from '../worker/src/collect.js';
import { estimate, signalScore, classify, visitsParams, backtest, FIT, AD_PRIORS } from '../site/model.js';

const NOW = Date.parse('2026-11-14T17:00:00Z');
assert.equal(normalizeDomain('https://www.BigBlanket.com/products/x?y=1'), 'bigblanket.com');
assert.equal(normalizeDomain('127.0.0.1'), null);
assert.equal(normalizeDomain('localhost'), null);
assert.equal(normalizeDomain('foo bar.com'), null);
assert.equal(normalizeDomain('ca.monos.com'), 'ca.monos.com');

const tr = parseTranco({ ranks: [{ date: '2026-11-13', rank: 314672 }, { date: '2026-11-12', rank: 318172 }, { date: '2026-10-15', rank: 415859 }] });
assert.equal(tr.latest.rank, 314672); assert.equal(tr.series[0].date, '2026-10-15'); assert.ok(tr.improvementPct > 24 && tr.improvementPct < 25);
assert.equal(parseTranco({ ranks: [], domain: 'x.com' }).ranked, false);

const P = (handle, price, cmp, avail, pub, type, title = handle) => ({ handle, title, product_type: type, published_at: pub + 'T00:00:00-06:00', variants: [{ price: String(price), compare_at_price: cmp ? String(cmp) : null, available: !!avail }, { price: String(price + 40), compare_at_price: null, available: false }] });
const products = [
  P('the-big-blanket', 120, 200, 1, '2024-09-13', 'Blankets > Stretch Blanket'),
  P('hideout-hoodie', 80, 120, 1, '2024-12-09', 'Wearables > Hoodie'),
  P('premier-plush', 150, 299, 1, '2020-02-12', 'Blankets > Plush Blanket'),
  P('woven-big-blanket', 295, 299, 1, '2019-07-08', 'Blankets > Woven Blanket'),
  P('cozy-toes-socks', 25, 25, 1, '2024-04-17', 'Accessories > Socks'),
  P('memory-foam-pillow', 60, 80, 1, '2026-11-13', 'Bedding > Pillow'),
  P('free-gift-card-reward', 0, 0, 1, '2026-11-12', 'Gift Cards > Digital Gift Card'),
  P('cozycare-order-protection', 4.95, 0, 1, '2025-12-23', 'Product Add-Ons > Order Protection'),
  P('cloud-luxe-robe-pre-order', 90, 150, 0, '2026-10-15', 'Wearables > Robe'),
];
const cat = summarizeCatalog(products, NOW);
assert.equal(cat.summary.total, 9); assert.equal(cat.summary.noiseExcluded, 2); assert.equal(cat.summary.priced, 7);
assert.equal(cat.summary.price.median, 90); assert.equal(cat.summary.newLast90d, 2);
assert.equal(cat.summary.inStockPct, 85.7);
assert.equal(cat.summary.publishedByMonth.length, 12); assert.equal(cat.summary.publishedByMonth[11].month, '2026-11');
assert.equal(cat.summary.histogram.reduce((s, b) => s + b.count, 0), 7);

const bestHtml = `<header><a href="/products/hideout-robe">nav</a></header><main id="m"><a href="/products/the-big-blanket">a</a><a href="/collections/all/products/hideout-hoodie?variant=1">b</a><a href="https://bigblanket.com/products/premier-plush">c</a><a href="/products/the-big-blanket">dup</a><a href="/products/woven-big-blanket">d</a></main>`;
assert.deepEqual(parseBestsellerHandles(bestHtml).handles, ['the-big-blanket', 'hideout-hoodie', 'premier-plush', 'woven-big-blanket']);

const oke = 'x"recommendationCount":15671,"replyCount":4945,"reviewCount":15928,"reviewCountByLevel":{"level1Count":37,"level2Count":55,"level3Count":165,"level4Count":699,"level5Count":14972}';
const rv = parseReviews(oke); assert.equal(rv.count, 15928); assert.equal(rv.rating, 4.92);
assert.equal(parseReviews('{"aggregateRating":{"@type":"AggregateRating","ratingValue":"4.7","reviewCount":"312"}}').count, 312);
assert.equal(parseReviews(`<div class="jdgm-prev-badge" data-average-rating='4.81' data-number-of-reviews='96'>`).rating, 4.81);
assert.equal(parseReviews('<p>no reviews here</p>'), null);
assert.equal(classifyPath('https://x.com/products/a'), 'products'); assert.equal(classifyPath('https://x.com/blogs/news/a'), 'blogs'); assert.equal(classifyPath('https://x.com/'), 'other');
assert.deepEqual(detectTech('<script src="https://cdn.shopify.com/a.js"></script> the letter was stamped and judged').map((t) => t.name), ['Shopify']);

// End to end with a mocked network built from the real shapes.
const routes = {
  'https://tranco-list.eu/api/ranks/domain/bigblanket.com': JSON.stringify({ ranks: [{ date: '2026-11-13', rank: 314672 }, { date: '2026-10-15', rank: 415859 }] }),
  'https://bigblanket.com/': `<html><title>\nBig Blanket Co® | World's Biggest Blankets &amp; Bedding\n</title><script src="https://cdn.shopify.com/x.js"></script><script>fbq('init')</script><script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script><div data-oke-widget></div></html>`,
  'https://bigblanket.com/meta.json': JSON.stringify({ name: 'Big Blanket Co', country: 'US', currency: 'USD', published_products_count: 118, published_collections_count: 45, ships_to_countries: ['US', 'CA'], offers_shop_pay_installments: true }),
  'https://bigblanket.com/products.json?limit=250&page=1': JSON.stringify({ products }),
  'https://bigblanket.com/collections/all?sort_by=best-selling': bestHtml,
  'https://bigblanket.com/sitemap.xml': `<sitemapindex><sitemap><loc>https://bigblanket.com/sitemap_products_1.xml?from=1&amp;to=2</loc></sitemap><sitemap><loc>https://bigblanket.com/sitemap_blogs_1.xml</loc></sitemap></sitemapindex>`,
  'https://bigblanket.com/sitemap_products_1.xml?from=1&to=2': `<urlset><url><loc>https://bigblanket.com/</loc></url><url><loc>https://bigblanket.com/products/the-big-blanket</loc><image:image><image:loc>https://cdn.shopify.com/products/x.webp</image:loc></image:image></url><url><loc>https://bigblanket.com/products/premier-plush</loc></url></urlset>`,
  'https://bigblanket.com/sitemap_blogs_1.xml': `<urlset><url><loc>https://bigblanket.com/blogs/news</loc></url></urlset>`,
  'https://rdap.org/domain/bigblanket.com': JSON.stringify({ events: [{ eventAction: 'registration', eventDate: '2004-06-05T00:14:27Z' }] }),
  'https://bigblanket.com/products/the-big-blanket': oke,
};
const fetchFn = async (u) => { const body = routes[u]; return body === undefined ? { ok: false, status: 404, text: async () => '', url: u } : { ok: true, status: 200, text: async () => body, url: u }; };
const out = await collect('bigblanket.com', { fetchFn, now: NOW });
assert.deepEqual(out.errors, []);
assert.equal(out.tranco.latest.rank, 314672); assert.equal(out.storefront.platform, 'Shopify');
assert.equal(out.storefront.title, "Big Blanket Co® | World's Biggest Blankets & Bedding");
assert.deepEqual(out.storefront.tech.map((t) => t.name), ['Shopify', 'Meta Pixel', 'Klaviyo', 'Okendo']);
assert.equal(out.shop.productsCount, 118); assert.equal(out.bestsellers.items.length, 4); assert.equal(out.bestsellers.medianPrice, 135);
assert.deepEqual(out.sitemap.counts, { products: 2, collections: 0, blogs: 1, pages: 0, other: 1 });
assert.equal(out.domainAge.registeredAt, '2004-06-05'); assert.equal(out.domainAge.years, 22.4);
assert.equal(out.reviews.count, 15928); assert.equal(out.fx, null);

// A dead or non Shopify site must degrade to nulls, never to invented numbers.
const dead = await collect('nothing-here.com', { fetchFn: async (u) => ({ ok: false, status: 404, text: async () => '', url: u }), now: NOW });
assert.equal(dead.catalog, null); assert.equal(dead.bestsellers, null); assert.equal(dead.reviews, null); assert.equal(dead.tranco, null); assert.ok(dead.errors.length >= 3);

// Model arithmetic.
const e = estimate(out, {});
assert.equal(e.type.cls, 'ad'); assert.equal(e.type.points, 3);
const C = visitsParams(e.type.cls).constant;
assert.equal(e.visits.mid, Math.round(C / 314672));
assert.ok(FIT.ad.constant > FIT.brand.constant); assert.equal(FIT.brand.n, 3); assert.equal(FIT.ad.n, 2);
assert.ok(Math.abs(e.cvr.mid - AD_PRIORS.cvrPct) < 1e-9);
const brandLike = { ...out, catalog: { ...out.catalog, onSalePct: 18, medianDiscountPct: 40, total: 93 } };
assert.equal(classify(brandLike).cls, 'brand'); assert.equal(estimate(brandLike, {}).visits.mid, Math.round(FIT.brand.constant / 314672));
assert.equal(classify({ ...out, catalog: { ...out.catalog, onSalePct: 68.8, medianDiscountPct: 33, total: 67 }, domainAge: null }).cls, 'mixed');
assert.equal(classify(dead).cls, 'unknown');
for (const b of backtest()) assert.ok(b.ratio > 1 / FIT[b.cls].factor - 1e-9 && b.ratio < FIT[b.cls].factor + 1e-9);
const known = estimate({ ...out, domain: 'officialsnugsy.com', tranco: { ranked: false, series: [] } }, {});
assert.equal(known.known.orders, 380); assert.deepEqual(known.reference, { low: 380, high: 600, n: 2 });
assert.ok(Math.abs(e.aov.mid - 135 * 1.1) < 0.01);
assert.ok(Math.abs(e.orders.mid - e.visits.mid * e.cvr.mid / 100) < 1);
assert.ok(Math.abs(e.gmv.mid - e.visits.mid * e.cvr.mid / 100 * e.aov.mid) < 2);
assert.ok(e.gmv.low < e.gmv.mid && e.gmv.mid < e.gmv.high);
assert.ok(Math.abs(e.gmv.high / e.gmv.mid - e.gmv.mid / e.gmv.low) < 0.01);
const eDead = estimate(dead, {}); assert.equal(eDead.gmv, null); assert.equal(eDead.visits, null);
const eUn = estimate({ ...out, tranco: { ranked: false, series: [] } }, {}); assert.equal(eUn.visits.mid, null); assert.ok(eUn.visits.upperBound > 0); assert.equal(eUn.gmv.mid, null); assert.ok(eUn.gmv.upperBound > 0);
const eOv = estimate(out, { visits: 100000, cvrPct: 2, basket: 1 }); assert.equal(eOv.orders.mid, 2000); assert.equal(Math.round(eOv.gmv.mid), 270000);
const sc = signalScore(out); assert.ok(sc.total >= 0 && sc.total <= 100); assert.ok(Math.abs(sc.rows.filter((r) => r.score !== null).reduce((s, r) => s + r.weightUsed, 0) - 100) < 0.01);
console.log('ALL TESTS PASSED');
console.log(JSON.stringify({ visits: e.visits, cvr: e.cvr, aov: e.aov, orders: e.orders, gmv: e.gmv, score: sc.total }, null, 1));
