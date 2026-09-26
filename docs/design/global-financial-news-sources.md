# 全球英文财经信源可访问性调研

> 调研问题：**智能体或程序能否直接获取全球英文财经要闻？**
>
> 调研方式：未登录状态下的 `GET` 请求；先直连，超时后按约定改用
> `socks5h://localhost:10808` 复测；对 XML/JSON 响应做可解析性和发布时间检查。
> 调研日期：**2026-09-25**。
>
> 本文只验证公开入口的可访问性，不绕过登录、付费墙、验证码或站点挑战。

---

## 0. 结论摘要

结论不是“所有信源都能直接抓”，而是分成三类：

| 类别 | 信源 | 程序接入结论 |
|---|---|---|
| **A. 可直接接入** | FT、The Economist、CNBC、Nikkei Asia、SCMP、Project Syndicate、Foreign Affairs、ECB、Bank of England、Federal Reserve、SEC | 无需 API key，RSS/XML 可直接解析；适合做主干订阅 |
| **B. 有条件接入** | Reuters Connect、AP News API、FRED、WTO Timeseries、NewsAPI、GDELT、Bloomberg | 需要 API key、订阅、授权或严格限流；不应依赖公开网页抓取 |
| **C. 当前环境受限** | Reuters 公开页面/RSS、AP 公开 RSS、Bloomberg 猜测的 RSS、IMF、OECD 新闻 RSS、Caixin RSS、WTO 旧 RSS、CFR 旧 RSS、World Bank 博客 RSS | 返回 401/403/404、WAF challenge 或最终跳到错误页；需要替代入口或授权 |

**最适合先落地的组合**：

1. 用 FT / Economist / CNBC / Nikkei / SCMP 的 RSS 做英文财经要闻主干；
2. 用 ECB / BoE / Fed / SEC RSS 做政策与监管原始信息；
3. 用 Google News RSS 做 Reuters、AP 等受限源的**发现和去重线索**，但不把它当原文全文源；
4. 用 World Bank API、OECD SDMX、SEC JSON 补充结构化数据；
5. 需要 Reuters / AP / Bloomberg 全文或稳定 API 时，走官方授权服务。

---

## 1. 测试环境与判定方法

### 1.1 网络路径

- 直连时多个站点出现超时；
- `http://localhost:10809` 代理测试超时；
- `socks5h://localhost:10808` 可用，因此超时项统一用该代理复测；
- 结果是**本测试环境、本 IP、该时间点**的结果，地区、WAF 和限流策略可能变化。

### 1.2 判定标准

只把满足以下条件的入口记为“可直接接入”：

1. 最终 HTTP 状态为 `200`；
2. `Content-Type` 是 XML、RSS 或 JSON；
3. 能解析出条目，且发布时间不是明显陈旧；
4. 最终有效 URL 不是错误页。

特别注意：**HTTP 200 不等于可用**。WTO 旧 RSS 最终跳到 `/error/error_404.htm`，虽然
状态码是 200，但内容是 HTML 错误页，因此判定为不可用。

### 1.3 复现命令

```bash
# 直连
curl -L --max-time 20 -A 'Mozilla/5.0 funds-helper-research/1.0' "$URL"

# 超时后走 SOCKS5 代理
curl -L --max-time 25 \
  --proxy socks5h://localhost:10808 \
  -A 'Mozilla/5.0 funds-helper-research/1.0' "$URL"

# 检查 RSS 条目数和第一条时间
xmllint --xpath \
  'concat("items=", count(//item), " first=", normalize-space((//item)[1]/title), " date=", normalize-space((//item)[1]/pubDate))' \
  feed.xml
```

---

## 2. 逐项实测结果

### 2.1 可直接解析的媒体 RSS

