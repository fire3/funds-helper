# QDII 额度工具 — 详细设计

> 工具箱的第一个工具，回答一个具体问题：
> **「我想买的这只 QDII，今天还能买多少？」**
>
> 归属：`apps/server/src/tools/qdii/`、`apps/web/src/tools/qdii/`、
> `packages/core/src/qdii/`、`packages/sources/src/eastmoney/`
>
> 通用架构（分层、包边界、部署、测试体系）见 [`architecture.md`](./architecture.md)。
> 上游接口细节见 [`qdii-data-sources.md`](./qdii-data-sources.md)。

---

## 1. 问题背景

2026 年 QDII 额度持续紧张，限购已是常态。实测（数据日期 `2026-09-14`）：

| 现象 | 实测 |
|---|---|
| QDII 基金总数 | **735 只**（`QDII-*` 370 + `指数型-海外股票` 365） |
| 处于「限大额」 | **196 只**（占 27%） |
| 处于「暂停申购」 | **67 只** |
| 单日限购 ≤10 元 | 至少 8 只（`270042`/`006479` 限 **2 元**，`000834` 限 **10 元**） |

用户的真实痛点（决定工具的功能边界）：

1. **额度分散且极低** —— 同一指数下各公司限额差异巨大（纳指100：2 元 / 10 元 / 100 元 / 1 万元）
2. **变化频繁** —— 基金公司几乎每周都在「调整大额申购限额」
3. **口径混乱** —— 天天基金、销售渠道、基金公司公告三处数字可能不一致
4. **份额类别干扰** —— 人民币份额限 10 元，美元份额可能显示 0（渠道不售）
5. **场内溢价陷阱** —— 场外买不到转场内，但 QDII ETF 实测溢价 **8%~10%**，最高 **23%**

**工具的价值主张**：把「735 只基金 × 5 种申购状态 × 多份额类别」压缩成一张可决策的表，
并补上 `qdii-helper` 没有的能力——**额度随时间怎么变**。

---

## 2. 数据源选型

| 用途 | 接口 | 调用时机 | 理由 |
|---|---|---|---|
| **主数据源** | A. 全市场申购状态 | 定时任务，每 30 分钟 | 唯一能**一次请求覆盖全部 735 只**的接口 |
| 列表详情补全 | B. 单基金实时信息 | 用户下钻时按需 | `FSRQ` 带年份、`MINSG/MAXSG` 结构化、含 `DUEDATE` |
| 公告溯源 | D. 申购类公告 `type=5` | 每日 + 下钻时 | 唯一能回答「为什么限购、何时生效」的接口 |
| 场内溢价 | F. 行情折价率 | 交易时段每 30 分钟 | 决定「转战场内」是否划算 |
| 基金详情聚合 | G / H / I | 用户下钻时按需 | 净值走势 / 分周期收益 / 持仓 |
| 交叉校验 | C. F10 交易状态页 | 暂不接入 | 提供 `持仓上限`，但 HTML 解析成本高，P1 可缓 |
| 搜索联想 | E. 全量基金列表 | 每日 | 代码 / 名称 / 拼音 |

**关键决策：主数据源用接口 A，绝不用接口 B 逐只轮询。**
735 只 × 1 请求 = 735 次请求，对非官方接口是明显滥用；接口 A 全量 27538 只仅 **1 次请求 / 约 4 MB**，
QDII 只是其子集。接口 B 只在用户下钻单只基金时调用。**这条结论继承自 `qdii-helper` 的实测，
不重新论证。**

---

## 3. 领域模型

`packages/core/src/qdii/model.ts`（纯类型，无 IO）：

