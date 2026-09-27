# 国际市场主流指数行情数据源调研

> 目的：为未来「国际行情数据工具」选型做准备，与现有 QDII / 汇率 / ETF 工具共享同一套
> 数据源接入、缓存、落库、调度框架（见 `architecture.md`）。
>
> 各源实测结论、覆盖矩阵与实施状态见 [`indices-tool.md`](./indices-tool.md)
> （四源编排、429 退避、跨源新鲜度护栏均已落地）。
> ⚠️ **运行时优先级已于 2026-09-27 调整为「稳定国内源在前」**：新浪 gi → 腾讯 →
> 东财 → Yahoo（详见 §14.6 与 `indices-tool.md` §3）。下文的「主源/备源/应急源」
> 描述的是**能力与调研结论**，不再是运行时优先级。
>
> 调研方式：**直接请求接口 + 多源交叉验证**（同一时点比对收盘价），不照抄文档。
> 采集日期：**2026-09-26（UTC 09:51 快照）**，行情数据截至 **2026-09-25 各市场收盘**
> （2026-09-26 为周六，腾讯行情状态显示美股/港股/A 股均休市，A 股另逢中秋）。

---

## 1. 需求界定

未来工具对「国际指数行情」的需求分四层：

| 层次 | 用途 | 关键要求 |
|---|---|---|
| ① 最新收盘价 | 列表页、涨跌幅 | 准确、多指数一次拿全 |
| ② 日线历史 | 走势图、区间涨跌 | **数年深度**、开高低收齐全 |
| ③ 盘中分时 | 盘中刷新（可选） | 分钟级、延迟可接受 |
| ④ 交易日历/时区 | 调度与「是否已收盘」判断 | 各市场 tz 不同 |

候选「主流指数」范围（本报告以其实测覆盖）：标普 500、纳斯达克综合/纳指 100、
道琼斯、罗素 2000、VIX、恒生、恒生科技、恒生国企、日经 225、富时 100、德国 DAX、
法国 CAC40、韩国 KOSPI、台湾加权、印度 SENSEX、澳洲 ASX200、加拿大 TSX、
新加坡 STI、印尼 JKSE、墨西哥 IPC、巴西 IBOV。

---

## 2. 结论速览

| 结论 | 说明 |
|---|---|
| **能力最全：Yahoo Finance chart API**（运行时为兜底） | 无需 key；21/22 指数实测通过；日线全量历史（标普可到 1928）；盘中 1m/5m 可用；自带币种与时区元数据 |
| **备源（国内直连）：东方财富** | 全球指数统一 `secid=100.<代码>`；日线历史到 1990 年（道指 9179 行）；`ulist.np` 可批量实时；收盘价与 Yahoo **完全一致**；但 `push2his` 的 **HTTPS 不稳，须走 HTTP 或重试** |
| **第三备源候选（追加实测）：FT Markets** | `searchsecurities` + `get-historical-prices?symbol=<xid>` 双接口匿名可用；全球指数覆盖广；日经 9/25 收盘与快照**逐分不差**；限制是 HTML 解析与 xid 映射（§13） |
| **稳定性主源：腾讯** | `qt.gtimg.cn` 实时 + `web.ifzq.gtimg.cn` 日线，只覆盖美/港 5 个指数、K 线上限 1600 行；字段序实测 `[日期,开,收,高,低,额]`（收在第 3 列）；国内直连最稳，**已实装为第三源** |
| **弃用：新浪「全球指数」实时** | `int_*` 系列**数据陈旧**（道指偏差 −10.8%、日经 −32.3%），且找不到历史 K 线接口；与新浪外汇（fx 工具在用）质量完全不同 |
| **弃用：Stooq** | 免费 CSV 被 JS 反爬挑战拦截，实测拿不到数据 |
| 海外 key 类（Alpha Vantage / Twelve Data 等） | 需注册、有配额，本项目暂无必要；详见 §8（未实测） |

---

## 3. 候选源全景

| 源 | 类型 | Key | 实测结果 | 结论 |
|---|---|---|---|---|
| Yahoo Finance `v8/finance/chart` | REST | 否 | ✅ 21/22 指数、全历史、盘中分时 | 能力最全（运行时兜底） |
| 东方财富 `push2/push2his/searchapi` | REST | 否 | ✅ 覆盖广、历史深；HTTPS 抖动 | 备源 |
| 腾讯 `qt.gtimg.cn` / `ifzq.gtimg.cn` | REST | 否 | ✅ 美/港指数实时+日线 | 稳定性主源 |
| 新浪 `hq.sinajs.cn` 全球指数 | REST | 否 | ⚠️ 实时数据陈旧；无 K 线 | 弃用 |
| Stooq CSV | REST | 否 | ❌ JS 反爬挑战 | 弃用 |
| TradingView `scanner.tradingview.com` | REST(POST) | 否 | ⚠️ 部分代码有（TVC:UKX/NI225/KOSPI/VIX/HSI），SPX/DAX/TWII 缺失 | 不采用 |
| **FT Markets（追加实测）** | REST + HTML | 否 | ✅ 搜索与历史接口均匿名可用，收盘价与快照一致 | **第三备源候选（§13）** |
| 雪球 `stock.xueqiu.com` | REST | 需 JS token | ❌ 400016 登录墙 / suggest 403（§13） | 弃用 |
| 百度股市通 | REST | 否 | ❌ 跳「百度安全验证」验证码墙（§13） | 弃用 |
| 同花顺 `d.10jqka` / 网易财经 | REST | 否 | ❌ 502/503，疑似拒绝数据中心 IP 或接口下线（§13） | 弃用 |
| 富途牛牛 / 券商 OpenAPI | REST | 要账号 | ❌ 302 登录墙（§13） | 弃用 |
| 华尔街见闻 `api-one-wscn` | REST | 否 | ⚠️ 域名可达但路径藏在 SPA bundle，需再逆向（§13） | 后续候选 |
| 集思录 | — | — | ❌ 本机（含代理）连接不可达，且无国际指数业务（§13） | 不适用 |
| Alpha Vantage / Twelve Data / Finnhub / Marketstack / FMP / EODHD / Polygon | REST | 是 | 未实测（demo key 被拒） | 暂不需要 |
| 指数编制方官方（S&P / FTSE Russell / MSCI / Nikkei / HKEX / STOXX） | 授权 | 是 | 未实测 | 个人工具无授权，实时需付费 |

