import { estimate, signalScore, MODEL, CALIBRATION, FIT, AD_PRIORS, backtest } from './model.js';

const $ = (s) => document.querySelector(s);
const app = $('#app');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const int = (n) => (n === null || n === undefined ? '无' : Math.round(n).toLocaleString('en-US'));
const compact = (n) => (n === null || n === undefined ? '无' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K' : String(Math.round(n)));
const usd = (n) => (n === null || n === undefined ? '无' : '$' + compact(n));
const money = (n, cur) => (n === null || n === undefined ? '无' : (cur === 'USD' ? '$' : cur + ' ') + (+n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const T = { m: '<span class="tag m">实测</span>', e: '<span class="tag e">推算</span>', a: '<span class="tag a">假设</span>', n: '<span class="tag n">未取到</span>' };

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};
const state = { view: 'analyze', data: null, isSample: false, overrides: {}, loading: null, error: null, compare: [] };
const workerUrl = () => (store.get('ss.worker', '') || (window.SS_CONFIG && window.SS_CONFIG.workerUrl) || '').replace(/\/+$/, '');
const cleanDomain = (s) => String(s || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[\/?#].*$/, '').replace(/^www\./, '');

async function fetchAnalysis(domain, fresh) {
  const w = workerUrl();
  if (!w) throw new Error('还没有配置采集端地址。点右上角“设置”填入你的 Cloudflare Worker 地址，或先点“看示例”。');
  const res = await fetch(`${w}/api/analyze?domain=${encodeURIComponent(domain)}${fresh ? '&fresh=1' : ''}`);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw new Error((body && body.error) || `采集端返回 HTTP ${res.status}`);
  return body;
}

function snapshot(data) {
  const e = estimate(data, {});
  const s = { t: data.collectedAt, rank: data.tranco && data.tranco.ranked ? data.tranco.latest.rank : null, products: data.catalog ? data.catalog.total : null,
    reviews: data.reviews ? data.reviews.count : null, rating: data.reviews ? data.reviews.rating : null, bestPrice: data.bestsellers ? data.bestsellers.medianPrice : null,
    gmvMid: e.gmv && e.gmv.mid ? Math.round(e.gmv.mid) : null, score: signalScore(data).total, name: data.shop ? data.shop.name : null };
  const key = 'ss.hist.' + data.domain;
  const hist = store.get(key, []);
  if (!hist.length || hist[hist.length - 1].t.slice(0, 10) !== s.t.slice(0, 10)) hist.push(s); else hist[hist.length - 1] = s;
  store.set(key, hist.slice(-120));
}

// ---------- charts (single series each, brand purple, hover tooltip) ----------
const tip = $('#tip');
document.addEventListener('mousemove', (ev) => {
  const el = ev.target.closest && ev.target.closest('[data-tip]');
  if (!el) { tip.style.display = 'none'; return; }
  tip.textContent = el.getAttribute('data-tip'); tip.style.display = 'block';
  tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, ev.clientX + 12) + 'px'; tip.style.top = ev.clientY + 14 + 'px';
});

function barChart(items, { height = 190, fmt = int } = {}) {
  const W = 520, H = height, pl = 34, pr = 8, pt = 10, pb = 34;
  const max = Math.max(1, ...items.map((i) => i.value));
  const bw = (W - pl - pr) / items.length;
  const y = (v) => pt + (H - pt - pb) * (1 - v / max);
  const ticks = [0, max / 2, max];
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">
    ${ticks.map((t) => `<line x1="${pl}" x2="${W - pr}" y1="${y(t)}" y2="${y(t)}" stroke="#e3dcec" stroke-width="1"/><text x="${pl - 6}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join('')}
    ${items.map((it, i) => { const h = Math.max(it.value > 0 ? 2 : 0, H - pb - y(it.value)); const x = pl + i * bw + 2; const w = Math.max(2, bw - 4);
      return `<g data-tip="${esc(it.tip || `${it.label}：${fmt(it.value)}`)}"><rect x="${pl + i * bw}" y="${pt}" width="${bw}" height="${H - pt - pb}" fill="transparent"/><path d="M${x},${H - pb} v${-Math.max(0, h - 4)} q0,-4 4,-4 h${Math.max(0, w - 8)} q4,0 4,4 v${Math.max(0, h - 4)} z" fill="#664398" ${h < 5 ? 'opacity="0"' : ''}/>${h >= 2 && h < 5 ? `<rect x="${x}" y="${H - pb - h}" width="${w}" height="${h}" fill="#664398"/>` : ''}
      <text x="${pl + i * bw + bw / 2}" y="${H - pb + 14}" text-anchor="middle">${esc(it.label)}</text>${it.sub ? `<text x="${pl + i * bw + bw / 2}" y="${H - pb + 27}" text-anchor="middle">${esc(it.sub)}</text>` : ''}</g>`; }).join('')}
    <line x1="${pl}" x2="${W - pr}" y1="${H - pb}" y2="${H - pb}" stroke="#c9bfd9"/></svg>`;
}

function rankChart(series) {
  const W = 520, H = 190, pl = 56, pr = 10, pt = 12, pb = 26;
  const vals = series.map((s) => s.rank), lo = Math.min(...vals), hi = Math.max(...vals), pad = Math.max(1, (hi - lo) * 0.1);
  const a = lo - pad, b = hi + pad;
  const x = (i) => pl + ((W - pl - pr) * i) / Math.max(1, series.length - 1);
  const y = (v) => pt + ((H - pt - pb) * (v - a)) / (b - a); // smaller rank number is drawn higher
  const path = series.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.rank).toFixed(1)}`).join(' ');
  const step = (W - pl - pr) / Math.max(1, series.length - 1);
  const last = series.length - 1;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">
    ${[lo, (lo + hi) / 2, hi].map((t) => `<line x1="${pl}" x2="${W - pr}" y1="${y(t)}" y2="${y(t)}" stroke="#e3dcec"/><text x="${pl - 6}" y="${y(t) + 4}" text-anchor="end">#${compact(t)}</text>`).join('')}
    <path d="${path}" fill="none" stroke="#664398" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${x(last)}" cy="${y(series[last].rank)}" r="4" fill="#664398" stroke="#fff" stroke-width="2"/>
    <text x="${pl}" y="${H - 6}">${esc(series[0].date.slice(5))}</text><text x="${W - pr}" y="${H - 6}" text-anchor="end">${esc(series[last].date.slice(5))}</text>
    ${series.map((s, i) => `<rect data-tip="${esc(s.date)}：#${int(s.rank)}" x="${x(i) - step / 2}" y="${pt}" width="${step}" height="${H - pt - pb}" fill="transparent"/>`).join('')}</svg>`;
}

function hbars(items) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return `<table>${items.map((it) => `<tr><td style="width:110px">${esc(it.label)}</td><td><div data-tip="${esc(it.label)}：${int(it.value)}" style="background:#664398;height:14px;border-radius:0 4px 4px 0;width:${Math.max(it.value ? 1 : 0, (it.value / max) * 100)}%"></div></td><td class="r" style="width:70px">${int(it.value)}</td></tr>`).join('')}</table>`;
}

// ---------- analysis view ----------
function rangeText(b, f) { return b.mid === null ? `不超过 ${f(b.upperBound)}` : `${f(b.low)} 到 ${f(b.high)}`; }

function renderAnalysis() {
  const d = state.data;
  if (state.loading) return `<div class="empty">正在采集 ${esc(state.loading)} 的公开信号，通常需要 5 到 15 秒…</div>`;
  if (state.error) return `<div class="note warn">${esc(state.error)}</div>${d ? '' : intro()}`;
  if (!d) return intro();
  const e = estimate(d, state.overrides), sc = signalScore(d);
  const cur = (d.shop && d.shop.currency) || 'USD';
  const watch = store.get('ss.watch', []);
  const t = d.tranco, c = d.catalog, b = d.bestsellers, r = d.reviews, s = d.storefront, sm = d.sitemap;
  const tile = (k, tag, v, sub, est) => `<div class="tile ${est ? 'est' : ''}"><div class="k"><span>${k}</span>${tag}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  const anyOverride = Object.values(state.overrides).some((v) => v);

  return `
  ${state.isSample ? `<div class="note">这是内置示例：${esc(d.collectedAt.slice(0, 10))} 对 bigblanket.com 的一次真实采集结果。配置采集端后即可分析任意域名。</div>` : ''}
  <div class="head"><div><h1>${esc((d.shop && d.shop.name) || d.domain)}</h1>
    <div class="meta">${esc(d.domain)} · <b>${esc(e.type.label)}</b> · ${esc(s ? s.platform : '平台未识别')}${d.shop && d.shop.country ? ' · ' + esc(d.shop.country) : ''} · ${esc(cur)} · 采集于 ${esc(d.collectedAt.replace('T', ' ').slice(0, 16))} UTC${d.cached ? ' · 来自 6 小时缓存' : ''}</div></div>
    <div class="row">${state.isSample ? '' : `<button class="ghost" data-act="refresh">重新采集</button>`}<button class="ghost" data-act="watch">${watch.includes(d.domain) ? '已在关注列表' : '加入关注'}</button><button class="ghost" data-act="export">导出 JSON</button></div></div>

  <div class="grid g6" style="margin-bottom:16px">
    ${tile('Tranco 全球排名', t ? T.m : T.n, t ? (t.ranked ? '#' + int(t.latest.rank) : '不在榜单内') : '无', t && t.ranked ? `${t.days} 天${t.improvementPct >= 0 ? '上升' : '下降'} ${Math.abs(t.improvementPct)}%` : '榜单约收录前 440 万名')}
    ${tile('月访问量', e.visits ? (e.visits.overridden ? T.a : T.e) : T.n, e.visits ? (e.visits.mid === null ? '≤ ' + compact(e.visits.upperBound) : compact(e.visits.mid)) : '无', e.visits && e.visits.mid !== null && !e.visits.overridden ? `区间 ${compact(e.visits.low)} 到 ${compact(e.visits.high)}` : e.visits ? esc(e.visits.basis) : '没有排名数据', true)}
    ${tile('畅销款价格中位数', b ? T.m : c ? T.m : T.n, b ? money(b.medianPrice, cur) : c && c.price ? money(c.price.median, cur) : '无', b ? `前 ${b.items.length} 款，${money(b.p25, cur)} 到 ${money(b.p75, cur)}` : c ? '全目录中位数' : '没取到商品')}
    ${tile('月订单量', e.orders ? T.e : T.n, e.orders ? (e.orders.mid === null ? '≤ ' + compact(e.orders.upperBound) : compact(e.orders.mid)) : '无', e.orders && e.orders.mid !== null ? `区间 ${compact(e.orders.low)} 到 ${compact(e.orders.high)}` : e.orders ? '只能给上限' : '数据不足', true)}
    ${tile('月 GMV', e.gmv ? T.e : T.n, e.gmv ? (e.gmv.mid === null ? '≤ ' + usd(e.gmv.upperBound) : usd(e.gmv.mid)) : '无', e.gmv && e.gmv.mid !== null ? `区间 ${usd(e.gmv.low)} 到 ${usd(e.gmv.high)}` : e.gmv ? '只能给上限' : '数据不足', true)}
    ${tile('可观测信号分', T.e, sc.total === null ? '无' : sc.total + ' / 100', `覆盖 ${sc.rows.filter((x) => x.score !== null).length} / ${sc.rows.length} 项信号`, true)}
  </div>

  <div class="card"><h2>GMV 推算链路<small>每一步都写明来源，输入框可以替换成你知道的真实值</small></h2><div class="body">
    ${e.fxMissing ? `<div class="note warn">店铺货币是 ${esc(cur)}，但汇率没取到，所以不做美元换算，GMV 留空。</div>` : ''}
    <div class="chain">
      <div class="step"><div class="n">① 月访问量 ${e.visits ? (e.visits.overridden ? T.a : T.e) : T.n}</div><div class="x">${e.visits ? (e.visits.mid === null ? '≤ ' + compact(e.visits.upperBound) : compact(e.visits.mid)) : '无'}</div><div class="d">${e.visits ? esc(e.visits.basis) + (e.visits.mid !== null && !e.visits.overridden ? `，误差约 ${e.visits.factor.toFixed(1)} 倍` : '') : 'Tranco 没取到'}</div></div>
      <div class="step"><div class="n">② 转化率 ${e.cvr ? T.a : T.n}</div><div class="x">${e.cvr ? e.cvr.mid.toFixed(2) + '%' : '无'}</div><div class="d">${e.cvr ? esc(e.cvr.basis) + (e.cvr.overridden ? '' : `，区间 ${e.cvr.low.toFixed(2)}% 到 ${e.cvr.high.toFixed(2)}%`) : '需要先有客单价'}</div></div>
      <div class="step"><div class="n">③ 客单价 ${e.aov ? T.m + ' × ' + T.a : T.n}</div><div class="x">${e.aov ? '$' + e.aov.mid.toFixed(2) : '无'}</div><div class="d">${e.aov ? `${esc(e.aov.baseLabel)} ${money(e.aov.basePrice, cur)} × 连带系数 ${e.aov.basket}${e.aov.usdPerUnit !== 1 ? ` × 汇率 ${e.aov.usdPerUnit}` : ''}` : '没取到商品价格'}</div></div>
      <div class="step" style="background:var(--tint);border-color:var(--brand-mid)"><div class="n">④ 月 GMV ${e.gmv ? T.e : T.n}</div><div class="x">${e.gmv ? (e.gmv.mid === null ? '≤ ' + usd(e.gmv.upperBound) : usd(e.gmv.mid)) : '无'}</div><div class="d">${e.gmv && e.gmv.mid !== null ? `① × ② × ③，订单 ${int(e.orders.mid)} 单/月，日均 ${int(e.orders.mid / 30)} 单` : e.gmv ? '访问量只有上限，所以这里也只有上限' : '链路中有一步缺数据，不硬算'}</div></div>
    </div>
    ${e.gmv && e.gmv.mid !== null ? `<div style="margin-top:14px"><div class="row" style="justify-content:space-between"><b>GMV 区间 ${usd(e.gmv.low)} 到 ${usd(e.gmv.high)}</b><span class="muted">上下各约 ${e.gmv.factor.toFixed(1)} 倍${anyOverride ? '（已按你的输入收窄）' : '，这是免费公开数据能做到的真实精度'}</span></div>
      <div class="bar-range"><i style="left:${pos(e.gmv.low, e.gmv)}%;right:${100 - pos(e.gmv.high, e.gmv)}%"></i><b style="left:${pos(e.gmv.mid, e.gmv)}%"></b></div>
      <div class="row muted" style="justify-content:space-between;font-size:12px"><span>${usd(e.gmv.low / 2)}</span><span>对数刻度，竖线是中值</span><span>${usd(e.gmv.high * 2)}</span></div></div>` : ''}
    <div class="note" style="margin:14px 0 0"><b>店铺类型：${esc(e.type.label)}</b>${e.type.points !== null ? `（投流型特征命中 ${e.type.points} / 4）` : ''}。${e.type.reasons.map(esc).join('；')}。访问量常数按类型分开拟合，见“方法说明”。</div>
    ${e.reference ? `<div class="note" style="margin:10px 0 0"><b>同类参考：</b>已知的 ${e.reference.n} 家无排名投流型店铺，月单量在 ${int(e.reference.low)} 到 ${int(e.reference.high)} 单之间。这是参考，不是对本店的测算。</div>` : ''}
    ${e.known ? `<div class="note warn" style="margin:10px 0 0"><b>本站有已知参考值：</b>${[e.known.visits ? `月访问 ${int(e.known.visits)}` : '', e.known.orders ? `月订单 ${int(e.known.orders)}` : '', e.known.aov ? `客单价 $${e.known.aov}` : ''].filter(Boolean).join('，')}。来源：${esc(e.known.source)}。${e.known.confirmed ? '已确认。' : '尚未经后台数据确认。'}</div>` : ''}
    <div class="ctl">
      <label>已知月访问量（留空则用排名推算）<input type="number" min="0" step="1000" data-ov="visits" value="${esc(state.overrides.visits || '')}" placeholder="${e.visits && e.visits.mid ? Math.round(e.visits.mid) : ''}"></label>
      <label>已知转化率 %（留空则用行业先验）<input type="number" min="0" step="0.1" data-ov="cvrPct" value="${esc(state.overrides.cvrPct || '')}" placeholder="${e.cvr ? e.cvr.mid.toFixed(2) : ''}"></label>
      <label>连带系数（默认 ${MODEL.basketDefault}）<input type="number" min="0.5" step="0.05" data-ov="basket" value="${esc(state.overrides.basket || '')}" placeholder="${MODEL.basketDefault}"></label>
    </div>
  </div></div>

  <div class="grid g2">
    <div class="card"><h2>Tranco 排名走势 ${T.m}<small>越靠上越好</small></h2><div class="body">${t && t.ranked && t.series.length > 1 ? rankChart(t.series) + `<div class="muted" style="font-size:12px">30 天均值 #${int(t.avg30)}。Tranco 是综合多个榜单的公开域名热度排名，本身已做 30 天平滑。</div>` : `<div class="empty">${t ? '该域名不在 Tranco 榜单内，没有走势可画' : '没取到 Tranco 数据'}</div>`}</div></div>
    <div class="card"><h2>商品价格分布 ${T.m}<small>${c ? `${c.priced} 款，已剔除 ${c.noiseExcluded} 个礼品卡或运费险类条目` : ''}</small></h2><div class="body">${c ? barChart(c.histogram.map((h) => ({ label: h.to === null ? `${h.from}+` : `${h.from}`, sub: '', value: h.count, tip: `${h.from} 到 ${h.to === null ? '以上' : h.to} ${cur}：${h.count} 款` }))) + `<div class="muted" style="font-size:12px">横轴是价格区间起点（${esc(cur)}）。中位数 ${money(c.price.median, cur)}，${c.onSalePct}% 的商品带划线价，中位折扣 ${c.medianDiscountPct ?? 0}%。</div>` : '<div class="empty">没取到商品目录（非 Shopify 或关闭了 products.json）</div>'}</div></div>
    <div class="card"><h2>上新节奏 ${T.m}<small>近 12 个月每月发布的商品数</small></h2><div class="body">${c ? barChart(c.publishedByMonth.map((m) => ({ label: m.month.slice(5), value: m.count, tip: `${m.month}：上新 ${m.count} 款` }))) + `<div class="muted" style="font-size:12px">近 90 天上新 ${c.newLast90d} 款，在售率 ${c.inStockPct}%，最早一款发布于 ${esc(c.oldestPublished || '未知')}。</div>` : '<div class="empty">没取到商品目录</div>'}</div></div>
    <div class="card"><h2>Sitemap 页面构成 ${T.m}<small>这是页面数量，不是流量占比</small></h2><div class="body">${sm ? hbars([{ label: '商品页', value: sm.counts.products }, { label: '集合页', value: sm.counts.collections }, { label: '博客文章', value: sm.counts.blogs }, { label: '单页', value: sm.counts.pages }, { label: '其他', value: sm.counts.other }]) + `<div class="muted" style="font-size:12px;margin-top:8px">共 ${int(sm.total)} 个 URL，${sm.subSitemaps} 个子 sitemap${sm.truncated ? '，只读了前 8 个' : ''}。</div>` : '<div class="empty">没取到 sitemap.xml</div>'}</div></div>
  </div>

  <div class="grid g2">
    <div class="card"><h2>畅销排序前 ${b ? b.items.length : 0} 款 ${b ? T.m : T.n}<small>来自店铺自己的畅销排序页</small></h2><div class="body" style="padding:0">${b ? `<table><tr><th>#</th><th>商品</th><th class="r">现价</th><th class="r">划线价</th><th>库存</th></tr>${b.items.map((i, n) => `<tr><td>${n + 1}</td><td><a href="https://${esc(d.domain)}/products/${encodeURIComponent(i.handle)}" target="_blank" rel="noopener noreferrer">${esc(i.title)}</a></td><td class="r">${money(i.price, cur)}</td><td class="r">${i.compareAt && i.compareAt > i.price ? money(i.compareAt, cur) : ''}</td><td>${i.available ? '有货' : '缺货'}</td></tr>`).join('')}</table>` : '<div class="empty">没取到畅销排序</div>'}</div></div>
    <div>
      <div class="card"><h2>评价 ${r ? T.m : T.n}</h2><div class="body">${r ? `<div class="row" style="gap:20px"><div><div style="font-size:26px;font-weight:700">${r.rating} ★</div><div class="muted">${int(r.count)} 条</div></div><div style="flex:1;min-width:180px">${r.distribution ? r.distribution.slice().reverse().map((x) => `<div class="row" style="gap:6px;font-size:12px"><span style="width:26px">${x.stars}★</span><div style="flex:1;background:var(--tint);border-radius:4px;height:8px"><div data-tip="${x.stars} 星：${int(x.count)} 条" style="height:8px;border-radius:4px;background:#664398;width:${(x.count / r.count) * 100}%"></div></div><span class="mono" style="width:50px;text-align:right">${int(x.count)}</span></div>`).join('') : ''}</div></div><div class="muted" style="font-size:12px;margin-top:8px">来源：${esc(r.source)}，${esc(r.scope)}。这是该页面公开显示的数字，不含评价原文和情感分析。</div>` : '<div class="muted">页面上没有找到公开的评价汇总数字。不编造评价内容。</div>'}</div></div>
      <div class="card"><h2>技术栈 ${s ? T.m : T.n}<small>首页源码指纹</small></h2><div class="body">${s ? `<div class="chips">${s.tech.map((x) => `<span class="chip"><b>${esc(x.category)}</b>${esc(x.name)}</span>`).join('') || '<span class="muted">没有识别到已知组件</span>'}</div><div class="muted" style="font-size:12px;margin-top:8px">首页 HTTP ${s.status}，响应 ${int(s.responseMs)} 毫秒${d.domainAge ? `；域名注册于 ${esc(d.domainAge.registeredAt)}（${d.domainAge.years} 年）` : ''}${d.shop && d.shop.shipsToCount ? `；可发 ${d.shop.shipsToCount} 个国家` : ''}。</div>` : '<div class="muted">首页没取到</div>'}</div></div>
      <div class="card"><h2>广告投放 <span class="tag n">未接入</span></h2><div class="body"><div class="muted">广告数量、存活周期、花费没有免费可靠的数据源，这里不估不编。${s && s.tech.some((x) => x.category === '广告像素') ? `能确认的只有：首页装了 ${esc(s.tech.filter((x) => x.category === '广告像素').map((x) => x.name).join('、'))}。` : ''}</div><div style="margin-top:8px"><a target="_blank" rel="noopener noreferrer" href="https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&q=${encodeURIComponent(d.domain)}">去 Meta 广告库手动查看 ${esc(d.domain)}</a></div></div></div>
    </div>
  </div>

  <div class="card"><h2>可观测信号分明细<small>只汇总从外部看得到的信号，不代表盈利能力</small></h2><div class="body" style="padding:0"><table><tr><th>信号</th><th>采集值</th><th class="r">得分</th><th class="r">权重</th><th class="r">贡献</th><th>打分规则</th></tr>
    ${sc.rows.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.raw)}</td><td class="r">${x.score === null ? '跳过' : x.score}</td><td class="r">${x.weightUsed ? x.weightUsed.toFixed(0) + '%' : ''}</td><td class="r">${x.score === null ? '' : '+' + x.contribution.toFixed(1)}</td><td class="muted">${esc(x.how)}</td></tr>`).join('')}
    <tr><td colspan="4"><b>合计</b>（没取到的信号跳过，其余权重按比例放大）</td><td class="r"><b>${sc.total ?? '无'}</b></td><td></td></tr></table></div></div>

  ${d.errors && d.errors.length ? `<div class="card"><h2>没取到的数据<small>对应模块已留空</small></h2><div class="body"><ul style="margin:0;padding-left:18px">${d.errors.map((x) => `<li>${esc(x.step)}：${esc(x.message)}</li>`).join('')}</ul></div></div>` : ''}`;
}
function pos(v, g) { const lo = Math.log(g.low / 2), hi = Math.log(g.high * 2); return ((Math.log(v) - lo) / (hi - lo)) * 100; }

function intro() {
  return `<div class="card"><h2>开始</h2><div class="body"><p style="margin-top:0">输入一个独立站域名，采集它的公开信号：Tranco 排名、Shopify 商品与价格、畅销排序、上新节奏、Sitemap、域名年限、评价数、技术栈。再基于这些实测值推算访问量、订单和 GMV 的区间。</p>
  <p>每个数字都带标签：${T.m} 直接读到的，${T.e} 由公式算出的，${T.a} 可调整的假设，${T.n} 留空不编。</p>
  <div class="row"><button data-act="sample">看示例（bigblanket.com 真实采集）</button>${workerUrl() ? '' : '<button class="ghost" data-act="settings">配置采集端</button>'}</div></div></div>`;
}

// ---------- compare view ----------
function renderCompare() {
  const rows = state.compare;
  const cell = (r, f) => (r.error ? '' : f(r.data, estimate(r.data, {}), signalScore(r.data)));
  const line = (label, tag, f) => `<tr><td>${label} ${tag}</td>${rows.map((r) => `<td class="r">${cell(r, f)}</td>`).join('')}</tr>`;
  return `<div class="card"><h2>多站对比<small>最多 5 个域名，逐个采集</small></h2><div class="body">
    <form id="cmpForm" class="row"><input id="cmpInput" style="flex:1;min-width:240px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;font:inherit" placeholder="用逗号或空格分隔，例如 bigblanket.com, monos.com" value="${esc(store.get('ss.cmp', ''))}"><button type="submit">开始对比</button><button type="button" class="ghost" data-act="cmpWatch">用关注列表</button></form>
    ${state.cmpStatus ? `<div class="muted" style="margin-top:8px">${esc(state.cmpStatus)}</div>` : ''}</div></div>
  ${rows.length ? `<div class="card"><div class="body" style="padding:0;overflow:auto"><table><tr><th>指标</th>${rows.map((r) => `<th class="r">${esc(r.domain)}</th>`).join('')}</tr>
    ${line('店铺名', T.m, (d) => esc((d.shop && d.shop.name) || ''))}
    ${line('店铺类型', T.e, (d, e) => esc(e.type.label))}
    ${line('Tranco 排名', T.m, (d) => (d.tranco ? (d.tranco.ranked ? '#' + int(d.tranco.latest.rank) : '不在榜单内') : '无'))}
    ${line('30 天排名变化', T.m, (d) => (d.tranco && d.tranco.ranked ? (d.tranco.improvementPct >= 0 ? '上升 ' : '下降 ') + Math.abs(d.tranco.improvementPct) + '%' : ''))}
    ${line('商品数', T.m, (d) => (d.catalog ? int(d.catalog.total) : '无'))}
    ${line('畅销款价格中位数', T.m, (d) => (d.bestsellers ? money(d.bestsellers.medianPrice, (d.shop && d.shop.currency) || 'USD') : '无'))}
    ${line('近 90 天上新', T.m, (d) => (d.catalog ? int(d.catalog.newLast90d) : '无'))}
    ${line('带划线价商品占比', T.m, (d) => (d.catalog && d.catalog.onSalePct !== null ? d.catalog.onSalePct + '%' : '无'))}
    ${line('评价', T.m, (d) => (d.reviews ? `${d.reviews.rating}★ / ${int(d.reviews.count)}` : '无'))}
    ${line('域名年限', T.m, (d) => (d.domainAge ? d.domainAge.years + ' 年' : '无'))}
    ${line('月访问量', T.e, (d, e) => (e.visits ? rangeText(e.visits, compact) : '无'))}
    ${line('月订单', T.e, (d, e) => (e.orders ? rangeText(e.orders, compact) : '无'))}
    ${line('月 GMV', T.e, (d, e) => (e.gmv ? rangeText(e.gmv, usd) : '无'))}
    ${line('信号分', T.e, (d, e, s) => (s.total === null ? '无' : s.total))}
    <tr><td>状态</td>${rows.map((r) => `<td class="r muted">${r.error ? esc(r.error) : r.data.errors.length ? r.data.errors.length + ' 项没取到' : '完整'}</td>`).join('')}</tr></table></div></div>` : ''}`;
}
async function runCompare(domains) {
  state.compare = [];
  for (let i = 0; i < domains.length; i++) {
    state.cmpStatus = `正在采集 ${domains[i]}（${i + 1} / ${domains.length}）…`; render();
    try { const data = await fetchAnalysis(domains[i]); snapshot(data); state.compare.push({ domain: domains[i], data }); }
    catch (err) { state.compare.push({ domain: domains[i], error: err.message }); }
    if (i < domains.length - 1) await new Promise((r) => setTimeout(r, 1200)); // Tranco allows about one query per second
  }
  state.cmpStatus = ''; render();
}

// ---------- watchlist view ----------
function renderWatch() {
  const list = store.get('ss.watch', []);
  if (!list.length) return `<div class="card"><h2>关注列表</h2><div class="body"><div class="empty">还没有关注的店铺。分析一个域名后点“加入关注”。<br>关注列表和历史快照保存在这台电脑的浏览器里。</div></div></div>`;
  return `<div class="card"><h2>关注列表<small>每次分析自动存一条当日快照，用来看趋势</small></h2><div class="body" style="padding:0;overflow:auto"><table><tr><th>店铺</th><th class="r">快照数</th><th class="r">Tranco 排名</th><th class="r">商品数</th><th class="r">评价数</th><th class="r">畅销中位价</th><th class="r">GMV 中值 ${T.e}</th><th class="r">信号分</th><th>最近采集</th><th></th></tr>
    ${list.map((dm) => { const h = store.get('ss.hist.' + dm, []); const a = h[h.length - 1], p = h.length > 1 ? h[0] : null;
      const delta = (k, lowerBetter) => { if (!a || !p || a[k] === null || p[k] === null || a[k] === p[k]) return ''; const up = a[k] > p[k]; return ` <span class="muted" data-tip="首条快照 ${esc(p.t.slice(0, 10))}：${int(p[k])}">${up ? '↑' : '↓'}${lowerBetter ? (up ? '变差' : '变好') : ''}</span>`; };
      return `<tr><td><a href="#" data-open="${esc(dm)}">${esc((a && a.name) || dm)}</a><div class="muted" style="font-size:12px">${esc(dm)}</div></td><td class="r">${h.length}</td><td class="r">${a && a.rank ? '#' + int(a.rank) + delta('rank', true) : '无'}</td><td class="r">${a ? int(a.products) + delta('products') : '无'}</td><td class="r">${a ? int(a.reviews) + delta('reviews') : '无'}</td><td class="r">${a && a.bestPrice ? a.bestPrice : '无'}</td><td class="r">${a && a.gmvMid ? usd(a.gmvMid) : '无'}</td><td class="r">${a && a.score !== null ? a.score : '无'}</td><td>${a ? esc(a.t.slice(0, 10)) : '从未'}</td><td><button class="ghost" data-unwatch="${esc(dm)}">移除</button></td></tr>`; }).join('')}
    </table></div></div>
    <div class="row"><button data-act="refreshAll">全部重新采集</button><button class="ghost" data-act="exportHist">导出全部历史</button></div>`;
}

// ---------- method view ----------
function renderMethod() {
  return `<div class="card"><h2>数据从哪来</h2><div class="body" style="padding:0"><table><tr><th>信号</th><th>来源</th><th>性质</th></tr>
    <tr><td>全球排名和 30 天走势</td><td>Tranco 公开 API</td><td>${T.m}</td></tr>
    <tr><td>店铺名、国家、货币、商品数</td><td>Shopify /meta.json</td><td>${T.m}</td></tr>
    <tr><td>商品、价格、划线价、库存、发布时间</td><td>Shopify /products.json</td><td>${T.m}</td></tr>
    <tr><td>畅销排序</td><td>/collections/all?sort_by=best-selling 页面里商品出现的顺序</td><td>${T.m} 启发式，主题不同可能有偏差</td></tr>
    <tr><td>页面构成</td><td>/sitemap.xml</td><td>${T.m}</td></tr>
    <tr><td>域名注册日期</td><td>RDAP 注册局</td><td>${T.m}</td></tr>
    <tr><td>评价数和星级</td><td>畅销第一商品页上的评价挂件或结构化数据</td><td>${T.m} 是该页面的数，不一定是全站</td></tr>
    <tr><td>技术栈</td><td>首页源码里的脚本域名指纹</td><td>${T.m}</td></tr>
    <tr><td>店铺类型</td><td>四个可测特征：带划线价商品 ≥ 60%、中位折扣 ≥ 30%、商品数 ≤ 50、域名 &lt; 5 年。命中 3 个以上判为投流型；否则域名 ≥ 8 年或划线价商品 &lt; 40% 判为品牌型；其余为混合型</td><td>${T.e}</td></tr>
    <tr><td>月访问量</td><td>C ÷ Tranco 排名，C 按类型分开拟合。品牌型 C = ${(FIT.brand.constant / 1e8).toFixed(0)} 亿（${FIT.brand.n} 个锚点，误差 ${FIT.brand.factor.toFixed(1)} 倍）；投流型 C = ${(FIT.ad.constant / 1e8).toFixed(0)} 亿（${FIT.ad.n} 个锚点，误差 ${FIT.ad.factor.toFixed(1)} 倍）；混合型取两者几何平均，区间覆盖两条线</td><td>${T.e}</td></tr>
    <tr><td>投流型转化率</td><td>已知投流型店铺的订单 ÷ 访问量中位数，目前 ${AD_PRIORS.cvrPct ? AD_PRIORS.cvrPct.toFixed(2) + '%' : '无'}（${AD_PRIORS.cvrN} 个样本），误差 ${MODEL.adCvrFactor} 倍</td><td>${T.a}</td></tr>
    <tr><td>转化率</td><td>${MODEL.cvrBasePct}% × (${MODEL.cvrRefAov} ÷ 客单价)^${MODEL.cvrElasticity}，限制在 ${MODEL.cvrMinPct}% 到 ${MODEL.cvrMaxPct}%，误差 ${MODEL.cvrFactor} 倍</td><td>${T.a}</td></tr>
    <tr><td>客单价</td><td>畅销款价格中位数 × 连带系数 ${MODEL.basketDefault}</td><td>${T.m} × ${T.a}</td></tr>
    <tr><td>GMV 区间</td><td>三项相乘；区间在对数空间合成，不是把三个上限直接相乘</td><td>${T.e}</td></tr></table></div></div>
  <div class="card"><h2>访问量换算用的锚点<small>目前是第三方工具的估算，不是真实后台数据</small></h2><div class="body" style="padding:0"><table><tr><th>站点</th><th>类型</th><th class="r">Tranco 排名</th><th class="r">已知月访问</th><th class="r">模型算出</th><th class="r">模型 ÷ 已知</th><th class="r">已知月单</th><th>出处</th><th>状态</th></tr>
    ${CALIBRATION.map((a) => { const b = backtest().find((x) => x.domain === a.domain); return `<tr><td>${esc(a.domain)}</td><td>${a.cls === 'ad' ? '投流型' : '品牌型'}</td><td class="r">${a.rank ? '#' + int(a.rank) : '无排名'}</td><td class="r">${a.visits ? int(a.visits) : ''}</td><td class="r">${b ? int(b.model) : ''}</td><td class="r">${b ? b.ratio.toFixed(2) + ' 倍' : ''}</td><td class="r">${a.orders ? int(a.orders) : ''}</td><td class="muted">${esc(a.source)}</td><td>${a.confirmed ? '已确认' : '待确认'}</td></tr>`; }).join('')}</table></div></div>
  <div class="note"><b>怎么让它更准：</b>在 site/model.js 的 CALIBRATION 里增加你知道真实数据的站点（域名、类型、排名、月访问或月单量），两条线的 C、误差倍数和上面这张回测表都会自动重算。上表是样本内回测，偏乐观；投流型目前只有 2 个带排名的锚点，结论很弱。锚点越多、越接近你要分析的店铺体量，区间越窄。</div>
  <div class="note warn"><b>做不到的事：</b>不在 Tranco 榜单内的小站只能给访问量上限；广告数量和花费、流量来源占比、关键词排名、评价原文情感，这些没有免费可靠来源，本工具不展示。</div>`;
}

// ---------- shell ----------
function render() {
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.dataset.view === state.view));
  app.innerHTML = state.view === 'analyze' ? renderAnalysis() : state.view === 'compare' ? renderCompare() : state.view === 'watch' ? renderWatch() : renderMethod();
}
async function analyze(domain, fresh) {
  const dm = cleanDomain(domain);
  if (!dm) return;
  Object.assign(state, { view: 'analyze', loading: dm, error: null, overrides: {}, isSample: false }); render();
  try { state.data = await fetchAnalysis(dm, fresh); snapshot(state.data); } catch (err) { state.error = err.message; state.data = null; }
  state.loading = null; render();
}
async function loadSample() {
  Object.assign(state, { view: 'analyze', loading: '示例', error: null, overrides: {} }); render();
  try { state.data = await (await fetch('sample.json')).json(); state.isSample = true; } catch { state.error = '示例文件加载失败'; }
  state.loading = null; render();
}
function download(name, obj) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
function openSettings() { $('#workerUrl').value = workerUrl(); $('#dlg').showModal(); }