```ts
/** 申购状态。注意：赎回状态是另一套枚举，不能复用（见 §4.1）。 */
export const PurchaseStatus = {
  Open: '开放申购',
  Limited: '限大额',          // 核心关注
  Suspended: '暂停申购',
  OnExchange: '场内交易',
  Closed: '封闭期',
  Subscribing: '认购期',
  Unknown: '',
} as const;
export type PurchaseStatus = (typeof PurchaseStatus)[keyof typeof PurchaseStatus];

export const RedeemStatus = {
  Open: '开放赎回',
  Suspended: '暂停赎回',
  OnExchange: '场内交易',
  Closed: '封闭期',
  Subscribing: '认购期',
  Unknown: '',
} as const;
export type RedeemStatus = (typeof RedeemStatus)[keyof typeof RedeemStatus];

export type Currency = 'CNY' | 'USD' | 'HKD';

export interface FundLimit {
  // 身份
  code: string;              // '270042'
  name: string;
  fundType: string;          // '指数型-海外股票'
  currency: Currency;

  // 申购
  status: PurchaseStatus;
  /** null = 无限额。哨兵值在归一化阶段已消灭，下游不必再判断阈值 */
  dailyLimit: number | null;
  minPurchase: number | null;
  nextOpenDate: string | null;

  // 赎回
  redeemStatus: RedeemStatus;

  // 参考信息
  nav: number | null;
  navDate: string | null;
  fee: string;

  // 派生（由 classify 注入，便于前端直接消费）
  region: string;
  theme: string;
}
```

**设计取舍（继承 `qdii-helper` 的三条）**：

- `dailyLimit: null` 表示**无限额**，把「哨兵值」在归一化阶段消灭，避免下游到处写 `if (x >= 1e8)`
- `Currency` 独立成字段，使「按人民币额度排序」不必再做字符串匹配
- **份额类别（A/C/D/F）不单独建模** —— 简称里已含该信息，单独建字段属于无用抽象

**本方案的新增**：`region` / `theme` 作为派生字段挂在模型上（由 `classify` 计算后注入），
但**不落库**（规则会随上游改名而调整，落库会固化脏数据，见 `architecture.md` §5.2）。

---

## 4. 核心算法（可移植规则）

> 以下规则全部来自 `qdii-helper` 对 **735 只真实基金** 的实测归纳，
> 是踩坑换来的结论，**实现语言换成 TS，规则本身不变**。
> 每条规则都配一条对应的单元测试（§8）。

### 4.1 状态归一化

上游状态是自由字符串，未知值必须降级为 `Unknown` 而不是抛错：

```ts
export function parsePurchaseStatus(raw: string | null | undefined): PurchaseStatus {
  const value = raw ?? '';
  return (Object.values(PurchaseStatus) as string[]).includes(value)
    ? (value as PurchaseStatus)
    : PurchaseStatus.Unknown;
}
```

赎回状态**独立解析**——上游赎回枚举取值不同（`开放赎回` ≠ `开放申购`），
若复用同一个解析函数，赎回状态会全部变成 `Unknown`：

```ts
export function parseRedeemStatus(raw: string | null | undefined): RedeemStatus {
  const value = raw ?? '';
  return (Object.values(RedeemStatus) as string[]).includes(value)
    ? (value as RedeemStatus)
    : RedeemStatus.Unknown;
}
```

### 4.2 QDII 识别（**最容易出错的地方**）

`基金类型` 字段里，QDII 分散在**两类标签**中。指数型 QDII 全部落在 `指数型-海外股票`，
**不含 "QDII" 字样**：

| 标签 | 实测数量 |
|---|---|
| `QDII-*`（混合偏股/普通股票/纯债/混合灵活/商品/混合债/FOF/混合平衡/REITs） | 370 |
| **`指数型-海外股票`** | **365** ← 含 `270042 广发纳斯达克100ETF联接人民币(QDII)A` 这类最主流标的 |

```ts
export function isQdii(fundType: string): boolean {
  return fundType.startsWith('QDII-') || fundType === '指数型-海外股票';
}
```

> 只用 `fundType.includes('QDII')` 会**漏掉 365 只（约一半）**。
> 回归护栏：QDII 匹配数 < 500 时告警（上游标签可能已变更）。

### 4.3 限额归一化（哨兵值）

上游用**大整数**表示「无限额」，不是空值：

| 观测值 | 含义 |
|---|---|
| `1e11` / `1e10` / `9999999999` | 无限额 |
| `0` | 视 `status` + `currency` 而定（三种业务含义挤在同一个数值上） |
| 其余 | 真实日累计限额（元） |

实测真实限额最高仅 **5000 万**，故 `1e8` 是安全阈值：