---

## 4. 主源详测：Yahoo Finance

### 4.1 接口

```
GET https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range={range}&interval={interval}
User-Agent: Mozilla/5.0        ← 建议带；裸请求根路径曾得到 429
```

- **无需 cookie/crumb**：`v7/finance/download/...` 实测 **401**（已要求 crumb，放弃该路径），
  但 `v8/finance/chart` 实测稳定 200。
- `meta` 自带：`currency`（原生币种）、`exchangeTimezoneName`（交易所时区）、
  `regularMarketPrice`、`fiftyTwoWeekHigh/Low`、`firstTradeDate`
  （`^GSPC` 的 `firstTradeDate` 指向 1928 年）。
- 符号发现可用搜索接口：
  `GET https://query2.finance.yahoo.com/v1/finance/search?q=hang%20seng%20tech&quotesCount=5&newsCount=0`
  → 返回 `HSTECH.HK`（恒生科技指数，`^HSTECH` 是**错误**写法，实测失败）。

### 4.2 覆盖实测（range=5d，2026-09-26）

| symbol | 名称 | 币种 | 时区 | 结果 |
|---|---|---|---|---|
| `^GSPC` | 标普 500 | USD | America/New_York | ✅ 7743.41 |
| `^IXIC` | 纳斯达克综合 | USD | America/New_York | ✅ 27068.72 |
| `^NDX` | 纳斯达克 100 | USD | America/New_York | ✅ 30608.13 |
| `^DJI` | 道琼斯 | USD | America/New_York | ✅ 51828.62 |
| `^RUT` | 罗素 2000 | USD | America/New_York | ✅ 2837.55 |
| `^VIX` | VIX | USD | America/Chicago | ✅ 14.87 |
| `^HSI` / `^HSCE` / `HSTECH.HK` | 恒生 / 国企 / 恒生科技 | HKD | Asia/Hong_Kong | ✅ 24510.09 / 8165.78 / 4311.78 |
| `^N225` | 日经 225 | JPY | Asia/Tokyo | ✅ 66364.20 |
| `^FTSE` / `^GDAXI` / `^FCHI` | 富时 100 / DAX / CAC40 | GBP/EUR/EUR | 伦敦/柏林/巴黎 | ✅ 10695.25 / 25408.64 / 8077.80 |
| `^KS11` / `^TWII` / `^BSESN` | KOSPI / 台湾加权 / SENSEX | KRW/TWD/INR | 首尔/台北/加尔各答 | ✅ 7080.92 / 48024.60 / 73895.74 |
| `^AXJO` / `^GSPTSE` / `^STI` / `^JKSE` / `^MXX` / `^BVSP` | 澳 / 加 / 新 / 墨 / 巴 | AUD/CAD/SGD/IDR/MXN/BRL | 各自本地 | ✅ 全部通过 |
| `^TPX`（东证） | — | — | — | ❌ 无此符号（可用 `^N225` 替代） |

**21/22 通过**。注意所有价格均为**原生币种**，换算人民币需走现有 fx 工具的
新浪日线（`fx-data-sources.md`）。

### 4.3 历史深度与盘中（实测）

| 请求 | 结果 |
|---|---|
| `range=max&interval=1mo` `^GSPC` | 169 行，1984-12 → 2026-09 |
| 同上 `^N225` | 168 行，1984-12 → 2026-09 |
| 同上 `^HSI` | 161 行，1986-12 → 2026-09 |
| 同上 `^DJI` | 417 行，1992-02 → 2026-09 |
| `range=1d&interval=5m` | 79 个点 ✅ |
| `range=7d&interval=1m` | 2731 个点 ✅（1m 上限 7 天为 Yahoo 通行规则） |

### 4.4 限流实测

- 连续 15 个 chart 请求：**15/15 成功**，无 429。
- 无路径的根域名请求曾得到 **429**。
- 结论：可用，但要按 1 req/s 节流 + 429 指数退避；多指数批量刷新用并发 ≤3、
  请求间 sleep 即可（22 个指数 ≈ 25s 拉完一轮）。

### 4.5 风险