| 信源 | 实测入口 | 状态 | 返回内容 | 新鲜度/备注 |
|---|---|---:|---|---|
| **FT** | `https://www.ft.com/rss/home` | 200 | RSS，9 条 | 最新条目为 2026-09-25 |
| **FT Markets** | `https://www.ft.com/rss/markets` | 200 | RSS，25 条 | 最新条目为 2026-09-25 |
| **The Economist Finance** | `https://www.economist.com/finance-and-economics/rss.xml` | 200 | RSS，300 条 | 最新条目为 2026-09-24 |
| **The Economist World** | `https://www.economist.com/the-world-this-week/rss.xml` | 200 | RSS，300 条 | 最新条目为 2026-09-24 |
| **CNBC Markets** | `https://www.cnbc.com/id/100003114/device/rss/rss.html` | 200 | RSS，30 条 | 最新条目为 2026-09-25 09:03 GMT |
| **Nikkei Asia** | `https://asia.nikkei.com/rss/feed/nar` | 200 | RSS 1.0 / RDF，50 条 | feed 内没有 `pubDate`，标题和链接可用，发布时间需再抓文章页 |
| **SCMP** | `https://www.scmp.com/rss/91/feed` | 200 | RSS，50 条 | 最新条目为 2026-09-25 09:31 GMT |
| **Project Syndicate** | `https://www.project-syndicate.org/rss` | 200 | RSS，20 条 | 最新条目为 2026-09-24 |
| **Foreign Affairs** | `https://www.foreignaffairs.com/rss.xml` | 200 | RSS，20 条 | 最新条目为 2026-09-25 |

这些入口适合做**定时轮询 + XML 解析 + 按 canonical URL 去重**。RSS 通常只提供标题、摘要和原文链接，
不保证全文可抓取；有付费墙时应保留原文链接并明确标记全文状态。

### 2.2 可直接解析的政策、监管和机构 RSS

| 信源 | 实测入口 | 状态 | 返回内容 | 新鲜度 |
|---|---|---:|---|---|
| **ECB Press** | `https://www.ecb.europa.eu/rss/press.html` | 200 | RSS，15 条 | 最新条目为 2026-09-24 |
| **Bank of England News** | `https://www.bankofengland.co.uk/rss/news` | 200 | RSS，50 条 | 最新条目为 2026-09-25 |
| **Federal Reserve Press** | `https://www.federalreserve.gov/feeds/press_all.xml` | 200 | RSS，20 条 | 最新条目为 2026-09-24 |
| **SEC Press Releases** | `https://www.sec.gov/news/pressreleases.rss` | 200 | RSS，25 条 | 最新条目为 2026-09-23 |

这些源的价值在于**原始公告和政策事实**，比二手财经报道更适合做事实核验。

### 2.3 可直接访问的结构化数据接口

| 信源 | 实测入口 | 状态 | 返回内容 | 备注 |
|---|---|---:|---|---|
| **World Bank API** | `https://api.worldbank.org/v2/country/all/indicator/NY.GDP.MKTP.KD.ZG?format=json&date=2024:2026&per_page=2` | 200 | JSON，560 字节 | `lastupdated=2026-07-13`；适合宏观指标 |
| **OECD SDMX** | `https://sdmx.oecd.org/public/rest/dataflow/OECD.SDD.NAD` | 200 | SDMX XML，约 1.2 MB | 官方结构化数据；先拿 dataflow，再按数据集查询 |
| **SEC submissions** | `https://data.sec.gov/submissions/CIK0000320193.json` | 200 | JSON，约 164 KB | 直连可用；适合公司公告、 filings 元数据 |

World Bank 和 OECD 的数据接口可直接给智能体提供**结构化事实**；新闻 RSS 与宏观 API 应分开存储，
不要把新闻摘要当成统计数据。

### 2.4 聚合入口（适合发现，不适合替代原文）

| 信源 | 实测入口 | 状态 | 返回内容 | 用途 |
|---|---|---:|---|---|
| **Google News RSS** | `https://news.google.com/rss/search?q=site%3Areuters.com%20business%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen` | 200 | RSS，100 条 | 可发现 Reuters 等受限源的新标题；需要再解析重定向和原始链接 |
| **Google News RSS（泛财经）** | `https://news.google.com/rss/search?q=financial%20news%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen` | 200 | RSS，100 条 | 适合做候选池和告警，不适合做唯一事实源 |
| **Yahoo Finance RSS** | `https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC&region=US&lang=en-US` | 200 | RSS，20 条 | 最新条目为 2026-09-25；偏市场快讯 |
| **GDELT Doc API** | `https://api.gdeltproject.org/api/v2/doc/doc?query=financial%20news&mode=artlist&format=json&maxrecords=5` | 429 | 限流提示 | 要求至少 5 秒一次；不能高频轮询 |

Google News 的条目通常是**标题、来源、时间和跳转链接**，不等于原文全文；应把它作为发现层，
再用 Reuters / AP / FT 等原始页面或授权 API 完成核验。

### 2.5 需要 API key、订阅或授权的入口