```ts
export const UNLIMITED_THRESHOLD = 1e8;

export function normalizeLimit(
  raw: string | number | null | undefined,
  status: PurchaseStatus,
  currency: Currency,
): number | null {
  const value = toNumber(raw);
  if (value === null) return null;             // '--' / '' 等
  if (value >= UNLIMITED_THRESHOLD) return null; // 无限额哨兵

  if (value === 0) {
    // 场内交易本就不走申赎通道
    if (status === PurchaseStatus.OnExchange) return null;
    // 非人民币份额在天天基金渠道通常不售，0 不代表「限 0 元」
    if (currency !== 'CNY') return null;
    // 人民币 + 限大额：真实就是 0（暂停但未发公告）
    return 0;
  }
  return value;
}
```

> `value === 0` 是**唯一需要多字段联合判断**的规则，三个分支对应三种真实业务含义，不能简化。

### 4.4 份额币种判定（**「人民币」优先级是踩过的坑**）

朴素做法「名称含 `美元` 即为美元份额」是**错的**：
`中银美元债债券(QDII)人民币A`、`汇添富美元债债券(QDII)人民币A` 是**人民币份额**，
名称中的「美元」描述的是**投资方向而非份额币种**。实测同时含「美元」与「人民币」的有 **12 只**。

```ts
const HKD_MARKERS = ['港币', '港元'];
const USD_MARKERS = ['美元', '美汇', '美钞', '现汇', '现钞'];

export function parseCurrency(name: string): Currency {
  if (name.includes('人民币')) return 'CNY';        // 「人民币」优先，避免美元债主题误判
  if (HKD_MARKERS.some((k) => name.includes(k))) return 'HKD';
  return USD_MARKERS.some((k) => name.includes(k)) ? 'USD' : 'CNY';
}
```

> `美汇` / `美钞` 是美元的简写变体，很容易被漏掉（摩根富时发达市场 REITs 那两只），
> 漏掉后会被误判为人民币份额。

### 4.5 双维度归类

**为什么是两个维度**：大量 QDII 同时带「地区」和「主题」两个属性，单层分类必须二选一，
必然丢一半信息：

| 基金 | 单层分类的困境 |
|---|---|
| `景顺长城全球半导体芯片股票` | 放「半导体」丢全球属性，放「全球」丢半导体属性 |
| `易方达标普生物科技` | 放「美国」丢生物科技，放「医药生物」丢美国 |
| `华泰柏瑞中韩半导体ETF` | 放「中韩」还是「半导体」都不完整 |

因此拆成**两个独立维度**，维内取并集（OR）、维度间取交集（AND），
直接对应用户的真实问法：「**美国的**、**医药生物** 的 QDII 还有多少能买？」

**规则形式：有序正则表，第一个匹配生效。规则顺序即优先级**——越具体的指数越靠前：