- 无官方配额承诺，属「可容忍的非官方用法」——必须有**备源降级**（§5 东财）。
- 国内直连稳定性依赖网络环境；部署环境若在境外则无此顾虑。
- 符号体系是 Yahoo 私有（`^GDAXI`、`^KS11`…），需要维护一张映射表。

---

## 5. 备源详测：东方财富

### 5.1 编号规律：全球指数统一在 `market=100`

东财把**所有境外指数**放在 `100.<西方标准代码>` 下（与 A 股 `0./1.`、港股 `116.` 不同）：

```
secid=100.SPX    标普500          secid=100.DJIA   道琼斯
secid=100.NDX    纳斯达克(综合) ⚠️  secid=100.HSI    恒生指数
secid=100.N225   日经225          secid=100.FTSE   英国富时100
secid=100.GDAXI  德国DAX          secid=100.FCHI   法国CAC40
secid=100.KS11   韩国KOSPI        secid=100.TWII   台湾加权
secid=100.SENSEX 印度SENSEX       secid=100.AS51    澳洲ASX200
secid=100.STI    新加坡STI        secid=100.JKSE    印尼JKSE
secid=100.MXX    墨西哥IPC        secid=100.BVSP    巴西IBOV
secid=100.UDI    美元指数（附赠）   secid=100.HSCE?/HSTECH/VIX/GSPTSE → rc=100 无
```

代码可用搜索建议接口确认（实测可用，无需有效登录态）：

```
GET https://searchapi.eastmoney.com/api/suggest/get?input=恒生指数&type=14
    &token=D43BF722C8E33BDC906FB884D85E326E8&count=5
→ {"Code":"HSI","Name":"恒生指数","QuoteID":"100.HSI",...}
```

⚠️ **同名陷阱（交叉验证发现）**：东财 `100.NDX` 名为「纳斯达克」，收盘 27068.72
= Yahoo `^IXIC`（**综合指数**），**不是**纳指 100（`^NDX`=30608.13）。
搜索「纳斯达克100」只返回 ETF——**东财无纳指 100 现货指数**，该指数只能走
Yahoo / 腾讯（`usNDX`）。

### 5.2 日线历史 K 线

```
GET http://push2his.eastmoney.com/api/qt/stock/kline/get
    ?secid=100.DJIA&klt=101&fqt=0&beg=19000101&end=20500101
    &fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56,f57
```

- **字段序实测**：`f51 日期, f52 开盘, f53 收盘, f54 最高, f55 最低, f56 成交量, f57 成交额`
  （验证：2026-09-01 道指 `53176.60 > 52766.88 > 52691.31`，高≥收≥低成立）。
- **历史深度实测**：道指 **1990-04-25 起共 9179 行**，首日 2666.44（与史实吻合），
  末行 `2026-09-25,51828.62` 与 Yahoo 收盘**完全一致**。
- **传输层大坑**：`https://push2his...` 实测**间歇性连接失败**（连续 15 次全 000），
  改 `http://push2his...`（80 端口）**立即稳定 200**；`push2.eastmoney.com` 的
  HTTPS 同样抖动。这与 `fx-data-sources.md` §1 记录的「该 host IPv6 解析后连接失败」
  是同一类问题。**实现时必须：HTTP/HTTPS 双端点 + 重试 + 超时熔断。**
- 与 `etf-data-sources.md` §1.4 同理，东财会**按接口重置**风控；
  全球指数的 `clist` 列表接口（`fs=m:100+t:*` 各种组合）实测**全部为空**——
  指数清单不要依赖 clist，用**静态映射表 + searchapi 校验**。

### 5.3 批量实时

```
GET https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2
    &secids=100.DJIA,100.SPX,100.NDX,100.HSI,100.N225,100.FTSE,100.GDAXI,100.KS11,100.TWII,100.SENSEX
    &fields=f12,f14,f2,f3,f4
→ f12 代码, f14 名称, f2 最新价, f3 涨跌幅%, f4 涨跌额
```

- 一次请求拿 10 个指数 ✅；返回值与 Yahoo 逐项一致。
- 但**间歇性返回空**（实测约 1/3 概率空/超时）→ 必须重试。

### 5.4 覆盖缺口

东财**没有**：纳斯达克 100、恒生国企、恒生科技、加拿大 TSX、VIX、罗素 2000（未测，
推测同样缺）。这些必须由 Yahoo 补齐。

---

## 6. 应急源详测：腾讯

### 6.1 实时

```
GET https://qt.gtimg.cn/q=usDJI,us.IXIC,usNDX,us.INX,hkHSI     ← GBK 编码
→ v_usDJI="200~道琼斯~.DJI~51828.62~..."     字段 0 市场,1 名称,2 代码,3 最新价,4 昨收,5 今开...
```

- 可用代码（实测）：`usDJI`、`us.IXIC`、`usNDX`（纳指 100）、`us.INX`（标普 500）、
  `hkHSI`。⚠️ `usSPX`、`usDJI.OTC` 无效（返回 `v_pv_none_match`），代码不规则需记表。
- 价格与 Yahoo/东财一致（51828.62 / 7743.41 / 30608.13 / 24510.09）。

### 6.2 日线 K 线

