// StoreSignal estimation model. Everything here is an ESTIMATE built on top of
// measured signals. Every assumption is a named constant or a calibration row,
// so it can be shown in the UI, challenged, and replaced with real data.

// Calibration rows. cls: 'brand' (品牌型) or 'ad' (投流型).
// rank + visits rows fit the visits constant of their class.
// orders / aov are shown as known reference values for that exact domain.
// confirmed:false means the number comes from another tool or list and nobody
// with access to the store's real backend has confirmed it here.
export const CALIBRATION = [
  { domain: 'bigblanket.com', cls: 'brand', rank: 400000, visits: 260000, confirmed: false, source: 'Grips 22万到28万 sessions，BrandSearch 27万；对应当时排名约 40 万' },
  { domain: 'monos.com', cls: 'brand', rank: 165000, visits: 1000000, confirmed: false, source: 'Semrush 113万，Grips 97万到116万，BrandSearch 96万' },
  { domain: 'fellowproducts.com', cls: 'brand', rank: 86400, visits: 614000, confirmed: false, source: 'Semrush 61.4万' },
  { domain: 'onpulse.store', cls: 'ad', rank: 4403485, visits: 28500, orders: 600, aov: 59.9, confirmed: false, source: 'SignalPulse 名单，其标注为客户实测：访客 2.5万到3.2万，约 600 单/月' },
  { domain: 'libracases.com', cls: 'ad', rank: 993987, visits: 680000, confirmed: false, source: 'SignalPulse 名单里人工指定的月访客约 68 万' },
  { domain: 'officialsnugsy.com', cls: 'ad', rank: null, orders: 380, aov: 49.9, confirmed: false, source: 'SignalPulse 名单，其标注为客户实测 380 单/月' },
  { domain: 'lovedalwaysjewelry.com', cls: 'ad', rank: null, orders: 600, aov: 25, confirmed: false, source: 'SignalPulse 名单，其标注为客户实测 600 单/月' },
];
export const ANCHORS = CALIBRATION; // kept for older imports

export const MODEL = {
  // Tranco's API returns ranks well past one million (4.4M seen), so "no rank" means beyond that.
  trancoDepth: 4400000,
  minVisitsFactor: 2,
  cvrBasePct: 1.4, cvrRefAov: 60, cvrElasticity: 0.3, cvrMinPct: 0.5, cvrMaxPct: 2.5, cvrFactor: 1.8,
  adCvrFactor: 1.6,
  basketDefault: 1.1, aovFactorBestseller: 1.1, aovFactorCatalog: 1.4,
};

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = (s.length - 1) / 2; return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2; };

// visits = C / rank, fitted per class. Exponent fixed at 1: there are far too
// few rows per class to support fitting a slope.
function fitClass(cls) {
  const rows = CALIBRATION.filter((r) => r.cls === cls && r.rank && r.visits);
  const logs = rows.map((r) => Math.log(r.rank * r.visits));
  const mean = logs.reduce((s, x) => s + x, 0) / logs.length;
  const worst = Math.max(...logs.map((x) => Math.abs(x - mean)));
  return { cls, n: rows.length, constant: Math.exp(mean), factor: Math.max(MODEL.minVisitsFactor, Math.exp(worst)), rows };
}
export const FIT = { brand: fitClass('brand'), ad: fitClass('ad') };
MODEL.visitsConstant = FIT.brand.constant; MODEL.visitsFactor = FIT.brand.factor; // brand curve, kept for older callers

// Known ad stores: conversion implied by known orders over known visits, and
// known order volumes of stores that have no Tranco rank at all.
const adRows = CALIBRATION.filter((r) => r.cls === 'ad');
const adCvrs = adRows.filter((r) => r.orders && r.visits).map((r) => (r.orders / r.visits) * 100);
const adUnrankedOrders = adRows.filter((r) => !r.rank && r.orders).map((r) => r.orders);
export const AD_PRIORS = {
  cvrPct: adCvrs.length ? median(adCvrs) : null, cvrN: adCvrs.length,
  unrankedOrders: adUnrankedOrders.length ? { low: Math.min(...adUnrankedOrders), high: Math.max(...adUnrankedOrders), n: adUnrankedOrders.length } : null,
};