```ts
// packages/core/src/qdii/classify.ts
type Rule = readonly [label: string, pattern: RegExp];

// 地区/市场（24 类）。顺序敏感：纳斯达克100 必须先于 纳斯达克，
// 恒生科技 必须先于 恒生指数/港股；兜底规则 `.` 必须在最后。
export const REGION_RULES: readonly Rule[] = [
  ['纳斯达克100', /纳斯达克100|纳指100/],
  ['纳斯达克',    /纳斯达克|纳指/],
  ['标普500',     /标普500/],
  ['美国',        /标普|道琼斯|美国|罗素/],
  ['日本',        /日经|日本|东证/],
  ['德国',        /德国|DAX/],
  ['法国',        /法国|CAC/],
  ['欧洲',        /欧洲|欧元区|英国|富时/],
  ['越南',        /越南/],
  ['印度',        /印度/],
  ['巴西',        /巴西|拉美/],
  ['沙特',        /沙特|中东/],
  ['中韩',        /中韩|韩国/],
  ['中概互联',    /中概|海外互联网|中国互联网|海外中国|中国海外|港美|中美/],
  ['恒生科技',    /恒生科技|香港科技|港股科技/],
  ['恒生互联网',  /恒生互联网/],
  ['恒生医药',    /恒生医药|恒生医疗|恒生生物|港股创新药|恒生创新药/],
  ['恒生消费',    /恒生消费/],
  ['恒生国企/H股', /恒生国企|恒生中国企业|H股|港股国企|恒生央企|恒生红利|港股通红利|港股通金融/],
  ['恒生指数/港股', /恒生|香港|港股|大中华/],
  ['亚太',        /亚太|亚洲|东南亚/],
  ['新兴市场',    /新兴市场/],
  ['中国',        /中国|境内/],
  ['全球',        /./],                    // 兜底：无单一市场限定
] as const;

// 主题（14 类）
export const THEME_RULES: readonly Rule[] = [
  ['半导体',      /半导体|芯片/],
  ['医药生物',    /生物科技|生物医药|医药|医疗|健康|创新药/],
  ['科技互联网',  /信息科技|科技|互联网|移动互联|软件|数字/],
  ['消费',        /消费/],
  ['能源',        /石油|油气|能源|天然气|原油|资源/],
  ['贵金属/商品', /黄金|贵金属|商品|抗通胀|通胀/],
  ['房地产/REITs', /房地产|REITs|不动产|房托|REIT/],
  ['债券',        /债|票息|高收益|收益债券/],
  ['汽车',        /汽车/],
  ['教育',        /教育/],
  ['金融',        /金融|银行|券商|保险/],
  ['红利/国企',   /红利|央企|国企|价值|股息/],
  ['综合配置',    /配置|精选|成长|新经济|优质|稳健|多元|中小盘|龙头|领导企业|发现|产业升级|新时代|策略/],
  ['宽基指数',    /./],                    // 兜底：纯指数/宽基，无行业主题
] as const;

function firstMatch(rules: readonly Rule[], name: string): string {
  for (const [label, pattern] of rules) if (pattern.test(name)) return label;
  return rules[rules.length - 1]![0];
}

export function classify(name: string): { region: string; theme: string } {
  return { region: firstMatch(REGION_RULES, name), theme: firstMatch(THEME_RULES, name) };
}
```

**规则来自实测而非想象**，几个关键坑点必须保留：

- **QDII ETF 简称常把公司名放在主题之后**：`恒生科技富国`、`纳指嘉实`、`标普油气富时`。
  因此 `富国`/`嘉实`/`景顺` 等公司名**不能**作为分类依据，主题必须靠**指数名**识别
- **`标普500` 必须与其它 `标普*` 区分**：`标普生物科技` / `标普油气` / `标普消费`
  跟踪的不是标普500，只有字面 `标普500` 才进「标普500」类，其余进「美国」
- **`广发道琼斯石油指数` 同时含「道琼斯」与「石油」**：地区判美国、主题判能源，
  两个维度各取所需——这正是双维度设计的价值

**覆盖率硬指标**：24 个地区类 × 14 个主题类，**735 只全部分类，无「未分类」残留**
（兜底规则保证无一落空）。回归护栏：兜底类（`全球` / `宽基指数`）占比超出预期上限时告警，
说明规则需要随上游改名而更新。

### 4.6 排序与额度分档

| 视图 | 排序键 | 用途 |
|---|---|---|
| 可买优先（默认） | `statusWeight` 升序 → `dailyLimit` 降序 | **默认视图**，直接给可操作结论 |
| 最紧额度 | `dailyLimit` 升序（`null` 排最后） | 看「哪些几乎买不到」 |
| 最松额度 | `dailyLimit` 降序 | 看「还有哪些能买」 |
| 按类型 | `fundType` → `dailyLimit` 升序 | 纳指100 / 标普500 横向对比 |

```ts
const STATUS_WEIGHT: Record<PurchaseStatus, number> = {
  [PurchaseStatus.Open]: 0,
  [PurchaseStatus.Limited]: 1,
  [PurchaseStatus.Suspended]: 2,
  [PurchaseStatus.OnExchange]: 3,
  [PurchaseStatus.Closed]: 4,
  [PurchaseStatus.Subscribing]: 5,
  [PurchaseStatus.Unknown]: 6,
};
```

额度分档（用于「≤10 元 / ≤100 元 / …」的筛选，及限购分布统计）：

```
限 10 元以内 / 限 100 元以内 / 限 1000 元以内 /
限 1 万元以内 / 限 100 万元以内 / 限 100 万元以上
```