```
GET https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param={code},day,,,{count}
→ param=usDJI,day,,,5    响应 key 归一化为 "us.DJI"
→ param=us.INX,day,,,5   响应 key "us.INX"
→ param=hkHSI,day,,,800  800 行，2023-06-28 → 2026-09-25
行序：[日期, 开盘, 收盘, 最高, 最低, 成交额]   ← 注意第 3 列是收盘
```

- 请求 800 行给满 800 行；更深历史（count 上限）**未测**，实现时需验证。
- 覆盖仅实测了美/港指数；其他市场代码未验证。
- 行内自带 `qt` 实时块，可一次拿「实时+若干 K 线」。

---

## 7. 弃用源：实测否决记录

### 7.1 新浪「全球指数」——数据陈旧（最重要的否决）

`hq.sinajs.cn`（需 `Referer: https://finance.sina.com.cn/`，GBK 编码）实测：

| 代码 | 名称 | 新浪返回 | 同刻真实值（Yahoo=东财=腾讯） | 偏差 |
|---|---|---|---|---|
| `int_dji` | 道琼斯 | 46247.29 | 51828.62 | **−10.8%** |
| `int_sp500` | 标普指数 | 6643.70 | 7743.41 | **−14.2%** |
| `int_nasdaq` | 纳斯达克 | 22484.07 | 27068.72 | **−16.9%** |
| `int_nikkei` | 日经指数 | 44946.64 | 66364.20 | **−32.3%** |
| `int_ftse` | 伦敦指数 | 9284.83 | 10695.25 | **−13.2%** |
| `int_hangseng` | 恒生指数 | 24510.09 | 24510.09 | 0%（仅恒生是新鲜的） |
| `b_TWSE` | 台湾指数 | 25580.32，**日期字段 2025-09-26** | 48024.60 | 数据停在一年前 |
| `b_HSI` / `b_STI` / `b_MXX` | 恒生 / 新加坡 / 墨西哥 | 与真实值一致 | — | 新鲜 |

- `int_dax/int_cac40/int_kospi/int_sensex/int_asx200/int_tsx/b_KS11/b_N225/...` 全部**空值**。
- 历史 K 线接口试了 6 个候选 URL（`GuZhenService` / `GlobalIndexService` /
  `NewForexService.getDayKLine` 等）全部 `Service not valid` 或 404 —— **新浪全球指数无日线**。
- **结论：新浪在国际指数上是「冻结的遗留 feed」，与它在外汇（fx 工具在用）上的表现
  是两回事，整体弃用。**（若未来要用 `b_STI` 等少数新鲜代码，也必须逐代码带新鲜度校验。）

### 7.2 Stooq——反爬拦截

`https://stooq.com/q/d/l/?s=^spx&i=d` 返回 200 但内容是 JS 反爬挑战页
（"This site requires JavaScript to verify your browser"），8 个符号全部如此。弃用。

### 7.3 TradingView scanner——覆盖不全

`POST https://scanner.tradingview.com/global/scan` 实测：
`TVC:UKX/NI225/KOSPI/VIX/HSI` ✅，`TVC:SPX/TVC:DAX/TVC:TWII` ❌ 缺失。
非官方接口且覆盖随机，不采用。

---

## 8. 海外 Key 类数据源（未实测，仅登记）

demo key 实测均被拒（Alpha Vantage: "demo API key for demo purposes only"；
Twelve Data: 401），完整验证需注册。以下额度为**官网口径、本次未实测**：

| 源 | 免费额度（官网口径） | 指数覆盖 | 适合场景 |
|---|---|---|---|
| Alpha Vantage | 25 次/天 | 以股票/外汇/加密为主 | 兜底 |
| Twelve Data | ~800 次/天、8 次/分 | 全球指数可用 | 盘中分时 |
| Finnhub | 60 次/分 | 指数覆盖有限（CBOE 系） | — |
| Marketstack | ~100 次/月、1 年历史 | 全球指数 4 万+ | 日线 |
| Financial Modeling Prep | 250 次/天 | 有独立 index 端点 | 日线 |
| EODHD | demo 20 次/天 | 指数覆盖最广（4 万+） | 全量兜底 |
| Polygon | 5 次/分（延迟数据） | 美国为主 | — |

判断：**在三源（Yahoo 主 + 东财备 + 腾讯应急）已满足覆盖的前提下**，注册海外 key 的收益很低**，
仅当 Yahoo 被持续限流时再考虑（届时首选 Twelve Data 或 EODHD）。

另注：指数编制方（S&P、FTSE Russell、MSCI、日经、港交所）的**官方实时数据需授权**，
免费渠道一律为延迟行情——个人工具用免费延迟数据即可，但**不要在页面上声称「实时」**。

---

## 9. 交叉验证快照（2026-09-26 09:51 UTC，2026-09-25 收盘）

