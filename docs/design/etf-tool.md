# ETF 工具（`etf`）— 详细设计

> 工具箱的**第四个工具**，回答一个问题：
> **「全市场 ETF 现在什么价、有多大、贵不贵（折溢价）、跟踪的是什么指数？」**
>
> 归属：`apps/server/src/tools/etf/`、`apps/web/src/tools/etf/`、
> `packages/core/src/etf/`、`packages/shared/src/etf.ts`
>
> 通用架构（分层、包边界、部署、测试体系）见 [`architecture.md`](./architecture.md)；
> 上游接口的逆向结论见 [`etf-data-sources.md`](./etf-data-sources.md)。

---

## 1. 问题背景

前三个工具都在回答「能不能买到」：QDII 额度、美元份额、汇率。ETF 不一样 ——
**ETF 一定能买到**（场内交易），真正要判断的是**「买哪只、贵不贵」**：

| 决策问题 | 需要的字段 | 来源 |
|---|---|---|
| 这只 ETF 现在贵还是便宜？ | 折溢价率 | 接口 A `f402` |
| 流动性够不够？ | 成交额 / 换手率 / 量比 | 接口 A `f6/f8/f10` |
| 规模会不会太小（清盘风险）？ | 场内规模 `f20` + 份额 | 接口 A / 接口 B |
| 有没有更便宜的同类？ | 跟踪指数 + 管理费/托管费 | 接口 B / 接口 C |
| 这只 ETF 属于什么类别？ | 宽基 / 行业主题 / 风格 / 跨境 / 债券 / 商品 / 货币 | 接口 B 标志位 |

三个关键事实决定了本工具的设计：

1. **行情与「跟踪指数」不在同一个接口** —— 必须「接口 A × 接口 B 按代码 join」，
   且 B 失败时不能整页报错（分类回退到名称判定）。
2. **上游分页上限是 100 行**（实测 `pz` 无论传多大都只回 100）——
   全市场 1623 只 = 17 页，这决定了「只在交易时段、每 30 分钟」的采集频率。
3. **`f402` 是「负的溢价率」**，与既有 `quote.ts` 同一口径 —— 归一化时取反，
   对外统一「正 = 溢价」，避免前端出现反直觉的符号。

---

## 2. 与既有工具的分工

| | QDII / 美元份额 | ETF（本工具） |
|---|---|---|
| 范围 | 场外（+场内溢价榜） | **全市场场内 ETF**（1623 只）|
| 主命题 | 「今天还能买多少」 | 「买哪只、多大、贵不贵」 |
| 数据面 | 申购状态 / 限额 / 净值 | 行情 + 折溢价 + 规模 + 跟踪指数 + 费率 |
| 分类维度 | 24 地区 × 14 主题（名称判定） | 7 类（**上游标志位优先**，名称回退）|
| 上游 | 接口 A/B/G/H/I（天天基金） | 接口 A（行情）+ B（目录）+ C（详情）|

**复用**：详情抽屉的通用区块（净值走势 / 分周期收益 / 规模 / 配置 / 持仓 / 公告）与 QDII、
美元份额共用 `apps/server/src/fund-detail/sections.ts`，不写第二份上游口径；
前端复用 `FundDetailSections.tsx`、`Chart.tsx`、`Drawer.tsx`。

---

## 3. 领域模型（`packages/core/src/etf/`）

### 3.1 分类（`classify.ts`）

```ts
export const ETF_CATEGORIES = ['宽基', '行业主题', '风格', '跨境', '债券', '商品', '货币'] as const;
export type EtfCategory = (typeof ETF_CATEGORIES)[number];

/** 上游 `IS_*ETF` 标志位（互斥的六个 + 叠加的「风格」）*/
export interface EtfFlags {
  money: boolean;        // IS_HBETF
  crossBorder: boolean;  // IS_WPETF
  bond: boolean;         // IS_ZQETF
  commodity: boolean;    // IS_SPETF
  broad: boolean;        // IS_KJETF
  industry: boolean;     // IS_HYETF
  style: boolean;        // IS_FGETF
}

/** 优先级：先「资产/地域」，再「策略」，最后「宽基 vs 行业主题」*/
export function classifyEtf(flags: EtfFlags): { category: EtfCategory; source: 'upstream' };

/** 接口 B 不可用时的回退：只按名称关键词判定（跨境/债券/商品/货币/宽基/行业主题）*/
export function classifyEtfByName(name: string): { category: EtfCategory; source: 'name' };
```

优先级（**实测依据**：六类标志位互斥，`IS_FGETF` 与「宽基/行业主题」有 42 行重叠）：