> **统计口径**：限购档位分布**只统计人民币份额**——美元份额在天天基金渠道不售、
> 常为 0，会把分布拉偏。这与 `--currency cny` 默认值同一动机。

### 4.7 降级：上游故障时

`dailyLimit` 可能来自「陈旧快照」。前端必须能区分，因此数据集响应携带
`architecture.md` §5.3 定义的 `freshness`，且**单条记录也带 `capturedAt`**，
供详情页展示「该额度采集于 X 时刻」。

---

## 5. 后端接口设计

统一前缀 `/api/tools/qdii`。所有响应携带 `disclaimer` 与 `freshness`。

### 5.1 `GET /dataset` — 全量数据集（核心接口）

一次返回全部 QDII + 统计 + 分类计数。**筛选/搜索/排序全部在前端完成。**

```ts
// 响应结构（Zod schema 定义在 packages/shared，前后端共用）
{
  freshness: { dataDate: '2026-09-14', fetchedAt: '...', stale: false, source: 'eastmoney' },
  total: 735,
  stats: {
    status: { '限大额': 196, '开放申购': 93, '暂停申购': 67, ... },
    buyable: 419,
    limitBands: [{ name: '限 10 元以内', count: 50, low: 0, high: 10 }, ...],
    tightest: 2,                      // 最紧的**正数**限额
  },
  categories: {
    regions: [{ name: '纳斯达克100', count: 31 }, ...],   // 24 类
    themes:  [{ name: '半导体', count: 42 }, ...],        // 14 类
  },
  funds: [ /* FundLimit[]，含 region/theme/limitText 等派生字段 */ ],
  disclaimer: '仅供参考，实际限额以基金公司最新公告为准',
}
```

**为什么一次全量返回**：735 条对浏览器是小数据量（gzip 后 **308 KB → 20 KB**），
换来零延迟筛选；每次点筛选都发请求既慢又浪费上游配额。这是 `qdii-helper` 实测结论。

> **阈值约定**：单工具数据集超过约 5 万行时改为服务端分页筛选（见 `architecture.md` §7.2）。

### 5.2 `GET /funds/:code` — 单只基金详情

聚合 4 个上游接口，**每块独立容错**——某块失败只影响该区块，其余照常返回，
错误写进 `errors[]`（对应 `qdii-helper` 的 `_fund_extra` 设计）：

```ts
{
  code: '270042',
  base:   { name, type, company, manager, purchaseStatus, redeemStatus,
            maxPurchase, minPurchase, nav, navDate, nextOpenDate,
            sourceRate, rate, riskLevel },              // 接口 B
  navTrend:   [{ date, nav, change }],                  // 接口 G，最近约 800 个交易日
  scale:      { categories, series },                   // 接口 G，季度规模
  allocation: { ... },                                  // 接口 G，资产配置
  holders:    { ... },                                  // 接口 G，持有人结构
  periods:    [{ key: '1N', ret, avg, bench, rank, total }],  // 接口 H
  holdings:   { stocks: [...], bonds: [...], etf: {...} },     // 接口 I
  reportDate: '2026-06-30',
  notices:    [{ id, title, publishDate }],             // 接口 D
  freshness: { ... },
  errors: [],                                            // 部分区块失败时的说明
  disclaimer: '...',
}
```

要点：

- **净值走势只回传最近约 800 个点**（≈3.2 年）。前端区间最大到「近 3 年」，
  全量 3000+ 点没有意义，白白撑大响应体
- **联接基金 `fundStocks` 为空**（只持有 ETF），必须回退展示 `ETFCODE` / `ETFSHORTNAME`，
  否则「主要成分」会是空白
- 报告期 `Expansion` 在**响应顶层**，不在 `Datas` 内（容易漏取）
- 按 `code` 缓存 30 分钟

### 5.3 `GET /premium` — 场内折溢价

85 只场内 QDII 的溢价率排行，按折价率升序（= 溢价最高在前）。

字段语义（实测验证）：`f402 = (净值 − 价格) / 净值 × 100 = −溢价率`，
**负值表示溢价**。界面必须做语义转换：`-22.97%` → 显示「溢价 22.97%」。

### 5.4 `GET /changes` — 额度变更（**相对 `qdii-helper` 的新能力**）