| 指数 | Yahoo | 东财 | 腾讯 | 新浪 | TradingView |
|---|---|---|---|---|---|
| 道琼斯 | ^DJI **51828.62** | 100.DJIA 51828.62 | usDJI 51828.62 | int_dji 46247.29 ⚠️ | — |
| 标普 500 | ^GSPC **7743.41** | 100.SPX 7743.41 | us.INX 7743.41 | int_sp500 6643.70 ⚠️ | — |
| 纳斯达克综合 | ^IXIC **27068.72** | 100.NDX 27068.72 | us.IXIC 27068.72 | int_nasdaq 22484.07 ⚠️ | — |
| 纳指 100 | ^NDX **30608.13** | ❌ 无 | usNDX 30608.13 | ❌ 无 | — |
| 恒生指数 | ^HSI **24510.09** | 100.HSI 24510.09 | hkHSI 24510.09 | b_HSI 24510.09 | TVC:HSI 24510.10 |
| 日经 225 | ^N225 **66364.20** | 100.N225 66364.20 | — | int_nikkei 44946.64 ⚠️ | TVC:NI225 66363.98 |
| 富时 100 | ^FTSE **10695.25** | 100.FTSE 10695.25 | — | int_ftse 9284.83 ⚠️ | TVC:UKX 10695.26 |
| 韩国 KOSPI | ^KS11 **7080.92** | 100.KS11 7080.92 | — | ❌ | TVC:KOSPI 7080.93 |
| VIX | ^VIX **14.87** | ❌ 无 | — | ❌ | TVC:VIX 14.88 |

规律：**Yahoo ≈ 东财 ≈ 腾讯 ≈ TradingView（±0.02）**，新浪 `int_*` 系列系统性陈旧。

---

## 10. 覆盖矩阵（✅ 实测可用 / ⚠️ 有条件 / ❌ 无）

| 指数 | Yahoo | 东财 | 腾讯 | 新浪 |
|---|---|---|---|---|
| 标普 500 | ✅ `^GSPC` | ✅ `100.SPX` | ✅ `us.INX` | ⚠️ 陈旧 |
| 纳斯达克综合 | ✅ `^IXIC` | ✅ `100.NDX` | ✅ `us.IXIC` | ⚠️ 陈旧 |
| 纳指 100 | ✅ `^NDX` | ❌ | ✅ `usNDX` | ❌ |
| 道琼斯 | ✅ `^DJI` | ✅ `100.DJIA` | ✅ `usDJI` | ⚠️ 陈旧 |
| 罗素 2000 / VIX | ✅ `^RUT` / `^VIX` | ❌ / ❌ | ❌ | ❌ |
| 恒生 | ✅ `^HSI` | ✅ `100.HSI` | ✅ `hkHSI` | ✅ `b_HSI` |
| 恒生国企 / 恒生科技 | ✅ `^HSCE` / `HSTECH.HK` | ❌ / ❌ | ❌ | ❌ |
| 日经 225 | ✅ `^N225` | ✅ `100.N225` | ❌ | ⚠️ 陈旧 |
| 富时 100 / DAX / CAC40 | ✅ `^FTSE`/`^GDAXI`/`^FCHI` | ✅ `100.FTSE`/`100.GDAXI`/`100.FCHI` | ❌ | ⚠️ 仅富时 |
| KOSPI / 台湾加权 / SENSEX | ✅ `^KS11`/`^TWII`/`^BSESN` | ✅ `100.KS11`/`100.TWII`/`100.SENSEX` | ❌ | ❌ |
| ASX200 / STI / JKSE / IPC / IBOV | ✅ `^AXJO`/`^STI`/`^JKSE`/`^MXX`/`^BVSP` | ✅ `100.AS51`/`100.STI`/`100.JKSE`/`100.MXX`/`100.BVSP` | ❌ | ⚠️ 仅 STI |
| 加拿大 TSX | ✅ `^GSPTSE` | ❌ | ❌ | ❌ |
| 美元指数 | ✅ `DX-Y.NYB`（未测） | ✅ `100.UDI`（实测 101.03） | ❌ | ❌ |

⇒ **只有 Yahoo 能独立覆盖全表**；东财缺 6 项（纳指 100、罗素、VIX、港股二线、TSX…）；
腾讯缺除美港外全部；新浪除恒生/新加坡外全部不可用。

---

## 11. 对未来工具的落地建议

1. **三源架构，Yahoo 主、东财备、腾讯应急**
   - `packages/sources/src/index/` 新增模块：`yahoo/chart.ts` + `eastmoney/global-index.ts`
     + `tencent/quote.ts`（应急），仿照 `eastmoney/etf-quotes.ts` 的注释风格。
   - 统一内部模型：`{ code, name, price, prevClose, changePct, currency, timezone, asOf }`。
2. **静态符号映射表**（两侧代码 + 中文名 + 币种 + tz + 是否有历史），`searchapi`
   只用于人工核对，不作为运行时依赖。落表时把 §10 覆盖矩阵直接编码成单测数据：
   「东财无纳指 100」「东财 NDX=综合」这类陷阱要写成**契约测试**。
3. **新鲜度自检**：每次拉取比较各源收盘价，偏差 >0.5% 触发告警并切备源——
   §7 的新浪陈旧数据就是靠这道检查逮到的；不要重蹈覆辙。
4. **传输层护栏**（吸取本项目已踩的坑）：
   - 东财：`http://` 与 `https://` 双端点轮转 + ≥3 次重试（HTTPS 实测间歇 000）；
   - Yahoo：1 req/s 节流、429 指数退避、带 UA；`v7/finance/download` 不要用（401）；
   - 腾讯/新浪响应是 GBK——`HttpClient` 需按现有方案处理编码
     （`architecture.md` §6.1 的编码缺口在**实时行情**这里重新出现，日线 JSON 是 UTF-8 不受影响）。