// Store type from measurable catalog signals only.
export function classify(data) {
  const c = data.catalog, age = data.domainAge ? data.domainAge.years : null;
  if (!c || c.onSalePct === null) return { cls: 'unknown', label: '无法判定', points: null, reasons: ['没取到商品目录，按品牌型公式估算'] };
  const checks = [
    [c.onSalePct >= 60, `带划线价商品占 ${c.onSalePct}%`, '≥ 60%'],
    [(c.medianDiscountPct || 0) >= 30, `中位折扣 ${c.medianDiscountPct ?? 0}%`, '≥ 30%'],
    [c.total <= 50, `商品数 ${c.total}`, '≤ 50'],
    [age !== null && age < 5, age === null ? '域名年限未知' : `域名 ${age} 年`, '< 5 年'],
  ];
  const points = checks.filter((x) => x[0]).length;
  const reasons = checks.map((x) => `${x[0] ? '✓' : '✗'} ${x[1]}（投流型特征：${x[2]}）`);
  if (points >= 3) return { cls: 'ad', label: '投流型', points, reasons };
  if ((age !== null && age >= 8) || c.onSalePct < 40) return { cls: 'brand', label: '品牌型', points, reasons };
  return { cls: 'mixed', label: '混合型', points, reasons };
}

export function visitsParams(cls) {
  if (cls === 'ad') return { constant: FIT.ad.constant, factor: FIT.ad.factor, n: FIT.ad.n };
  if (cls === 'mixed') {
    // Between the two curves, with a range wide enough to span both.
    return { constant: Math.sqrt(FIT.ad.constant * FIT.brand.constant), factor: Math.sqrt(FIT.ad.constant / FIT.brand.constant) * MODEL.minVisitsFactor, n: FIT.ad.n + FIT.brand.n };
  }
  return { constant: FIT.brand.constant, factor: FIT.brand.factor, n: FIT.brand.n };
}

const combine = (...factors) => Math.exp(Math.sqrt(factors.reduce((s, f) => s + Math.log(f) ** 2, 0)));
const band = (mid, factor) => ({ mid, low: mid / factor, high: mid * factor, factor });
const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);

export function estimate(data, overrides = {}) {
  const ov = { visits: num(overrides.visits), cvrPct: num(overrides.cvrPct), basket: num(overrides.basket) };
  const type = classify(data);
  const vp = visitsParams(type.cls);
  const known = CALIBRATION.find((r) => r.domain === data.domain && (r.orders || r.visits)) || null;

  // 1) Visits.
  let visits = null;
  const t = data.tranco;
  if (ov.visits) {
    visits = { ...band(ov.visits, 1), upperBound: null, basis: '你手动输入的月访问量', overridden: true };
  } else if (t && t.ranked) {
    const mid = Math.round(vp.constant / t.latest.rank);
    visits = { ...band(mid, vp.factor), upperBound: null, basis: `Tranco 排名 #${t.latest.rank.toLocaleString('en-US')} 按${type.label}常数换算（${vp.n} 个锚点）`, overridden: false };
  } else if (t && !t.ranked) {
    visits = { mid: null, low: null, high: null, factor: null, upperBound: Math.round((vp.constant * vp.factor) / MODEL.trancoDepth), basis: '不在 Tranco 榜单内，只能给出上限', overridden: false };
  }

  // 2) AOV in USD.
  let aov = null;
  const usd = data.fx ? data.fx.usdPerUnit : 1;
  const currency = (data.shop && data.shop.currency) || 'USD';
  const fxMissing = currency !== 'USD' && !data.fx;
  const basket = ov.basket || MODEL.basketDefault;
  const base = data.bestsellers ? { price: data.bestsellers.medianPrice, factor: MODEL.aovFactorBestseller, label: `畅销前 ${data.bestsellers.items.length} 款价格中位数` }
    : data.catalog && data.catalog.price ? { price: data.catalog.price.median, factor: MODEL.aovFactorCatalog, label: '全目录价格中位数（没拿到畅销排序）' } : null;
  if (base && !fxMissing) {
    const mid = base.price * usd * basket;
    aov = { ...band(mid, ov.basket ? 1.05 : base.factor), basePrice: base.price, baseLabel: base.label, basket, currency, usdPerUnit: usd, overridden: !!ov.basket };
  }

  // 3) Conversion rate, percent.
  let cvr = null;
  if (ov.cvrPct) cvr = { ...band(ov.cvrPct, 1), basis: '你手动输入的转化率', overridden: true };
  else if (aov && type.cls === 'ad' && AD_PRIORS.cvrPct) {
    cvr = { ...band(AD_PRIORS.cvrPct, MODEL.adCvrFactor), basis: `已知投流型店铺的转化率中位数（${AD_PRIORS.cvrN} 个）`, overridden: false };
  } else if (aov) {
    const raw = MODEL.cvrBasePct * (MODEL.cvrRefAov / aov.mid) ** MODEL.cvrElasticity;
    const mid = Math.min(MODEL.cvrMaxPct, Math.max(MODEL.cvrMinPct, raw));
    cvr = { ...band(mid, MODEL.cvrFactor), basis: `行业先验 ${MODEL.cvrBasePct}% 按客单价弹性修正`, overridden: false };
  }

  // 4) Orders and GMV. Ranges combine in log space, they are not multiplied end to end.
  let orders = null, gmv = null;
  if (visits && cvr && aov) {
    if (visits.mid !== null) {
      orders = { ...band(visits.mid * cvr.mid / 100, combine(visits.factor, cvr.factor)), upperBound: null };
      gmv = { ...band(visits.mid * cvr.mid / 100 * aov.mid, combine(visits.factor, cvr.factor, aov.factor)), upperBound: null };
    } else {
      const o = visits.upperBound * cvr.high / 100;
      orders = { mid: null, low: null, high: null, factor: null, upperBound: o };
      gmv = { mid: null, low: null, high: null, factor: null, upperBound: o * aov.high };
    }
  }
  // Reference class for ad stores with no rank: what known stores of this kind actually sell.
  const reference = type.cls === 'ad' && visits && visits.mid === null && AD_PRIORS.unrankedOrders ? AD_PRIORS.unrankedOrders : null;
  return { type, visits, cvr, aov, orders, gmv, fxMissing, known, reference };
}