```ts
{
  items: [{
    code, name, dataDate, detectedAt,
    field: 'daily_limit',
    oldValue: '10', newValue: '2',
    direction: 'tightened',        // tightened | loosened | unchanged
  }],
  summary: { tightened: 12, loosened: 3, inWindow: '30d' },
}
```

数据来自 `qdii_limit_change` 表（写入快照的同一事务里算好，读取时直接查，不做窗口函数）。

### 5.5 `POST /refresh` — 手动触发

本地开发与排障用：强制拉一次接口 A、归一化、落库、清缓存。
服务器上任务由调度器驱动，此接口用于「刚改完规则想立刻看效果」。

---

## 6. 前端交互设计

### 6.1 页面结构

**列表页 `/tools/qdii`**：

```
┌─ 筛选区 ────────────────────────────────────────────────────┐
│ 地区/市场（24 类，多选）  [纳斯达克100] [美国] [恒生科技] …      │
│ 主题（14 类，多选）       [半导体] [医药生物] [债券] …           │
│ 申购状态（单选组）        可买 | 开放申购 | 限大额 | 暂停申购 | 场内交易 | 全部 │
│ 额度（单选组）            ≤10元 | ≤100元 | ≤1000元 | ≤1万 | ≤100万 | 不限 │
│ 搜索框（/ 聚焦）          代码 / 名称                          │
│ 排序                     可买优先 | 额度从紧 | 额度从松 | 按名称  │
└─────────────────────────────────────────────────────────────┘
┌─ 结果区 ────────────────────────────────────────────────────┐
│ 共 N 只 · 数据日期 2026-09-14 · 12 分钟前更新                  │
│ ┌ 代码 ┬ 名称 ┬ 区域 ┬ 主题 ┬ 状态 ┬ 日限额 ┬ 起点 ┬ 净值 ┬ 费率 ┐│
│ │ …  点击任意行 → 打开详情抽屉                                ││
└─────────────────────────────────────────────────────────────┘
```

**详情抽屉（URL 同步为 `/tools/qdii/:code`）**，分区顺序按「对购买决策的重要性」排列：

1. **购买建议（置顶）** —— A/C 份额怎么选（用折后申购费算**平衡持有期**）、
   同基金另一类份额的代码/限额/状态（**可点击直达**）、7 天赎回费红线、限购与状态提醒
2. **当前额度** —— 日累计限额 / 申购起点 / 状态 / 下一开放日 / 该额度的采集时刻
3. **净值走势** —— 区间切换（近1月/近3月/近6月/近1年/近3年）+ 区间涨幅 + **最大回撤**
4. **收益表现** —— 近1周到成立来的分周期收益率，对比**同类平均**、**沪深300**，含**同类排名**
5. **规模变动** —— 季度净资产规模及环比
6. **资产配置 / 持有人结构** —— 股/债/现金占净比、机构与个人持有比例
7. **主要成分** —— 重仓股及增减持；联接基金显示底层 ETF
8. **最近限购公告** —— 接口 D `type=5`，标题 + 日期，链接到公告详情页

**场内溢价页 `/tools/qdii/premium`**：溢价率排行，用于评估「场外买不到就转场内」的代价。

### 6.2 交互约定

| 交互 | 行为 |
|---|---|
| 筛选条件 | 写入 URL query（`?region=纳斯达克100,美国&theme=医药生物`），**可分享、可刷新复现** |
| `维内 OR、维度间 AND` | 与用户真实问法一致：「美国的、医药生物的 QDII 还有多少能买」 |
| 默认状态 | `可买`（= 开放申购 + 限大额），因为主命题是「现在还能买什么」；看全貌需显式选「全部」 |
| 默认币种 | **人民币**，屏蔽美元份额的 0 值噪声 |
| 金额展示 | 一律走 `MoneyText`：`null` → 「无限额」；CNY 显示「元」，USD/HKD 显示对应单位 |
| 溢价展示 | 一律做语义转换：负的折价率 → 「溢价 X%」并标红 |
| 键盘 | `/` 聚焦搜索、`Esc` 关闭抽屉 |
| 空结果 | 展示「没有符合条件的基金」+ 一键清空筛选，而不是空白页 |

### 6.3 视觉