5. **落库与调度**：日线全量历史一次性回填（东财道指 9179 行 / Yahoo range=max），
   之后每日一次增量；盘中刷新仅对用户已打开的看板按需拉取并做 60s 缓存。
   「今日是否已收盘」用 Yahoo `meta.exchangeTimezoneName` + 简表判断，不引第三方交易日历。
6. **币种**：所有价格按原生币种存储，展示时经现有 fx 工具（新浪 `fx_susdcny`）
   换算人民币，缓存汇率日线。
7. **不要声称实时**：免费源均为延迟行情，页面口径写「延迟行情/每日收盘」。

---

## 12. 复现方式

```bash
# Yahoo（主源）
curl -s -A 'Mozilla/5.0' 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=5d&interval=1d' | head -c 300
curl -s -A 'Mozilla/5.0' 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=max&interval=1mo' | head -c 300

# 东财历史（注意走 http；https 会间歇失败）
curl -s 'http://push2his.eastmoney.com/api/qt/stock/kline/get?secid=100.DJIA&klt=101&fqt=0\
&beg=19000101&end=20500101&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56' | head -c 300

# 东财批量实时
curl -s 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2\
&secids=100.DJIA,100.SPX,100.HSI,100.N225&fields=f12,f14,f2,f3' | head -c 300

# 腾讯（GBK）
curl -s 'https://qt.gtimg.cn/q=usDJI,us.INX,usNDX,hkHSI' | iconv -f GBK -t UTF-8 | head -c 300
curl -s 'https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=hkHSI,day,,,10' | head -c 300

# 新浪（验证「陈旧」现象）
curl -s -H 'Referer: https://finance.sina.com.cn/' \
  'https://hq.sinajs.cn/list=int_dji,int_sp500,int_nikkei,b_HSI' | iconv -f GBK -t UTF-8
# → int_dji=46247.29（真实 51828.62）、int_nikkei=44946.64（真实 66364.20）、b_HSI 正常

# Stooq（验证被拦）
curl -s 'https://stooq.com/q/d/l/?s=%5Espx&i=d' | head -c 120   # JS challenge HTML
```

fixture 落盘建议：`packages/sources/test/fixtures/{yahoo,eastmoney,tencent}/global-index/`，
重新采集后 diff 并更新 §9 快照表与 §10 覆盖矩阵。

---

## 13. 补充调研：雪球 / 集思录 / 券商与其它行情站（2026-09-26 晚追加）

> 触发原因：主力源被临时限流时想扩大备选面。方法同前：直接请求 + 交叉验证。
> 本节所有结论均为**当日实测**（部分与主力源限流窗口重叠，但这些站是独立 host/IP，不受影响）。

### 13.1 否决名单（实测证据）

| 候选 | 实测 | 结论 |
|---|---|---|
| **雪球** | 首页 200 但只种 `acw_tc`（阿里云 WAF cookie），**拿不到 `xq_a_token`**：`suggest.json` 直接 403，`quote.json` 报 `error_code 400016「请刷新页面或重新登录」` | 需 JS 挑战种 token，非纯 HTTP 客户端可得 → **弃用** |
| **集思录** | `www.jisilu.com` 直连与走代理均 000（DNS 可解析 173.255.219.82，连接不通）；业务是转债/基金/封基社区，本就没有国际指数行情接口 | **不适用** |
| **百度股市通** | `gushitong.baidu.com/index/global-SPX` 301 → `seccaptcha.baidu.com`「百度安全验证」验证码页 | 数据中心 IP 被拦 → **弃用** |
| **同花顺 `d.10jqka.com.cn`** | 三个路径均 502 | 疑似拒绝非浏览器/数据中心流量 → **弃用** |
| **网易财经** | `api.money.126.net` 503、`quotes.money.163.com` 502 | 老接口疑似下线/拒绝 → **弃用** |
| **富途牛牛（券商类代表）** | quote-api 302 登录墙；OpenAPI 需账号 token（付费/授权） | 券商行情接口普遍要授权（华泰/中信等同理）→ **弃用** |
| investing.com | 403 | 强反爬 → 弃用 |
| AAStocks | 302 | 跳转墙 → 弃用 |
| Nasdaq 官方 `api.nasdaq.com` | 可达（200 JSON），但 `SPX` / `^GSPC` 均回 `Symbol not exists`；仅覆盖美股 | 可达但符号规则需再逆向、覆盖窄 → 现阶段不用 |
| 华尔街见闻 `api-one-wscn.awtmt.com` | **服务活着**（未知路径回 `71404 Not Found` 而非拒绝），但页面是 SPA，两个主 bundle 里未见硬编码 API 路径 | 真实路径需进一步逆向 → **保留为后续候选**，暂不投入 |

新浪维持原结论（§7.1：`int_*` 系列陈旧，弃用）；雪球/百度/同花顺这几条共同说明：
**国内面向 C 站的行情站这几年普遍上了 WAF/验证码墙，「能开网页」≠「能被程序调用」**。

### 13.2 新增可用源：FT Markets（markets.ft.com）

两个接口均**匿名可用**（2026-09-26 实测）：

