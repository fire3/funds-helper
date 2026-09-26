# 信源 fixture

真实响应快照，供 `packages/sources/src/feeds/rss.test.ts` 离线解析。
每个文件头部都注明**采集日期**与**原始 URL**；上游改版时用同一 URL 重采、diff 后更新解析逻辑
（architecture.md §10.2 —— 把「别人的 RSS」变成「可检测资产」的唯一办法）。

| 文件 | 原始 URL | 格式 | 条目数 | 字节 |
|---|---|---|---:|---:|
| `ft-home.xml` | https://www.ft.com/rss/home | RSS 2.0 | 11 | 8690 |
| `ft-markets.xml` | https://www.ft.com/rss/markets | RSS 2.0 | 25 | 12033 |
| `cnbc-markets.xml` | https://www.cnbc.com/id/100003114/device/rss/rss.html | RSS 2.0 | 30 | 20817 |
| `yahoo-finance.xml` | https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC&region=US&lang=en-US | RSS 2.0（首次请求 429，退避后重采） | 19 | 13446 |
| `nikkei-asia.xml` | https://asia.nikkei.com/rss/feed/nar | RSS 1.0 / RDF（无 pubDate） | 50 | 25663 |
| `scmp.xml` | https://www.scmp.com/rss/91/feed | RSS 2.0 | 50 | 83531 |
| `economist-finance.xml` | https://www.economist.com/finance-and-economics/rss.xml | RSS 2.0（CDATA 标题/摘要） | 300 | 150559 |
| `project-syndicate.xml` | https://www.project-syndicate.org/rss | RSS 2.0 | 20 | 33352 |
| `foreign-affairs.xml` | https://www.foreignaffairs.com/rss.xml | RSS 2.0 | 20 | 8937 |
| `ecb-press.xml` | https://www.ecb.europa.eu/rss/press.html | RSS 2.0 | 15 | 5688 |
| `boe-news.xml` | https://www.bankofengland.co.uk/rss/news | RSS 2.0（无 XML 声明） | 50 | 25494 |
| `fed-press.xml` | https://www.federalreserve.gov/feeds/press_all.xml | RSS 2.0（带 BOM + CDATA） | 20 | 14318 |
| `sec-press.xml` | https://www.sec.gov/news/pressreleases.rss | RSS 2.0 | 25 | 18377 |
| `gnews-reuters.xml` | https://news.google.com/rss/search?q=site%3Areuters.com%20business%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen | RSS 2.0（聚合器，discovery） | 100 | 133731 |
| `gnews-finance.xml` | https://news.google.com/rss/search?q=financial%20news%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen | RSS 2.0（聚合器，discovery） | 100 | 115220 |

## 合成样例（没有对应的真实信源，或真实信源在本机被拒）

| 文件 | 说明 |
|---|---|
| `atom-entry.xml` | 按 RFC 4287 构造的 Atom 样例（首版 15 个信源都是 RSS/RDF，但解析器必须支持 Atom —— 换信源时不能重新设计） |
| `html-challenge.html` | WAF/错误页样例：HTTP 200 但返回 HTML，必须抛 `ParseError`（调研文档 §1.2「200 不等于可用」） |

采集环境说明：`global-financial-news-sources.md` 的调研日是 2026-09-25，本次采集 2026-09-26，
Yahoo Finance 首次请求返回 429，退避后重采成功 —— 这正是 `news_source.consec_failures`
与退避拉长 `next_fetch_at` 要解决的问题。