- 深色模式（Tailwind `dark:` + `prefers-color-scheme`，手动切换持久化）
- 响应式：≥1024px 侧边栏常驻；<768px 侧边栏折叠、表格横向滚动
- 数据日期与免责声明**固定可见**，不随滚动消失
- `stale` 时顶栏徽标转警示色，并提示陈旧原因

---

## 7. 落库与定时任务

| 表 | 写入方 | 幂等键 |
|---|---|---|
| `qdii_fund` | `qdii.snapshot` | `code` |
| `qdii_limit_snapshot` | `qdii.snapshot` | `(code, data_date)` |
| `qdii_limit_change` | `qdii.snapshot` | 同事务内 diff 生成 |
| `qdii_notice` | `qdii.notices` | `id`（上游公告 ID） |
| `qdii_premium` | `qdii.premium` | `(code, captured_at)` |
| `qdii_detail_cache` | 详情接口 | `code` |

**`qdii.snapshot` 的执行流程**（一个事务内完成）：

```
1. 拉取接口 A（4 MB） → 截取 datas 数组 → 结构校验（每行 13 列）
2. 过滤 QDII（isQdii）+ 归一化（状态 / 限额 / 币种）—— 全部调用 packages/core 纯函数
3. upsert qdii_fund（更新 last_seen_at，新基金插入 first_seen_at）
4. upsert qdii_limit_snapshot（唯一键 code+data_date，同一天重复抓取覆盖）
5. 与上一交易日快照 diff → 写 qdii_limit_change（只记变化，不记快照全量）
6. 写 job_run（success / 条数统计）
```

**为什么用 `(code, data_date)` 而不是 `captured_at`**：上游是日频数据，
一天抓 48 次只有最后一次有意义；否则时间序列会被重复点淹没。

**变更检测的边界情况**（写测试覆盖）：

| 情况 | 处理 |
|---|---|
| 首次落库（无基线） | 不产生变更事件，仅建立基线 |
| 基金新增 / 退市 | 新增记 `first_seen`，退市不删快照（保留历史） |
| 上游数据日期未推进（重复拉取） | upsert 覆盖，diff 结果为空，不产生噪声事件 |
| 上游数据日期跳变（缺口） | 记为「数据缺口」，`/api/health` 暴露，前端趋势图标出 |

---

## 8. 测试要点

### 8.1 `core` 单元测试（纯函数，最该覆盖的地方）

| 用例 | 断言 |
|---|---|
| QDII 识别 | `指数型-海外股票` → true；`混合型-灵活` → false |
| 限额哨兵 | `1e10` / `1e11` / `9999999999` / `'100000000000'` → `null` |
| 限额 0 的三义 | 场外+USD → null；场内交易 → null；人民币+限大额 → `0` |
| 限额正常值 | `'2.0'` → `2`；`'--'` → `null` |
| 币种优先级 | `中银美元债债券(QDII)人民币A` → CNY |
| 币种简写 | `…美汇` / `…美钞` → USD；`…港币` → HKD |
| 归类顺序 | `广发纳斯达克100ETF联接` → 地区=`纳斯达克100`（**不是** `纳斯达克`） |
| 归类分离 | `广发道琼斯石油指数` → 地区=美国、主题=能源 |
| 标普细分 | `标普生物科技` → 地区=美国（**不是** 标普500）；`标普500` → 标普500 |
| 归类覆盖率 | 735 只全部命中，兜底类占比在预期区间内 |
| 排序 | 可买优先：开放申购排在限大额前；`null`（无限额）排在最后 |

### 8.2 `sources` fixture 测试

- 接口 A：正常响应、缺 `datas`、列数变更 → 后两者必须抛 `ParseError`
- 接口 G：含非 JSON 块的混合内容、带 BOM → 均能正确提取 26 个块
- 时间戳：`1344960000000` → `2012-08-15`（**UTC+8**）
- 接口 D：JSONP 包裹（`cb({...})`）→ 正确剥离

### 8.3 `server` 集成测试（`fastify.inject()`）

- `:code` 非 6 位数字 → 400 `BAD_REQUEST`
- 不存在的代码 → 404 `NOT_FOUND`
- 注入「上游始终失败」的假 sources + 库里已有快照 → **200 且 `stale: true`**（降级路径）
- 注入「上游始终失败」的假 sources + 库里为空 → 503 `UPSTREAM_UNAVAILABLE`
- 响应必含 `disclaimer` 与 `freshness`

