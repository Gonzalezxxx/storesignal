# StoreSignal 独立站信号分析

输入一个独立站域名，采集它的公开信号，并在实测值之上给出访问量、订单、GMV 的推算区间。

原则只有一条：**读得到的才显示，读不到的留空，推算的写明公式和误差。** 页面上每个数字都带标签：实测、推算、假设、未取到。

## 结构

```
site/      GitHub Pages 前端（纯静态，无需构建）
  index.html  app.js  model.js  config.js  sample.json
worker/    Cloudflare Worker 采集端
  src/collect.js   采集与解析，只返回实测值
  src/index.js     HTTP 接口、CORS、6 小时缓存
test/      离线测试（node test/run.mjs）
.github/workflows/  两个自动部署流程
```

## 采集的实测信号

| 信号 | 来源 |
| --- | --- |
| 全球排名与 30 天走势 | Tranco 公开 API |
| 店铺名、国家、货币、商品数 | Shopify `/meta.json` |
| 商品、价格、划线价、库存、发布时间 | Shopify `/products.json` |
| 畅销排序 | `/collections/all?sort_by=best-selling` 页面中商品出现顺序 |
| 页面构成 | `/sitemap.xml` |
| 域名注册日期 | RDAP |
| 评价数与星级 | 畅销第一商品页的评价挂件或结构化数据 |
| 技术栈 | 首页源码指纹 |

## 推算模型（site/model.js）

1. 月访问量 = C ÷ Tranco 排名。C 由 `ANCHORS` 里的锚点站拟合，误差按至少 2 倍计。
2. 转化率 = 1.4% × (60 ÷ 客单价)^0.3，限制在 0.5% 到 2.5%，误差 1.8 倍。
3. 客单价 = 畅销款价格中位数 × 连带系数 1.1。
4. GMV = 三者相乘，区间在对数空间合成。

未进入 Tranco 前 100 万的站点只给访问量上限，不给区间。

**提高准确度的办法**：把 `ANCHORS` 换成你知道真实访问量的站点。锚点越多、体量越接近目标店铺，区间越窄。页面上的三个输入框也可以直接填入已知的访问量、转化率、连带系数。

## 没有做的事

广告数量与花费、流量来源占比、关键词排名、评价原文情感分析。这些没有免费可靠的数据源，本工具不展示，也不用模板或随机数填充。

## 部署

### 一、推到 GitHub 并开启 Pages

1. 新建仓库，把本目录全部内容推到 `main` 分支。
2. 仓库 Settings → Pages → Build and deployment → Source 选 **GitHub Actions**。
3. 等 `Deploy site to GitHub Pages` 流程跑完，页面地址是 `https://你的用户名.github.io/仓库名/`。

此时点“看示例”已经可用（内置一份 bigblanket.com 的真实采集结果）。

### 二、部署采集端到 Cloudflare

1. 注册免费的 Cloudflare 账号。
2. 在 Cloudflare 后台 My Profile → API Tokens 用模板 **Edit Cloudflare Workers** 建一个 token；在 Workers 页面右侧复制 Account ID。
3. 在 GitHub 仓库 Settings → Secrets and variables → Actions 添加两个 secret：`CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。
4. 把 `worker/wrangler.toml` 里的 `ALLOWED_ORIGIN` 改成你的 Pages 源，例如 `https://你的用户名.github.io`，推送。
5. `Deploy collector to Cloudflare Workers` 流程跑完后，在 Cloudflare 后台能看到 Worker 地址，形如 `https://storesignal.xxx.workers.dev`。

也可以不用 GitHub Actions，在本机执行 `cd worker && npm i && npx wrangler deploy`。

### 三、把两边接起来

把 Worker 地址写进 `site/config.js` 的 `workerUrl` 并推送（所有访问者生效），或者在页面右上角“设置”里填（只对当前浏览器生效）。

## 使用边界

1. 采集端只读公开页面，带缓存，每个域名 6 小时内只采一次，请保持低频。
2. Tranco API 限速约每秒 1 次，对比功能已自动间隔 1.2 秒。
3. 关注列表与历史快照保存在浏览器本地，换电脑不会同步，可用“导出全部历史”备份。
4. 非 Shopify 站点只能拿到排名、首页指纹、Sitemap、域名年限，商品与 GMV 模块会留空。
5. 畅销排序解析是启发式的，个别主题会把推荐位排在前面。

## 测试

```
node test/run.mjs
```