$('#form').addEventListener('submit', (ev) => { ev.preventDefault(); analyze($('#domain').value); });
$('#btnSample').addEventListener('click', loadSample);
$('#btnSettings').addEventListener('click', openSettings);
$('#dlgCancel').addEventListener('click', () => $('#dlg').close());
$('#dlgSave').addEventListener('click', () => { const v = $('#workerUrl').value.trim(); if (v && !/^https:\/\//.test(v)) { $('#workerUrl').focus(); return; } store.set('ss.worker', v); $('#dlg').close(); render(); });
document.querySelector('nav').addEventListener('click', (ev) => { const a = ev.target.closest('a[data-view]'); if (a) { state.view = a.dataset.view; render(); } });
app.addEventListener('submit', (ev) => {
  if (ev.target.id !== 'cmpForm') return; ev.preventDefault();
  const raw = $('#cmpInput').value; store.set('ss.cmp', raw);
  const list = [...new Set(raw.split(/[\s,，;]+/).map(cleanDomain).filter(Boolean))].slice(0, 5);
  if (list.length) runCompare(list);
});
app.addEventListener('change', (ev) => {
  const k = ev.target.dataset && ev.target.dataset.ov; if (!k) return;
  const v = parseFloat(ev.target.value); state.overrides[k] = isFinite(v) && v > 0 ? v : null;
  // Re-rendering replaces the inputs, so put the cursor back where the user tabbed or clicked to.
  setTimeout(() => { const next = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.ov : null; render(); if (next) { const el = app.querySelector(`[data-ov="${next}"]`); if (el) el.focus(); } }, 0);
});
app.addEventListener('click', async (ev) => {
  const open = ev.target.closest('[data-open]'); if (open) { ev.preventDefault(); $('#domain').value = open.dataset.open; analyze(open.dataset.open); return; }
  const un = ev.target.closest('[data-unwatch]'); if (un) { store.set('ss.watch', store.get('ss.watch', []).filter((x) => x !== un.dataset.unwatch)); render(); return; }
  const act = ev.target.closest('[data-act]'); if (!act) return;
  const a = act.dataset.act, d = state.data;
  if (a === 'sample') loadSample();
  else if (a === 'settings') openSettings();
  else if (a === 'refresh' && d) analyze(d.domain, true);
  else if (a === 'export' && d) download(`storesignal_${d.domain}_${d.collectedAt.slice(0, 10)}.json`, { measured: d, estimated: estimate(d, state.overrides), score: signalScore(d), model: MODEL });
  else if (a === 'watch' && d) { const w = store.get('ss.watch', []); if (!w.includes(d.domain)) { w.push(d.domain); store.set('ss.watch', w); if (state.isSample) snapshot(d); } render(); }
  else if (a === 'cmpWatch') { const w = store.get('ss.watch', []).slice(0, 5); if (w.length) { store.set('ss.cmp', w.join(', ')); runCompare(w); } else { state.cmpStatus = '关注列表是空的'; render(); } }
  else if (a === 'refreshAll') { const w = store.get('ss.watch', []); state.view = 'compare'; runCompare(w.slice(0, 5)); }
  else if (a === 'exportHist') { const out = {}; for (const dm of store.get('ss.watch', [])) out[dm] = store.get('ss.hist.' + dm, []); download('storesignal_history.json', out); }
});

const q = new URLSearchParams(location.search).get('domain');
if (q) { $('#domain').value = cleanDomain(q); analyze(q); } else render();
