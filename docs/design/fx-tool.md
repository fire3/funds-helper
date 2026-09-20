# 人民币汇率工具（`fx`）— 详细设计

> 工具箱的**第三个工具**，回答一个问题：
> **「美元兑人民币现在多少？过去这些年是怎么波动的？」**
>
> 归属：`apps/server/src/tools/fx/`、`apps/web/src/tools/fx/`、
> `packages/core/src/fx/`、`packages/shared/src/fx.ts`
>
> 通用架构（分层、包边界、部署、测试体系）见 [`architecture.md`](./architecture.md)。
> 上游接口逆向结论见 [`fx-data-sources.md`](./fx-data-sources.md)。

---

## 1. 问题背景

前两个工具回答的是「**现在能不能买**」。汇率是它们背后那条**被忽略的成本线**：
买 QDII 用的是人民币，净值涨了 10%，若人民币同期升值 3%，实际到手只有约 6.7%。

因此本工具的定位不是「看一个数字」，而是**看这条线的历史形状**：

1. **波动要看长周期** —— 近一个月的汇率波动只有百分之零点几，只有拉到数年
   （2015 汇改、2022 破 7、2024 再度走弱）才看得出「人民币汇率」这件事的尺度。
2. **方向必须说清** —— 「人民币兑美元」有两种读法（`USD/CNY ≈ 7.1` 还是 `CNY/USD ≈ 0.14`），
   且**涨跌幅在两种方向下不对称**（`+5%` 的倒数约 `-4.76%`），不能在前端简单取倒数了事。
3. **数据必须能长期累积** —— 上游能给全量历史，但只有自己落库才能在被限流/改版时降级。

---

## 2. 与其它工具的分工

| | QDII 额度 / 美元份额 | 人民币汇率（本工具） |
|---|---|---|
| 范围 | 全市场基金截面 | **单一时序**（USD/CNY 日线） |
| 主命题 | 「今天还能买多少 / 哪些能用美元买」 | 「这些年汇率怎么走的」 |
| 上游 | 天天基金 / 东方财富 | **新浪财经外汇**（新数据源） |
| 数据形态 | 快照（按 `data_date` 覆盖） | **完整历史序列**（一次请求返回 1994 年至今） |
| 落库 | 每日快照 + 变更事件 | 日线时间序列（幂等 upsert） |

完全独立，不共享数据源；仅共享框架能力（`ToolContext`、三级降级、`freshness` 契约）。

---

## 3. 领域模型（`packages/core/src/fx/`）

```ts
/** 报价方向。USD/CNY = 1 美元兑多少人民币（国内习惯报价） */
export const FX_DIRECTIONS = { UsdCny: 'USD/CNY', CnyUsd: 'CNY/USD' } as const;

/** 展示区间（相对**最后一个交易日**回看，避免非交易日让结果漂移） */
export const FX_RANGE_KEYS = ['1y', '3y', '5y', '10y', 'all'] as const;
export const FX_DEFAULT_RANGE: FxRangeKey = '5y';

/** 统计区间（区间涨跌表） */
export const FX_INTERVAL_KEYS = ['1m', '3m', '6m', '1y', '3y', '5y', 'ytd', 'all'] as const;

export interface FxBar { date: string; open: number | null; low: number | null; high: number | null; close: number }
```

### 3.1 纯函数（`series.ts`）

| 函数 | 职责 |
|---|---|
| `convertRate` / `convertBar` | 方向换算。`CNY/USD` 取倒数，且 **`low`/`high` 必须互换**（1/最高 = 反向最低） |
| `sliceRange(bars, range)` | 裁剪展示区间，锚定最后一根 K 线 |
| `downsample(bars, maxPoints)` | 等距抽稀（保留首尾），避免 32 年 × 日线把图表与响应撑爆 |
| `intervalChanges(bars)` | 各统计区间的起止汇率、涨跌额与涨跌幅 |
| `yearlyStats(bars)` | 年度：年初/年末、最高/最低、年均、年度涨跌 |
| `extremes(bars)` | 区间/全历史极值（按收盘价，与走势图口径一致） |
| `dayChange(bars)` | 最新一根较上一交易日的变动 |
| `annualizedVolatility(bars, windowDays)` | 近一年日对数收益标准差 × √252（「波动」的量化口径） |

**关键决策：方向换算在服务端完成**。涨跌幅在 `1/x` 下不对称，若前端只做倒数显示，
「近 1 年 +5%」会变成 `+5%` 而不是 `-4.76%`，是**错误而非精度问题**。
因此 `direction` 是请求参数，`intervals` / `yearly` / `summary` 全部按该方向重算。

**关键决策：区间锚定最后一个交易日而不是 `Date.now()`**。周末与节假日请求同一 URL
应得到相同结果（可缓存、可测试、可分享），锚定「今天」会让周一的结果与周日不同。

---

## 4. 上游与归一化

- **数据源**：新浪财经外汇日线 `NewForexService.getDayKLine`（详见 [`fx-data-sources.md`](./fx-data-sources.md)）。
- **形态**：一次请求返回**全量历史**（USD/CNY 自 `1994-08-30` 起，实测 8021 根 / 约 320 KB）。
- **字段序**：`date,open,low,high,close`（已用 2005-07-22 汇改与 2015-08-11 汇改交叉验证）。
- **解析原则**（沿用 `architecture.md` D8）：
  - 结构级严格：JSONP 载荷缺失、首行列数 ≠ 5 → 立刻 `ParseError`
  - 行级宽松：日期格式不符或无收盘价的行跳过并计数，不让脏行毁掉整个序列
  - 按日期去重（同日保留后者）后**升序**输出，下游无需关心上游顺序