```
# 1) 符号发现（返回 symbol/xid/assetClass，可筛 assetClass=Indices）
GET https://markets.ft.com/data/searchapi/searchsecurities?query=Nikkei
→ {"data":{"security":[{"symbol":"n225:NIK","xid":"576473","assetClass":"Indices",…}]}}

# 2) 历史日线（**按 xid**，symbol 参数传 n225:NIK 无效——实测回空 html）
GET https://markets.ft.com/data/equities/ajax/get-historical-prices
    ?startDate=2026/09/01&endDate=2026/09/26&symbol=576473
→ {"data":{},"html":"<tr><td>…日期…</td><td>开</td><td>高</td><td>低</td><td>收</td><td>量</td>…"}
```

- **字段序实测**（用日经 2026-09-25 交叉验证）：`日期, 开盘, 最高, 最低, 收盘, 成交量` ——
  首行 `65,639.62, 66,410.27, 65,639.62, `**`66,364.20`**，收盘与 §9 快照
  （Yahoo=东财=腾讯=TradingView=66,364.20）**完全一致**；若误把第 1 列当收盘会得到 65,639.62（差 1.1%）。
- 响应是 **HTML 表格片段**（非 JSON），需按 `<tr>/<td>` 解析；行按日期倒序。
- 覆盖广（主要交易所的指数都在 Indices 类目下），无需 key，未见限流。
- **定位**：第三备源候选 —— 当 Yahoo（海外）与东财（国内）同时不可用时的兜底；
  代价是 xid 映射表 + HTML 解析器。当前三源已覆盖全表，**暂不实现**，仅登记结论。

### 13.3 对选型的结论

优先级维持：**Yahoo（主）→ 东财（备）→ 腾讯（应急，§6 已实测可实现）→ FT（第三备，本节新增验证）**。
雪球/百度/同花顺/网易/券商系全部因墙或授权否决；华尔街见闻留作后续观察。
---

## 14. akshare 复盘与 2026-09-27 追加实测

