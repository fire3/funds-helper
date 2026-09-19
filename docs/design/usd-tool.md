# 美元份额工具（`usd`）— 详细设计

> 工具箱的**第二个工具**，回答一个问题：
> **「我想用美元买基金，全市场有哪些美元份额、现在还能不能买？」**
>
> 归属：`apps/server/src/tools/usd/`、`apps/web/src/tools/usd/`、
> `packages/core/src/usd/`、`packages/shared/src/usd.ts`
>
> 通用架构（分层、包边界、部署、测试体系）见 [`architecture.md`](./architecture.md)。
> 上游接口细节见 [`qdii-data-sources.md`](./qdii-data-sources.md)。

---

## 1. 问题背景

在国内公募市场，**唯一能用美元申购的是「美元份额」**（名称带 `美元现汇` / `美元现钞` / `美元`）。
它们绝大多数是 QDII 基金的外币份额类别，与人民币份额**代码不同、净值口径不同、申购渠道也不同**。

三个关键事实决定了本工具的设计：

1. **币种不在上游字段里，只能从名称判定** —— 且「人民币」必须优先：
   `中银美元债债券(QDII)人民币A` 是**人民币份额**，名称里的「美元」描述的是投资方向。
2. **美元份额在天天基金渠道通常不销售** —— 上游把日累计限额写成 `0`。
   同一个 `0` 在归一化后与「真无限额」无法区分，容易误导。
3. **列表可以一次拿全** —— 接口 A 一次请求覆盖全市场 27,538 只，按币种筛出美元份额即可，
   不需要（也绝不应该）逐只轮询接口 B。

---

## 2. 与 QDII 工具的分工

| | QDII 额度工具 | 美元份额工具（本工具） |
|---|---|---|
| 范围 | QDII 口径（`QDII-*` + `指数型-海外股票`） | **全市场**，按份额币种 = USD 筛选 |
| 主命题 | 「今天还能买多少」 | 「哪些能用美元买」 |
| 默认币种 | 人民币（屏蔽美元份额的 0 值噪声） | 只做美元份额 |
| 对 0 值 | 归一化为「无限额」 | **标注「渠道不适用」**，与真无限额区分 |
| 详情抽屉 | 购买建议 / 额度 / 份额类别 / 净值… | 渠道提示 / 额度 / **人民币份额对照** / 净值… |

两个工具**共享**：东财数据源（`apps/server/src/data-sources/eastmoney.ts`）、
详情区块聚合（`apps/server/src/fund-detail/sections.ts`）、通用领域逻辑（`@funds-helper/core` 的 `fund/`），
以及前端详情区块组件（`apps/web/src/components/FundDetailSections.tsx`）。

---

## 3. 领域模型（`packages/core/src/usd/`）

复用 `@funds-helper/core` 的通用基金模型（`fund/model.ts`、`fund/normalize.ts`），只补一个维度：

```ts
/** 美元份额形式 */
export const USD_KINDS = { Spot: '现汇', Cash: '现钞', Unspecified: '未标注' } as const;
export type UsdKind = (typeof USD_KINDS)[keyof typeof USD_KINDS];

/** 现钞 / 美钞 → 现钞；现汇 / 美汇 → 现汇；仅「美元」→ 未标注（顺序敏感） */
export function parseUsdKind(name: string): UsdKind;

/** 币种由 parseCurrencyFromName 判定（「人民币」优先） */
export function isUsdShare(fund: { currency: Currency }): boolean;

/** 「可买」= 开放申购 / 限大额 —— 以申购状态为准 */
export function isUsdBuyable(fund: { status: PurchaseStatus }): boolean;

/** 上游 0 是否来自「渠道不售」 */
export function isChannelNotSold(fund: FundLimit, rawDailyLimit: string | number | null): boolean;

/** 额度文案：区分 渠道不适用 / 无限额 / 具体美元金额 */
export function describeUsdLimit(fund: FundLimit, channelNotSold: boolean): UsdLimitInfo;
```

### 3.1 可买口径（本工具的明确决策）

**以申购状态为准**：`开放申购` / `限大额` = 可买。

日累计限额因渠道不售而**不可靠**，只做展示并显式标注：

| 上游原始值 | 归一化后 | 展示 | 说明 |
|---|---|---|---|
| `0` | `null` | **渠道不适用** | 渠道不售，非「没有限额」 |
| 哨兵（≥1e8） | `null` | 无限额 | 真的没有限额 |
| 正数 | 数字 | `5,000.00 美元` | 真实限额 |
| 场内交易 / 暂停申购 | — | 对应状态文案 | 不走申赎通道 |

> 因为落库只存归一化后的 `daily_limit`（`0` 与哨兵都变成 `null`），
> 「是否渠道不售」必须在**抓取阶段**用原始值判定并单独落库（`usd_snapshot.channel_not_sold`）。

---

## 4. 上游与归一化

- **主数据源**：接口 A `fetchPurchaseSnapshot`（全市场 27,538 行 / 约 4 MB / 1 次请求）。
- **流程**：全部行 `buildFundLimit` → `filter(isUsdShare)` → 计算 `usdKind` / `channelNotSold` /
  同基金人民币份额对照 → 落库。