`货币 > 债券 > 商品 > 跨境 > 风格 > 宽基 > 行业主题`

> 为什么「风格」排在「宽基」之前：`红利低波ETF` `大盘价值ETF` 既命中 `IS_FGETF`
> 也命中 `IS_KJETF`，用户按「风格」找它们比按「宽基」更符合直觉。
> 名称回退分支不带「风格」——名称里没有可靠线索，硬猜会产生假精度。

### 3.2 折溢价（`premium.ts`）

```ts
/** 上游 f402 = (净值 − 价格)/净值×100（负值 = 溢价）→ 对外的「正 = 溢价」*/
export function premiumRateFromDiscount(discountRate: number | null): number | null;

export const PREMIUM_LEVELS = { HighPremium: '高溢价', Premium: '溢价', Flat: '平价',
  Discount: '折价', HighDiscount: '高折价' } as const;

/** |rate| < 0.1% → 平价；≥ 1% → 高溢价/高折价（跨境 ETF 常见）*/
export function describePremium(rate: number | null):
  { level: PremiumLevel | '未知'; text: string; note: string | null };
```

`note` 仅在高溢价时给出可执行提示（「溢价买入 = 立刻多付 X%，可等折价或走场外」），
其余为 `null` —— 不给无信息量的文案。

### 3.3 统计聚合（`aggregate.ts`）

纯函数 `aggregateEtfStats(records, coverage)`，产出：

- `byCategory[]`：每类的**数量 / 规模合计 / 成交额合计**（分类分布 = 汇总展示的主干）
- `byMarket[]`：沪 / 深的数量与规模
- `premium`：五档计数 + 最大溢价 / 最大折价（带代码与名称，用于「今天谁最贵」）
- `extremes`：规模最大 / 成交额最大 / 涨幅最大 / 跌幅最大
- `coverage`：`{ spot, profile, unlisted }` —— 目录里有、但没有场内行情的新基金数量

### 3.4 排序（`sort.ts`）

`ETF_SORT_KEYS = ['scale','amount','premium','discount','changePct','turnover','listingDate','category','code']`
+ 中文标签 `ETF_SORT_LABELS`。默认 `scale`（规模降序）——「先看主流品种」。
`premium` 按 `premiumRate` 降序（最贵在前），`discount` 升序（最便宜在前）。

---

## 4. 上游与归一化（`packages/sources`）

| 文件 | 内容 |
|---|---|
| `eastmoney/etf-spot.ts` | 接口 A：`parseEtfSpotPage(text)` + `fetchEtfSpot(client)`（内部翻页到 `total`，主备域名切换，`total > 5000` 直接 `ParseError`）|
| `eastmoney/etf-profile.ts` | 接口 B：`parseEtfProfilePage(text)` + `fetchEtfProfiles(client)`（pageSize 1000，翻到 `pages`）|
| `eastmoney/fund-profile.ts` | 接口 C：`parseFundProfile(text)` + `fetchFundProfile(client, code)`；`Datas === null` → `null`（未知代码不是错误）|

归一化顺序：

```
接口 A 行 → 去重（MK0024 ⊂ MK0827）→ 与接口 B 按代码 join
        → 分类（上游标志位，缺失则名称回退）→ 折溢价取反 → 规模（f20，缺失用 DEC_NAV×1e8）
```

**容错**：接口 A 是主源，失败即失败（没有行情就没有这个工具）；
接口 B 是可降级源，失败时记 `logger.warn`、分类回退到名称判定、`indexName` 置空，
数据集照常返回（`freshness` 里标注）。

---

## 5. 落库（`packages/db/src/migrations/0005-etf.ts`）

| 表 | 幂等键 | 说明 |
|---|---|---|
| `etf_spot_daily` | `(code, data_date)` | 行情时间序列。**一张表同时服务「当前快照」与「历史」**：读最新 `data_date` 就是当前视图 |
| `etf_profile` | `code` | 接口 B 的目录行（标志位 + 跟踪指数 + 区间涨跌 + 份额）|
| `etf_detail_cache` | `code` | 接口 C + 通用区块的聚合缓存 |

- `data_date` 取**该批行情里最大的 `f124` 换算到 `Asia/Shanghai` 的日期**，
  而不是「本地今天」—— 周末/节假日刷新时不会写出一个没有行情的数据日期，
  重复刷新同一交易日是幂等的（`ON CONFLICT DO UPDATE`）。
- 分类**不落库**：只存标志位，读取时由 `core` 算 —— 分类口径升级后历史数据自动跟着变。

---

## 6. 后端接口（`/api/tools/etf`）