### 8.4 `web` 逻辑测试

移植 `qdii-helper` 的 `test_web_logic.mjs` 思路，用 Vitest 覆盖：
维内 OR / 维度间 AND、额度分档边界、排序稳定性、URL query 与筛选状态的双向同步。

---

## 9. 演进路线（本工具）

| 阶段 | 内容 |
|---|---|
| **M1** | dataset / fund / premium 三组接口 + 双维度筛选 + 详情抽屉 + 场内溢价页（对齐 `qdii-helper`） |
| **M2** | 快照落库 + 变更事件 + **额度变更时间线 / 趋势图**（本工具的核心增量） |
| **M3** | 自选基金 + 额度放宽/收紧提醒 + 公告订阅 |
| **M4** | 接入接口 C 补 `持仓上限`；考虑 akshare 之外的交叉校验源 |

---

## 10. 实测发现（2026-09-19，真实上游）

首次用真实上游跑通全链路后的记录，用于校准设计假设。

**口径与归类得到验证**：

| 项 | 实测 | 结论 |
|---|---|---|
| QDII 总数 | **735 只**（数据日期 `2026-09-18`） | 与 `qdii-helper` 记录的 735 完全一致，双标签口径迁移正确 |
| 纳斯达克100 | **63 只** | 与参考实现记录的「纳指100 × 宽基指数 → 63 只」一致 |
| 归类覆盖率 | regions 合计 735 / themes 合计 735 | **无一只落空** |
| 状态分布 | 限大额 298 / 开放申购 192 / 暂停申购 153 / 场内交易 86 / 封闭期 5 / 空 1 | 限购确实是常态 |
| 场内 QDII | 86 只，最高溢价 **27.12%**（`159509 纳指科技ETF景顺`） | 溢价陷阱比参考实现记录的 23% 更极端 |
| 幂等性 | 同一数据日期重复抓取 `inserted=0` | `(code, data_date)` 唯一键生效 |

**发现的两个真实问题（均已修复并加入回归测试）**：

1. **字段残缺的行真实存在** —— `028912` 的「基金类型」为空串，原解析器因此整批失败。
   已改为**行级宽松、结构级严格**（见 `architecture.md` D8），并加了 fixture
   `purchase-snapshot/sparse-rows.js.txt`。

2. **`limit=0` 与高申购起点自相矛盾** —— 223 只人民币「限大额」里，有 **10 只**日累计限额为
   0，且都是 D/E/F/I 等较新的份额类别。矛盾点在于它们同时有正常的申购起点：

   | 代码 | 名称 | 日限额 | 申购起点 |
   |---|---|---|---|
   | `021778` | 广发纳指100ETF联接(QDII)人民币F | 0 | **500 元** |
   | `023402` | 广发全球精选股票(QDII)人民币F | 0 | **500 元** |
   | `022523` | 天弘标普500发起(QDII-FOF)D | 0 | 1 元 |

   「限额 0 < 起点 500」在业务上不成立，因此这个 0 更像**字段尚未填充**，而非真实限额。

   **当前处置：不改动领域规则**（`qdii-helper` 对此有明确论证：人民币 + 限大额 + 0 是
   「暂停但未公告」的真实状态），保持对上游的忠实映射。但要知道：

   - 「≤10 元」档位（实测 36 只）里有 10 只是这批 0 值，**占比 28%**，该档位的可信度需要打折
   - `tightest`（最紧正数限额）已排除 0，不受影响
   - **后续改进方向**：把「限额 < 申购起点」标记为疑似数据缺失，在界面上与真实 0 值区分开
     （属于 §9 的 M2/M3）

---

## 11. 免责声明

- 数据来自天天基金 / 东方财富的**非官方公开接口**，无 SLA，字段可能随时变更
- 请控制请求频率（建议 ≥30 分钟一次），禁止高频轮询与商业分发
- 工具输出**仅供参考**，实际申购限额以基金公司最新公告为准
- 界面与 API 响应**固定携带**免责声明与数据日期，避免用户基于过期数据决策