// How well each class curve reproduces its own anchors (in sample, so optimistic).
export function backtest() {
  return CALIBRATION.filter((r) => r.rank && r.visits).map((r) => {
    const model = FIT[r.cls].constant / r.rank;
    return { domain: r.domain, cls: r.cls, rank: r.rank, known: r.visits, model: Math.round(model), ratio: model / r.visits, confirmed: r.confirmed };
  });
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Observable signal score. It summarizes what can be SEEN from outside.
// It is not a profitability or creditworthiness score.
export function signalScore(data) {
  const rows = [];
  const add = (name, weight, score, raw, how) => rows.push({ name, weight, score: score === null ? null : Math.round(score), raw, how });
  const t = data.tranco;
  add('流量排名', 25, t ? (t.ranked ? clamp01((6.7 - Math.log10(t.latest.rank)) / 2.7) * 100 : 0) : null,
    t ? (t.ranked ? `#${t.latest.rank.toLocaleString('en-US')}` : '不在榜单内') : '未取到', '前 1 万得满分，约 500 万名得 0 分，对数刻度');
  add('排名趋势', 10, t && t.ranked && t.days >= 7 ? clamp01(0.5 + t.improvementPct / 40) * 100 : null,
    t && t.ranked ? `${t.days} 天 ${t.improvementPct >= 0 ? '上升' : '下降'} ${Math.abs(t.improvementPct)}%` : '无', '持平 50 分，上升 20% 满分，下降 20% 0 分');
  const a = data.domainAge;
  add('域名年限', 10, a ? clamp01(a.years / 5) * 100 : null, a ? `${a.years} 年` : '未取到', '满 5 年得满分');
  const c = data.catalog;
  add('目录活跃度', 15, c && c.inStockPct !== null ? 0.5 * c.inStockPct + 0.5 * clamp01(c.newLast90d / 5) * 100 : null,
    c ? `在售 ${c.inStockPct}%，近 90 天上新 ${c.newLast90d} 款` : '未取到', '在售率占一半，近 90 天上新满 5 款占一半');
  const r = data.reviews;
  add('评价口碑', 20, r ? 0.5 * clamp01((r.rating - 3.5) / 1.3) * 100 + 0.5 * clamp01(Math.log10(r.count) / 4) * 100 : null,
    r ? `${r.rating} 星，${r.count.toLocaleString('en-US')} 条` : '未取到', '星级 3.5 到 4.8 占一半，评价数对数到 1 万条占一半');
  const s = data.storefront;
  const cats = ['广告像素', '邮件短信', '评价', '支付分期', '归因'];
  const have = s ? cats.filter((k) => s.tech.some((x) => x.category === k)) : [];
  add('营销技术栈', 10, s && s.reachable ? (have.length / cats.length) * 100 : null, s ? `${have.length} / ${cats.length} 类` : '未取到', '广告像素、邮件短信、评价、支付分期、归因，每类 20 分');
  const depth = c && c.onSalePct !== null ? (c.onSalePct / 100) * ((c.medianDiscountPct || 0) / 100) : null;
  add('折扣依赖度', 10, depth === null ? null : (1 - clamp01(depth * 2.5)) * 100,
    c && c.onSalePct !== null ? `${c.onSalePct}% 商品有划线价，中位折扣 ${c.medianDiscountPct ?? 0}%` : '未取到', '打折商品占比 × 折扣深度，越低分越高');

  const usedWeight = rows.filter((x) => x.score !== null).reduce((sum, x) => sum + x.weight, 0);
  for (const x of rows) { x.weightUsed = x.score === null || !usedWeight ? 0 : (x.weight / usedWeight) * 100; x.contribution = x.score === null ? 0 : (x.score * x.weightUsed) / 100; }
  const total = usedWeight ? Math.round(rows.reduce((sum, x) => sum + x.contribution, 0)) : null;
  return { total, rows, coveragePct: usedWeight };
}