| 路径 | 说明 |
|---|---|
| `GET /dataset` | 全量 ETF（1623 只）+ 统计 + 分类分布 + 覆盖率，**一次返回、前端本地筛选** |
| `GET /funds/:code` | 详情：行情记录 + 接口 C（费率/规模/管理人）+ 通用区块；未知代码 404 |
| `POST /refresh` | 手动触发一次抓取（走调度器，留 `job_run`） |

响应要点（`packages/shared/src/etf.ts`）：`EtfRecord` 里同时给**原始数值**与
**渲染好的文案**（`premiumText` / `premiumNote`），避免前端各写一套口径。
读路径与其它工具一致：内存缓存 → SQLite → 上游；上游故障返回陈旧快照并标 `stale`。

**回归护栏**：`ETF_MIN_EXPECTED = 800`（实测 1623）。跌破说明板块 `fs` 或分页行为变了；
为 0 直接抛 `ParseError`。

---

## 7. 前端（`/tools/etf`）

- **汇总面板**（本工具的主命题，置顶）：总数 / 总规模 / 总成交额；分类分布（数量 + 规模，
  可点击直接筛选）；折溢价分布（高溢价 / 溢价 / 平价 / 折价 / 高折价）；
  四张榜单（规模最大 / 成交最活跃 / 溢价最高 / 折价最深）。
- **筛选**：分类（多选，维内 OR）、交易所（沪/深）、折溢价方向（溢价 / 折价 / 平价）、
  规模档（≥1 亿 / ≥10 亿 / ≥100 亿）、成交额档（≥1000 万 / ≥1 亿）、搜索、排序；
  筛选条件写入 URL 可分享（与 QDII/美元份额一致）。
- **表格**：代码 / 简称 / 分类 / 跟踪指数 / 最新价 / 涨跌幅 / 折溢价 / 成交额 / 换手 / 规模 / 上市日。
  涨跌与折溢价按 A 股习惯**红涨绿跌**；折溢价用中性色 + 文案，避免与涨跌混淆。
- **详情抽屉**：折溢价提示 → 基本信息（跟踪指数 / 管理费 / 托管费 / 净资产规模 / 管理人 /
  托管人 / 成立日 / 风险等级）→ 通用区块（净值走势 / 分周期收益 / 规模 / 配置 / 持仓 / 公告）。

---

## 8. 定时任务与请求预算

| 任务 | cron | 依据 |
|---|---|---|
| `etf.snapshot` | `*/30 9-15 * * 1-5`（`runOnBoot`） | 场内行情只在交易时段变化；收盘后不再打上游。19 请求/次 × 14 次/天 ≈ 266 请求/天 |

---

## 9. 测试

| 层 | 覆盖 |
|---|---|
| `core` | 分类（标志位优先级、互斥性、名称回退、`IS_FGETF` 叠加）、折溢价（符号取反、五档、文案）、聚合（分布/极值/覆盖率）、排序 |
| `sources` | `parseEtfSpotPage`（字段映射、`f402` 语义、脏行、`data:null`、`total` 护栏）、`parseEtfProfilePage`（标志位、`null` 数值）、`parseFundProfile`（`--` 归一化、`Datas:null`）|
| `db` | 迁移建出 3 张 `etf_*` 表 |
| `server` | join 与分类（上游标志位 / 名称回退）、统计与覆盖率、折溢价文案、`data_date` 取最大行情时间、幂等刷新、陈旧降级、详情（接口 C + 通用区块）、400/404 |
| `web` | 分类/交易所维内 OR、维度间 AND、折溢价方向、规模/成交额档位、URL 双向同步 |
| 一致性 | `ETF_CATEGORIES`（core ↔ shared）逐字一致 + 顺序一致；注册表 4 个工具 |
| 端到端 | `pnpm smoke` 增加 ETF 检查（清单、refresh、dataset 数量与分类、折溢价、详情）|

---

## 10. 待办 / 风险

- `IS_*ETF` 标志位语义是**逆向推断**（缩写 + 样本核对），无官方文档；
  解析层保留布尔原值、分类优先级集中在 `core`，一旦上游改口径只改一处 + 改一个测试。
- `push2` 主域名高频访问会重置 TLS（实测）；备用域名 `push2delay` 缺跨境/商品板块。
  缓解：主备切换 + 只在交易时段采集 + 内存缓存 30 分钟。若长期被限流，
  可退化为「按板块分页、每次只刷新一部分」。
- 未做「同跟踪指数的多只 ETF 横向对比」——接口 B 已提供 `INDEX_CODE`，
  后续可在详情抽屉里加「同指数 ETF 费率/规模对比」（纯前端，零新增上游成本）。