| 信源 | 实测入口 | 状态 | 结论 |
|---|---|---:|---|
| **AP News API** | `https://api.ap.org/v2/content?language=eng&limit=1` | 401 | 返回 `apikey is invalid or unauthorized`；需要申请 AP API key |
| **NewsAPI** | `https://newsapi.org/v2/top-headlines?category=business&language=en&pageSize=5` | 401 | 返回 `apiKeyMissing`；需要 `apiKey` 参数或请求头 |
| **FRED API** | `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&file_type=json` | 400 | 返回缺少 `api_key`；接口可用但必须先申请 key |
| **WTO Timeseries API** | `https://api.wto.org/timeseries/v1/data?i=ITS_CS_X_TOT&format=json` | 401 | 返回缺少 `subscription key` |
| **Reuters Connect** | `https://www.reutersconnect.com/` | 200 | 落地页可访问；内容 API 属于授权服务，本次未发现无需凭证的公开内容接口 |
| **Bloomberg** | 猜测的 `/feeds/bbiz/news.rss`、`/feeds/bbiz/markets.rss`、`/feeds/bbiz/sitemap.xml` | 404 | 没有可用的通用公开 RSS；网页 `/markets` 实测 403，应走订阅或授权服务 |
| **WSJ Markets RSS** | `https://feeds.a.dj.com/rss/RSSMarketsMain.xml` | 200 但过期 | 可解析 20 条，但 `lastBuildDate` 和条目停留在 2025-01，不作为当前要闻源 |

这些源不是“程序完全不能访问”，而是**不能依赖匿名公开接口**。如果产品需要稳定的 Reuters、AP 或
Bloomberg 全文数据，应单独评估 API 配额、商业授权、转载范围和成本。

### 2.6 当前环境不可用或入口已失效

| 信源 | 实测入口 | 状态/返回 | 结论 |
|---|---|---:|---|
| **Reuters 公开页面/RSS** | `/business/`、`/markets/`、`/rss/home/international`、`/rssFeed/businessNews` 等 | 401 或超时 | WAF/站点策略拦截，无法作为匿名 RSS 源 |
| **Reuters Arc feeds** | `/arc/outboundfeeds/rss/category/{business,markets,world}/` | 404 | 旧 Arc feed 路径已失效 |
| **AP 公开 RSS** | `https://apnews.com/hub/business?output=rss`、`https://apnews.com/index.rss` | 403 Cloudflare challenge | 不能绕过 challenge；改用 AP API |
| **IMF 新闻/数据 API** | `/en/News/Rss?language=eng`、`/external/datamapper/api/v1/NGDP_RPCH` | 403 Access Denied | 本环境被 Akamai 拦截，不代表全球不可用，但当前不可直接接入 |
| **OECD 新闻 RSS** | `https://www.oecd.org/rss/news.xml` | 403 Cloudflare challenge | 新闻 feed 不稳定；OECD SDMX 数据接口可用 |
| **Caixin Global RSS** | `https://www.caixinglobal.com/rss/` | 403 | 公开 RSS 被拒；页面暴露的 gateway feed 实测 406 |
| **CFR 旧 RSS** | `https://www.cfr.org/rss.xml` | 404 | 旧路径失效；首页可访问但未发现公开 feed |
| **World Bank 博客 RSS** | `https://blogs.worldbank.org/en/feed` | 404 | 博客 feed 路径失效；World Bank 官方数据 API 可用 |
| **WTO 旧 RSS** | `https://www.wto.org/library/rss/news_e.xml` | 最终 200 但落到 `/error/error_404.htm` | 错误页，不可当 XML |
| **Morningstar 试验入口** | `/rss/news`、`/feed` | 202 且响应体为空 | 本次没有拿到可解析内容，不纳入主干 |

**不要把 403/404 HTML 当成 RSS。** 抓取层必须同时检查状态码、最终 URL、`Content-Type` 和 XML
解析结果，并在失败时进入降级链路。

---

## 3. 推荐的智能体接入方案

### 3.1 分层数据管线

```text
发现层
  Google News RSS / Yahoo Finance RSS / GDELT（低频）
       ↓
原文层
  FT / Economist / CNBC / Nikkei / SCMP / Foreign Affairs / Project Syndicate
       ↓
事实核验层
  ECB / BoE / Fed / SEC 原始公告
       ↓
结构化数据层
  World Bank API / OECD SDMX / SEC submissions JSON
       ↓
授权层（按需）
  Reuters Connect / AP API / Bloomberg / FRED / WTO API
```