- **回归护栏**：`FX_MIN_EXPECTED = 5000`（实测 8021）；为 0 时抛 `ParseError`。

> 不做实时行情：`hq.sinajs.cn` 返回 GBK 且字段语义未验证，而日线序列已包含当日 K 线。
> 「最新」= 最后一个交易日的收盘价，这一点在界面上明确写出。

---

## 5. 后端接口（`/api/tools/fx`）

| 路径 | 说明 |
|---|---|
| `GET /dataset?range=&direction=&refresh=1` | 走势点 + 区间涨跌 + 年度表现 + 概要，**一次返回** |
| `POST /refresh` | 手动触发一次抓取（走调度器，留 `job_run`） |

`range` ∈ `FX_RANGE_KEYS`（默认 `5y`），`direction` ∈ `FX_DIRECTIONS`（默认 `USD/CNY`）。
非法值**回落默认值**而不是 400 —— 与 QDII/USD 的 `clampInt` 一致，避免分享链接里
一个笔误就变成错误页。

### 5.1 缓存结构（比前两个工具多一层）

前两个工具的 dataset 只有一种形态，缓存 key 就是 `usd.dataset`。本工具的结果由
`(range, direction)` 两个维度决定，若按 key 缓存会出现「切一次区间打一次上游」。

因此缓存**只落在不变量上**：

```
cache['fx.base'] = { freshness, bars(全量历史) }        ← 唯一打上游的路径
       │
       └─ 纯函数派生（毫秒级，不缓存）→ (range, direction) 任意组合的响应
```

这样切换区间与方向**永远不打上游**，也不会有缓存 key 爆炸。

### 5.2 读路径降级

与 QDII/USD 完全一致：内存缓存 → SQLite → 上游；上游故障且库中有数据时返回陈旧快照
并标 `stale`（`freshness.staleReason` 带真实原因）；库中无数据时抛
`UPSTREAM_UNAVAILABLE`（503）；非上游异常（DB/编程错误）原样 500 暴露。

---

## 6. 落库（`packages/db/src/migrations/0004-fx-rate.ts`）

| 表 | 幂等键 | 说明 |
|---|---|---|
| `fx_rate_daily` | `(pair, data_date)` | 日线时间序列（`pair = 'USD/CNY'`，与 core 的 `FX_DIRECTIONS` 同源） |

**每次抓取整段 upsert 全量历史**（约 8021 行，单事务）。理由：上游本就一次返回全量，
整段写入是**幂等且自愈**的（历史值被上游修订时也能自动纠正），代价远小于
「只写增量」带来的漏写风险。实测单次写入在事务内为百毫秒级。

定时任务：`fx.daily`（`0 */3 * * *`，`runOnBoot`）。
频率依据：日频数据，每 3 小时一次已是克制下限（约 8 次/天、约 2.5 MB/天），
比 QDII 的 30 分钟宽松，因为它不需要盘中变化。

---

## 7. 前端（`/tools/fx`）

- **方向切换**：美元兑人民币 / 人民币兑美元（`Chip`，写入 URL）。
- **区间切换**：近 1 年 / 近 3 年 / 近 5 年 / 近 10 年 / 全部（默认近 5 年）。
- **概要卡片**：最新价 + 较上一交易日涨跌（按 A 股口径着色：正红负绿）、
  区间最高/最低、历史最高/最低、年化波动率。
- **走势图**：复用 `components/Chart.tsx`（ECharts 折线 + 面积），`close` 序列。
- **区间涨跌表**：近 1 月 → 全部，逐行涨跌额与涨跌幅（着色同口径）。
- **年度表现表**：每年年初/年末/最高/最低/年均/涨跌。
- 筛选写入 URL（`?range=5y&direction=CNY%2FUSD`），可分享、可刷新复现。
- 顶部说明横幅：**数据是新浪即期汇率，不是央行中间价**；换汇以银行牌价为准。

---

## 8. 测试

| 层 | 覆盖 |
|---|---|
| `sources` | fixture：正常载荷（含 1994 与 2026 两端）、缺 JSONP 外壳、列数变更、空载荷；脏行跳过计数 |
| `core` | 方向换算（含 low/high 互换）、区间裁剪、抽稀、区间涨跌、年度统计、极值、日变动、年化波动率 |
| `server` | dataset 形状 + 方向/区间派生、切换参数不打上游、刷新幂等、降级 stale、无数据 503、内部错误 500 |
| `web` | range/direction 的 URL 双向同步与非法值回落 |
| `db` | 迁移建出 `fx_rate_daily` |
| 一致性 | `FX_RANGE_KEYS` / `FX_DIRECTIONS` / `FX_INTERVAL_KEYS`（core ↔ shared）逐字一致；注册表 3 个工具 |

端到端：`pnpm smoke` 增加汇率工具检查（工具清单、refresh、dataset、点数与年度、方向换算、幂等）。

---

## 9. 待办 / 风险

- **上游无 SLA**：新浪日线接口是网页 AJAX 接口，字段序靠逆向 + 历史事件交叉验证；
  已用 fixture 固化，改版立刻失败而非静默出错。
- **不做实时行情**：需要「此刻汇率」时应另找稳定的实时源（且需解决 GBK），当前明确不做。
- 后续可加：中间价（央行）与即期汇率对照、与 QDII 工具的联动（把汇率波动折算成
  「持有期汇兑损益」）。