> 触发：主动复盘 [akshare](https://github.com/akfamily/akshare)（Python 财经数据聚合库，
> 与本项目同类问题域：把公开行情接口封装成结构化数据），筛出**国际行情**相关的模块逐个
> 实测，而不是照抄。方法与前文一致：直接请求 + 多源交叉验证。
> 实施记录见 [`indices-tool.md`](./indices-tool.md) §9。

### 14.1 akshare 里可借鉴的模块清单（复盘结论）

| akshare 模块 | 提供什么 | 本项目采纳情况 |
|---|---|---|
| `akshare/index/index_global_sina.py` | 新浪「环球市场」日线 `gi.finance.sina.com.cn/hq/daily` | ✅ **采纳为第四源**（实测新鲜、覆盖互补） |
| `akshare/index/index_global_em.py` | 东财 clist 批量实时，`fs=i:100.<代码>` 显式清单写法 | ✅ **采纳为概览缺失补齐**（本报告 §5.2 的「clist 全空」是通配组合的锅，显式清单单请求回 50 指数） |
| `akshare/index/cons.py` 两张符号表 | 东财/新浪的**正确**指数代码 | ✅ **采纳并勘误**两处东财代码（见 14.3） |
| `akshare/index/index_stock_us_sina.py` | 美股指数历史 | ❌ 不采：需 `py_mini_racer` 解混淆 JS，且 Yahoo 已覆盖 |
| `akshare/fx/currency_investing.py` | Investing.com 外汇 | ❌ 不采：investing.com 强反爬（§13.1 已实测 403） |
| 其余（`index_spot`/`index_zh_*`/`macro_*` 等） | A 股/宏观为主 | 不属本工具范围 |

### 14.2 新浪 gi 日线（第四源）——与 §7.1 的「新浪弃用」是两回事

- 接口：`GET https://gi.finance.sina.com.cn/hq/daily?symbol=<代码>&num=10000`（UTF-8 JSON，
  无 Referer 要求）。行结构 `{d, v, c, o, l, h}`，字符串数值、按日期升序。
- **新鲜度实测（2026-09-27）**：DAX/NKY/UKX/GSPTSE/SWI20/FTSEMIB/AEX/IBEX/SX5E/JCI/
  SENSEX/AS51/NZ250/IBOV/MXX/STI 全部停在 2026-09-25；KOSPI 停 09-23、TWJQ 停 09-24 ——
  与 **Yahoo 同日同值**（当地假期，不是陈旧）；19 项与东财 clist 收盘偏差全部 ≤0.001%。
- **深度上限 1000 行**（`num=10000` 也只回 1000，约 4 年）→ 只能做增量/应急，不能全量回填。
- **覆盖**：欧亚/美洲/大洋洲 19 个注册表指数；**没有美股与恒指系**
  （`INX/DJI/NDX/HSI/HSCE/HSTECH` 实测 `code:20001 not found`）。
- 与 §7.1 的结论并存：旧实时接口 `hq.sinajs.cn/list=int_*` 依然**陈旧弃用**；
  gi 是 akshare 新接入的另一套接口，新鲜度完全不同。

### 14.3 东财代码勘误（akshare `cons.py` 的功劳）

| 指数 | 旧结论 | 实测真相 |
|---|---|---|
| 恒生国企 | 「东财无」（试的 `100.HSCE` → rc=100） | 正确代码 **`100.HSCEI`**，clist 返回 8165.78 与 Yahoo 一致 |
| 加拿大 TSX | 「东财无」（试的 `100.GSPTSE` → rc=100） | 正确代码 **`100.TSX`**，clist 返回 35800.89 与 Yahoo 一致 |
| 东财缺 6 → 缺 4 | 覆盖矩阵 §10/铁律 1 | 实际只缺 **纳指100 / 罗素2000 / VIX / 恒生科技** |

⇒ **教训**：「某源没有某指数」的否定结论必须建立在**官方/社区维护的符号表**上，
自己猜代码得到的 rc=100 不算证据 —— akshare 这类聚合库的核心价值就是这张表。

### 14.4 东财 clist 批量实时（显式清单写法）

```
GET http://push2.eastmoney.com/api/qt/clist/get?np=2&fltt=2&invt=2
    &fs=i:100.SPX,i:100.DJIA,i:100.HSI,…（显式列出，akshare 写法）
    &fields=f12,f13,f14,f2,f3,f4,f15,f16,f17,f18,f7,f124&fid=f3&pn=1&pz=200&po=1&dect=1
```

- 实测 **50 指数单请求全回**（`fs=m:100+t:*` 通配组合才是全空的原因，勘误 §5.2）；
- `fltt=2` 直读（akshare 用 fltt=1 再 ÷100，等价）；
- 字段：`f2 最新 f3 涨跌% f4 涨跌额 f12 代码 f13 市场 f14 名称 f15 高 f16 低 f17 开 f18 昨收 f124 时间戳`；
- **HTTPS 直连 000，必须 HTTP 在前**（与 push2his 同类抖动）；
- `f124` 是 feed 心跳时间（收盘后仍跳动），**不能当交易日期用** —— 日期推导见
  `indices-tool.md` §9.3；
- 全部代码非法时回 `rc:102, data:null`（按 UpstreamError 处理）。

### 14.5 新增 6 个指数（三源齐备才收录）

| 指数 | Yahoo | 东财 | 新浪 gi |
|---|---|---|---|
| 欧洲斯托克50 | `^STOXX50E` | `100.SX5E` | `SX5E` |
| 瑞士SMI | `^SSMI` | `100.SSMI` | `SWI20` |
| 意大利MIB | `FTSEMIB.MI`（`^FTMIB` 无数据） | `100.MIB` | `FTSEMIB` |
| 西班牙IBEX35 | `^IBEX` | `100.IBEX` | `IBEX` |
| 荷兰AEX | `^AEX` | `100.AEX` | `AEX` |
| 新西兰NZX50 | `^NZ50`（`^NZ55` 无数据） | `100.NZ50` | `NZ250` |

（另登记未收录候选：英国富时250 `^FTMC`/`100.MCX`、俄罗斯RTS、美元指数
`DX-Y.NYB`/`100.UDI`、马来西亚 KLCI、泰国 SET 等 —— 需要时按三源齐备原则再扩。）

### 14.6 更新后的源优先级与复现方式

> ⚠️ **2026-09-27 再次调整**：因东财 push2his（503）与 Yahoo（429）持续不稳，
> 上线运行时的降级优先级已改为「稳定国内源在前」——
> 新浪 gi（主①，19/28）→ 腾讯 ifzq（主②，美/港 5 个）→ 东财 K 线（备，24/28）
> → Yahoo（兜底，28/28、历史最深）。下面的覆盖矩阵仍是各源的**能力**排序，
> 与运行时**优先级**不同。详见 `indices-tool.md` §3。

```
Yahoo（能力：28/28、历史最深，现为兜底）
 东财 push2his K 线（能力：24/28，现为备源）
 腾讯 ifzq（稳定性主源，美/港 5 个）
 新浪 gi 日线（稳定性主源，19/28，约 4 年）
 [概览] 东财 clist 批量实时（缺失补齐，24/28，单请求）
```

```bash
# 新浪 gi 日线（新鲜度交叉验证）
curl -s 'https://gi.finance.sina.com.cn/hq/daily?symbol=DAX&num=10000' \
  | python3 -c "import json,sys; r=json.load(sys.stdin)['result']['data']; print(r[-1])"
# → {'d': '2026-09-25', …, 'c': '25408.64'}（与 Yahoo/东财 9/25 收盘一致）
curl -s 'https://gi.finance.sina.com.cn/hq/daily?symbol=INX&num=100'
# → {"code":20001,"message":"…not found…","result":{"data":{}}}（美股不在覆盖内）

# 东财 clist 批量实时（显式 i: 清单；http 在前）
curl -s 'http://push2.eastmoney.com/api/qt/clist/get?np=2&fltt=2&invt=2
  &fs=i:100.HSCEI,i:100.TSX,i:100.SSMI,i:100.NZ50
  &fields=f12,f13,f14,f2,f3,f4,f15,f16,f17,f18,f124&fid=f3&pn=1&pz=200&po=1&dect=1'
# → 8 条数据（含勘误代码），f2 即最新价（fltt=2 无需 ÷100）
```

fixture 落盘：`packages/sources/test/fixtures/sina/global-index/`（dax-daily、no-data）与
`packages/sources/test/fixtures/eastmoney/global-index/`（clist-sample、clist-empty）。