### 3.2 推荐轮询策略

- **媒体 RSS**：10–30 分钟一次；先做 HTTP 条件请求或 ETag，失败再全量下载；
- **政策与监管 RSS**：30–60 分钟一次；公告不需要秒级实时；
- **Google News RSS**：30–60 分钟一次，只做候选发现，不高频重试；
- **GDELT**：严格遵守至少 5 秒一次的限流；
- **结构化 API**：按数据更新频率缓存，宏观日频数据每天 1–4 次足够；
- **403/429**：退避后换代理或降级到聚合入口，不并发重试放大压力。

### 3.3 解析与存储护栏

每条记录至少保存：

```text
source_name
source_url
canonical_url
title
published_at
fetched_at
content_type
http_status
feed_version
full_text_status
error_code
```

解析时需要支持：

- RSS 2.0 的 `<item>`、`<pubDate>`；
- RSS 1.0 / RDF 的 `<item rdf:about>`（Nikkei 使用这种格式）；
- Atom 的 `<entry>`、`<updated>`；
- XML 命名空间和 CDATA；
- `pubDate` 缺失时标记为 `unknown`，不要伪造时间。

### 3.4 去重与引用规则

1. 优先按 canonical URL 去重；
2. URL 不稳定时用“来源 + 标题规范化 + 发布日期”去重；
3. 聚合器条目必须保留其跳转目标；
4. 引用时记录原始来源、抓取时间和是否为摘要；
5. 付费墙或 challenge 状态单独标记，不把摘要冒充全文。

---

## 4. 对“智能体能否访问”的直接回答

### 可以直接访问

智能体可以稳定读取以下内容的**标题和链接**；多数 feed 还提供摘要或发布时间：

- FT、The Economist、CNBC、Nikkei Asia、SCMP；
- Project Syndicate、Foreign Affairs；
- ECB、Bank of England、Federal Reserve、SEC；
- World Bank API、OECD SDMX、SEC submissions JSON；
- Google News RSS、Yahoo Finance RSS。

### 需要申请凭证或授权

Reuters、AP、Bloomberg、FRED、WTO 以及 NewsAPI 等源，程序原则上可以接入，
但通常需要 API key、订阅、商业授权或明确的请求配额。匿名抓取公开网页不能替代授权接口。

### 当前不能直接接入

本次测试环境下，Reuters 公开 RSS、AP 公开 RSS、IMF 新闻/数据入口、OECD 新闻 RSS、
Caixin RSS、WTO 旧 RSS、CFR 旧 RSS、World Bank 博客 RSS 等无法得到可解析的原始内容。
它们需要等待站点入口变化、申请授权，或改用官方数据 API / 聚合发现层。

---

## 5. 建议的最小可用配置

如果先做一版“全球英文财经要闻”智能体，建议只启用以下稳定入口：

| 用途 | 首选 | 备选 |
|---|---|---|
| 全球财经要闻 | FT home + FT markets | Economist finance + CNBC markets |
| 亚洲财经 | Nikkei Asia + SCMP | Google News site filter |
| 宏观与政策 | ECB + BoE + Fed | OECD SDMX + World Bank API |
| 监管与公司公告 | SEC press RSS + SEC submissions JSON | 公司官网公告 |
| 受限商业媒体发现 | Google News `site:reuters.com` / `site:ft.com` | 官方授权 API |

首版不需要抓取所有来源，也不应把聚合器当唯一事实源。先让 A 类源稳定运行，
再根据实际缺失的地域、行业和全文需求增加授权源。

---

## 6. 已知限制与后续验证

- 本结果只覆盖 **2026-09-25** 的一次探测，站点入口和 WAF 策略会变化；
- 代理结果与直连结果可能不同，生产环境应记录每次实际使用的网络路径；
- RSS 条目数不等于“全部新闻”，不同站点的保留窗口不同；
- WSJ Markets feed 虽返回 200，但实测 `lastBuildDate` 和条目均停留在 2025-01，
  本次不把它列为当前要闻源；
- 公开 feed 可能只给摘要，不能据此推断全文可抓；
- 付费墙、登录和验证码内容不在本文测试范围内，也不应通过绕过方式获取；
- 后续接入时应增加周期性健康检查，监控 `403/404/429`、内容类型变化和发布时间倒退。