- **回归护栏**：美元份额数 < `USD_MIN_EXPECTED`（初值 100）时告警；为 0 时抛 `ParseError`。
  > 阈值需在首次真实抓取后按实测校准。
- **份额对照**：按 `shareClassKey` 分组，为每个美元份额记录**非美元**的同类份额
  （同一只基金的人民币份额），供成本比较。

---

## 5. 后端接口（`/api/tools/usd`）

| 路径 | 说明 |
|---|---|
| `GET /dataset` | 全量美元份额 + 统计 + 地区/主题分类计数，**一次返回、前端本地筛选** |
| `GET /funds/:code` | 通用详情区块（净值/收益/规模/配置/持仓/公告）+ 人民币份额对照 |
| `POST /refresh` | 手动触发一次抓取（走调度器，留 `job_run`） |

读路径与 QDII 一致的三级降级：内存缓存 → SQLite → 上游；上游故障且库中有数据时返回
陈旧快照并标 `stale`。所有响应携带 `freshness` 与 `disclaimer`。

---

## 6. 落库（`packages/db/src/migrations/0002-usd.ts`）

| 表 | 幂等键 | 说明 |
|---|---|---|
| `usd_fund` | `code` | 主数据（含 `usd_kind`） |
| `usd_snapshot` | `(code, data_date)` | 时间序列（含 `channel_not_sold`） |
| `usd_sibling` | `(usd_code, sibling_code)` | 同基金人民币份额对照 |
| `usd_detail_cache` | `code` | 详情聚合结果缓存 |

定时任务：`usd.snapshot`（`*/30 * * * *`，`runOnBoot`）。

---

## 7. 前端（`/tools/usd`）

- 顶部固定**渠道提示**横幅：美元份额渠道不售、额度以银行/直销为准。
- 筛选：**申购状态**（默认「可买」）、**份额形式**（现汇/现钞/未标注，多选）、
  **地区 / 主题**（复用 `classify`，维内 OR、维度间 AND）、搜索、排序。筛选写入 URL 可分享。
- 表格：代码 / 简称 / 份额形式 / 地区 / 主题 / 状态 / 日限额 / 起点 / 净值 / 费率。
- 详情抽屉：渠道与可买提示 → 当前额度（含「渠道不适用」说明）→
  **同基金人民币份额对照**（可跳 QDII 工具）→ 通用详情区块。

> **偏差说明**：列表**不做基金公司筛选** —— 接口 A 不含公司字段，逐只调接口 B 取公司
> 会违背上游克制原则。公司信息在详情抽屉（接口 B）展示。

---

## 8. 测试

| 层 | 覆盖 |
|---|---|
| `core` | `parseUsdKind` 三分支 + 简写；`isUsdShare`（人民币优先）；`isChannelNotSold` / `describeUsdLimit` 四分支 |
| `server` | 全市场筛美元份额（过滤人民币与非美元）；`usdKind`/`limitText`/统计；详情 + 人民币对照；400/404；降级 stale；刷新幂等 |
| `web` | 状态/份额形式筛选、维内 OR+维度间 AND、URL 双向同步 |
| `db` | 迁移建出 4 张 `usd_*` 表 |
| 一致性 | `USD_KINDS`（core ↔ shared）逐字一致；注册表 2 个工具 |

端到端：`pnpm smoke` 增加美元份额工具检查（工具清单、refresh、dataset、现汇/现钞存在、详情）。

---

## 9. 实测发现（2026-09-19，真实上游）

首次用真实上游跑通全链路（`pnpm smoke`，26/26 通过）：

| 项 | 实测 | 结论 |
|---|---|---|
| 全市场美元份额 | **167 只**（数据日期 `2026-09-18`） | 远低于全市场 27,565 只 —— 美元份额是小众集合，仍用接口 A 一次拿全 |
| 现汇 / 现钞 | **117 只** | 份额形式判定有实际意义，约 3/4 明确为现汇或现钞 |
| 样例 `000044 嘉实美国成长股票美元现汇` | 暂停申购，限额 `0.01` | 美元份额的限额既有 `0`（渠道不售），也有极小真实值，**不能一概而论** |
| `005615 摩根富时发达市场REITs指数(QDII)美汇` | 限大额，限额 `0` | 命中「渠道不适用」路径 |
| 美元债反例 `002286 中银美元债债券(QDII)人民币A` | 判为人民币份额 | 「人民币」优先规则在真实数据上成立 |

**回归护栏**：`USD_MIN_EXPECTED = 100`（实测 167，留有余量）。
已采集含美元份额的真实 fixture：`packages/sources/test/fixtures/eastmoney/purchase-snapshot/usd-rows.js.txt`。

---

## 10. 待办 / 风险

- 美元份额在接口 A 的**状态**是否与其它渠道一致，需人工抽查（工具已明确「以申购状态为准」并提示渠道差异）。
- 后续可加：美元份额额度变更时间线（复用 `usd_snapshot`）、与 QDII 工具的双向直达。
