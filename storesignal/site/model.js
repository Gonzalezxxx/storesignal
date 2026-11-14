// StoreSignal estimation model. Everything here is an ESTIMATE built on top of
// measured signals. Every assumption is a named constant so it can be shown in
// the UI, challenged, and replaced with calibration data later.

// Anchors: third party traffic estimates paired with the Tranco rank of the
// same site. They are other tools' estimates, not ground truth. Replace or
// extend this list with sites whose real traffic you know.
export const ANCHORS = [
  { domain: 'bigblanket.com', rank: 400000, visits: 260000, note: 'Grips 22万到28万 sessions，BrandSearch 27万；对应当时排名约 40 万' },
  { domain: 'monos.com', rank: 165000, visits: 1000000, note: 'Semrush 113万，Grips 97万到116万，BrandSearch 96万' },
  { domain: 'fellowproducts.com', rank: 86400, visits: 614000, note: 'Semrush 61.4万' },
];

// visits = C / rank (Zipf prior, exponent fixed at 1 because three anchors
// cannot support fitting a slope). C is the geometric mean of rank x visits.
const logs = ANCHORS.map((a) => Math.log(a.rank * a.visits));
const meanLog = logs.reduce((s, x) => s + x, 0) / logs.length;
const worstResidual = Math.max(...logs.map((x) => Math.abs(x - meanLog)));

export const MODEL = {
  visitsConstant: Math.exp(meanLog),
  // Uncertainty multiplier on visits: at least 2x either way, or the worst anchor miss if larger.
  visitsFactor: Math.max(2, Math.exp(worstResidual)),
  trancoListSize: 1000000,
  cvrBasePct: 1.4, // typical Shopify store conversion, a public benchmark level prior
  cvrRefAov: 60, // AOV at which the base applies
  cvrElasticity: 0.3, // higher ticket converts lower
  cvrMinPct: 0.5, cvrMaxPct: 2.5,
  cvrFactor: 1.8,
  basketDefault: 1.1, // items per order uplift over one bestseller price
  aovFactorBestseller: 1.1,
  aovFactorCatalog: 1.4,
};

const combine = (...factors) => Math.exp(Math.sqrt(factors.reduce((s, f) => s + Math.log(f) ** 2, 0)));
const band = (mid, factor) => ({ mid, low: mid / factor, high: mid * factor, factor });
const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);

export function estimate(data, overrides = {}) {
  const ov = { visits: num(overrides.visits), cvrPct: num(overrides.cvrPct), basket: num(overrides.basket) };

  // 1) Visits.
  let visits = null;
  const t = data.tranco;
  if (ov.visits) {
    visits = { ...band(ov.visits, 1), upperBound: null, basis: '你手动输入的月访问量', overridden: true };
  } else if (t && t.ranked) {
    const mid = Math.round(MODEL.visitsConstant / t.latest.rank);
    visits = { ...band(mid, MODEL.visitsFactor), upperBound: null, basis: `Tranco 排名 #${t.latest.rank.toLocaleString('en-US')} 按 访问量 = C ÷ 排名 换算`, overridden: false };
  } else if (t && !t.ranked) {
    visits = { mid: null, low: null, high: null, factor: null, upperBound: Math.round(MODEL.visitsConstant / MODEL.trancoListSize), basis: '未进入 Tranco 前 100 万，只能给出上限', overridden: false };
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
  else if (aov) {
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
  return { visits, cvr, aov, orders, gmv, fxMissing };
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Observable signal score. It summarizes what can be SEEN from outside.
// It is not a profitability or creditworthiness score.
export function signalScore(data) {
  const rows = [];
  const add = (name, weight, score, raw, how) => rows.push({ name, weight, score: score === null ? null : Math.round(score), raw, how });
  const t = data.tranco;
  add('流量排名', 25, t ? (t.ranked ? clamp01((6 - Math.log10(t.latest.rank)) / 2) * 100 : 0) : null,
    t ? (t.ranked ? `#${t.latest.rank.toLocaleString('en-US')}` : '未进前 100 万') : '未取到', '前 1 万得满分，100 万名得 0 分，对数刻度');
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
