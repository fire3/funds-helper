# ETF 热点研究（`etf` 热点 tab）— 详细设计

> ETF 工具的延伸能力（第四个工具的第二个视图），回答的研究问题：
> **「近期、近1年、近3年，资金正在往哪些热点方向聚集？板块轮动到了哪一步？」**
>
> 归属：`packages/core/src/etf/{theme,hotspot}.ts` · `packages/db`（0011）· `apps/server/src/tools/etf/` · `apps/web/src/tools/etf/HotspotPanel.tsx`
> 上游依据：[`etf-data-sources.md`](./etf-data-sources.md)（接口 B 字段）、接口 H 实测见 §2；
> 框架约定见 [`architecture.md`](./architecture.md)，工具本体见 [`etf-tool.md`](./etf-tool.md)。

---

## 1. 问题背景

`etf-tool.md` 解决的是「全市场 ETF 买哪只」（个体筛选）。本设计解决的是**方向研究**：
单只 ETF 的涨跌是个体噪声，把约 1600 只 ETF 归拢到热点主题上看区间涨幅与资金活跃度，
才能观察出「近期热点在哪、1 年内哪些方向走出来了、3 年维度哪些是长牛」，进而判断资金趋势。

### 1.1 两条互补路径

| 路径 | 机制 | 回答 |
|---|---|---|
| **聚合（自上而下）** | 主题内全部 ETF 等权平均涨幅、成交额/规模合计 | 「这个方向整体强不强、体量多大」 |
| **反查（自下而上）** | 涨幅榜 / 资金流入榜 Top-K ETF → 按主题计数 | 「头部异动集中在哪些主题（多点开花）」 |

两者同向 → 热点确认；背离 → 均值可能被个别权重拉动、或普涨还没形成。

### 1.2 筛选研究维度矩阵

| 维度族 | 指标 | 窗口/口径 | 数据来源 | 状态 |
|---|---|---|---|---|
| 动量 | 区间涨跌幅 `1w/1m/3m/6m/ytd/1y/3y` | 近期 + 1年 + 3年 | 接口 B（前4个）+ 接口 H（后3个，新增抓取） | 1w/1m/3m/ytd 已有；6m/1y/3y 本设计新增 |
| 资金活跃 | 成交额、成交额占比、换手、规模 | 当日快照 | 接口 A | 已有 |
| 资金流向 | **份额变化率**（份额申赎 = 净申购代理） | 自积累起点累计 | `etf_spot_daily.shares` 按日积累（0011 新增列） | 本设计新增，**需逐日积累** |
| 资金流向 | 主力净流入 `mainInflow` | 当日 | 接口 A（东财渠道独有） | 库里已有列，本次补进契约 |
| 情绪 | 折溢价率 | 当日 | 接口 A | 已有 |
| 风险 | 近1年最大回撤 | 1年 | 接口 B `MAXDRAWDOWN1Y` | 已有 |
| 基准对照 | 同期沪深300（接口 H `hs300`） | 1y / 3y | 接口 H | 本设计新增 |
| 分组 | **热点主题**（单维规则表） | — | `core/theme.ts`，匹配 `name + indexName` | 本设计新增 |
| 轮动信号 | 焦点窗口排名 × 近1年排名对比 | — | `core/hotspot.ts` 纯函数 | 本设计新增 |

### 1.3 已确认的口径决策（2026-09-23）

1. **单维热点主题表**（约 70 条有序正则规则，兜底回落现有 7 分类）——不做 QDII 式
   「区域 × 主题」双维：ETF 名称是前缀式行业名（`半导体ETF`、`证券ETF`），单维足够；
   QDII 需要双维是因为名称里同时携带地区与主题两个属性。
2. **加入份额流量**：份额变化是净申购/净赎回的直接代理（一级市场申赎改变总份额），
   比成交额更接近「资金真金白银进出」。该数据从启用日起按日积累，界面诚实标注积累起点。
3. **1年/3年区间涨幅抓取**：每周一凌晨自动 + 界面手动按钮（首次约 1500 请求 / 3 分钟）。

## 2. 上游与数据口径（接口 H）

### 2.1 接口 H 对场内 ETF 可用（实测 2026-09-23）

```
GET https://fundmobapi.eastmoney.com/FundMNewApi/FundMNPeriodIncrease?FCODE=510300&...
→ Datas: [{title:"6Y", syl:"0.90", avg:"1.86", hs300:"2.25", rank:"2500", sc:"4944"}, ...]
        [{title:"1N", syl:"2.53", ...}, {title:"3N", syl:"29.78", ...}]
   Expansion: {ESTABDATE:"2012-05-04", TIME:"2026-09-22"}   ← 数据日期 T-1
```

- `title` 语义（`qdii/advice.ts` 的 `periodLabel` 同源）：`6Y`=近6月、`1N`=近1年、`3N`=近3年、`JN`=今年来；
- 只落库需要的三个窗口 + 基准：`ret_6m/ret_1y/ret_3y`、`bench_1y/bench_3y`（沪深300 同期）；
- **不落上游 `rank/avg`**：「同类」分组口径不透明，而全市场分位可以拿本地 `ret_1y` 分布自己算，语义更干净。

### 2.2 窗口映射总表

| 窗口 | 键 | 来源 | 备注 |
|---|---|---|---|
| 近1周 / 近1月 / 近3月 / 今年来 | `1w/1m/3m/ytd` | 接口 B `CHANGE_RATE_1W/1M/3M`、`YTD_CHANGE_RATE` | 已有，随快照每日更新 |
| 近6月 / 近1年 / 近3年 | `6m/1y/3y` | 接口 H `6Y/1N/3N` | 本设计新增，每周抓取 |

### 2.3 请求预算

| 任务 | cron | 请求数 | 说明 |
|---|---|---|---|
| `etf.periods`（新增） | `0 4 * * 1` | 首次约 1500（≈3 分钟），之后每周同样一轮（增量 = 重抓过期行） | 跳过货币 ETF；专用通道 6 并发/100ms（与联接反查同参数，见 `etf-data-sources.md` §8 的限流实测） |

失败的代码**不写库**（保留旧行），下轮自动重试 —— 与联接反查的增量语义一致，不需要重试状态机。

## 3. 领域模型（`packages/core/src/etf/`）

### 3.1 `theme.ts` —— 热点主题规则表

```ts
classifyEtfTheme(name: string, indexName: string | null, category: EtfCategory): string
```

- 匹配文本 = `${name} ${indexName ?? ''}`（ETF 简称很短，指数名携带主要行业信息；
  `中证全指半导体` 靠简称匹配不到，必须拼上指数名）；
- **有序规则表，第一个匹配生效** —— 顺序即优先级，具体规则在前；
- 兜底 = 现有 7 分类（`category`）：债券/货币/风格等不做细分，直接以分类为主题。

规则分四层（顺序从上到下）：

1. **商品/资源具体品种**：黄金、白银、原油/油气、豆粕、有色/稀土、能源化工
   —— 必须最先：`标普油气` 既要跨境又要能源，热点研究里「油气」是更有效的方向单元；
2. **跨境/区域**：纳斯达克100 → 纳斯达克、标普500、中概互联、港股科技/医药/互联网/金融红利/港股（宽）、
   日本、德国、法国、越南、印度、韩国、沙特、欧洲、亚太/新兴、美国
   —— 港股细分规则必须先于兜底的 `恒生|港股`；A 股行业规则在它**之后**（`恒生医药` 归「港股医药」而不是「医药」，
   与 QDII 双维里地区属性优先的结论一致）；
3. **境内行业/主题**：半导体、证券、银行、保险、金融、白酒、食品饮料、家电、消费、创新药、医药医疗、
   军工、机器人、人工智能、计算机/信创、通信、游戏/传媒、电子、光伏、风电、锂电/储能、汽车、新能源、
   电力、煤炭、能源、钢铁、化工、基建、建材、房地产、环保/碳中和、农业/养殖、旅游、教育、物流/交通、
   航空/航运、红利/股息、央企/国企 …
   —— 内部同样具体在前：`光伏` 先于 `新能源`、`证券` 先于 `金融`、`创新药` 先于 `医药医疗`；
4. **宽基细分**：沪深300、中证A500、中证A50、中证500、中证1000、中证2000/国证2000、上证50、
   深证、创业板、科创、北证50 —— 再兜底到 `category`（宽基里没写细分规则的：全指、富时中国…）。

`coverage()`：统计兜底占比（回归护栏，用 `packages/sources/test/fixtures/eastmoney/etf-profile/list.json`
的 1675 只真实名单跑）—— 落入「行业主题」兜底的比例上升说明规则表失效。

### 3.2 `hotspot.ts` —— 聚合、排名、信号、反查

```ts
const ETF_WINDOWS = ['1w', '1m', '3m', '6m', 'ytd', '1y', '3y'] as const;
windowReturn(record, w): number | null          // 单一取数口径（前端表格/排序/反查共用）
aggregateThemes(records): EtfThemeRow[]          // 分组 → 各窗口等权均值 → 排名 → 资金合计
reverseHotspots(records, { metric, window?, dir?, k? }): EtfReverseGroup[]
themeSignal(row, focusWindow): ThemeSignal      // 按排名分位给标签
```

**聚合口径（等权为主）**：

- 每主题：`count`（ETF 只数）、7 窗口**等权平均涨幅**（null 不计入均值，另记 `covered`）、
  成交额合计与**成交占比**、规模合计、平均折溢价、平均近1年回撤、平均份额变化率、领涨 ETF；
- 等权而不是规模加权：避免巨型宽基/货币类 ETF 主导主题涨幅；资金体量用成交额/规模单列展示；
- 每窗口在「该窗口有数据的主题」内部排名（1 起），写入 `ranks`；无数据 → `null` 排名。

**轮动信号 `themeSignal`**（焦点窗口排名 vs 近1年排名，按分位判断，主题数 ~50）：

| 标签 | 条件（焦点分位 = rank / rankedCount） | 含义 |
|---|---|---|
| `持续强势` | 焦点 ≤25% 且 近1年 ≤25% | 短长皆强，趋势持续 |
| `新热点` | 焦点 ≤25% 且 近1年 ≥50% 分位 | 短强长弱，新启动 |
| `退潮` | 焦点 ≥50% 分位 且 近1年 ≤25% | 短弱长强，前期热点退潮 |
| `震荡` | 其余 | 无明确信号 |

**反查 `reverseHotspots`**：

- 指标 `metric`：`ret`（涨幅，配 `window` + `dir` 升降序）、`mainInflow`（主力净流入）、
  `sharesChange`（份额增长）、`amount`（成交额）；
- 取 Top-K（默认 K=30，null 值剔除）→ `classifyEtfTheme` 归组 → 按命中数降序、同命中按组内头部值降序；
- `hits ≥ 2` 即「多点开花」强信号（UI 给 Badge）。

`EtfHotspotRecord` 是结构接口（`code/name/indexName/category/…`），`EtfRecord` 天然满足 ——
core 不依赖传输层 DTO（与 `EtfStatRecord` 同一模式）。

### 3.3 `sort.ts` —— 新排序键

`ETF_SORT_KEYS` 追加 `ret6m / ret1y / ret3y`（标签：近6月/近1年/近3年涨幅从高到低），
`EtfSortable` 增加对应三个 nullable 字段；前端 `SORT_OPTIONS` 自动派生，无需改 filters。

## 4. 落库（`0011-etf-hotspot.ts`）

```sql
CREATE TABLE etf_period_return (
  code        TEXT PRIMARY KEY,   -- 幂等键：每只 ETF 一行，重抓覆盖
  data_date   TEXT,               -- 上游 Expansion.TIME（收益数据日期，T-1）
  captured_at TEXT NOT NULL,
  ret_6m REAL, ret_1y REAL, ret_3y REAL,   -- 本基金额度区间涨幅 %
  bench_1y REAL, bench_3y REAL             -- 沪深300 同期 %（基准对照）
);
ALTER TABLE etf_spot_daily ADD COLUMN shares REAL;  -- 快照时从目录（接口 B）写入，逐日积累
```

- **失败保留旧行**：抓取只 upsert 成功的代码，`captured_at` 即新鲜度判断依据；
- `etf_spot_daily` 每天一行 → `shares` 列天然是**份额时间序列**：
  `sharesChangePct = (最新份额 − 积累起点份额) / 起点份额`，起点 = 该 code 首个非空 shares 行；
  起点与最新同一天时为 `null`（还没有积累，不能显示成「0% 没变化」）。

## 5. 后端接口（`/api/tools/etf`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dataset` | `EtfRecord` 增加 7 个字段（`ret6m/ret1y/ret3y/bench1y/bench3y/sharesChangePct/sharesSince` + 补映射 `mainInflow`）；响应新增 `periodReturns: { updatedAt, dataDate, total, covered1y, covered3y }` |
| POST | `/periods/refresh[?full=1]` | 手动触发区间涨幅抓取（同步响应）；`full` 忽略 7 天新鲜度 |

刷新响应：`{ ok, scanned, updated, failed, skipped, durationMs, message }` ——
成功/失败分开计数（「查了 1500 只、20 只失败」与「全挂」是两件事，失败的下轮自动重试）。

## 6. 前端（`/tools/etf`）

- **Tab**：`?tab=list|hotspot`（URL 可分享，仿 QDII 的三 tab 模式）；默认列表，行为不变；
- **热点 tab 未抓过区间涨幅时**：空态 + 「抓取区间涨幅」按钮（提示约 1500 请求 / 3 分钟，期间可浏览其它内容）；
- **聚合视图**（默认）：
  - 顶部三块主题榜：近期热点（近1月 top5）/ 近1年强势 / 近3年长牛；
  - 窗口 chips（`?w=`，默认 `1m`）+ 升/降序（`?d=`），按焦点窗口排序，焦点列高亮；
  - 主题热力表：主题 | 只数 | 7 窗口涨幅（`trendClass` 红涨绿跌） | 成交额/占比 | 规模 | 份额变化 | 信号 Badge | 领涨 ETF；
    表头标注同期沪深300（`bench1y/bench3y` 取任一记录的非空值）；
  - 点击主题行展开成员 ETF 子行 → 点击子行打开**同一个详情抽屉**（URL 子路径，交互与列表一致）；
- **反查视图**（`?mode=reverse`）：指标 chips（涨幅+窗口 / 主力净流入 / 份额增长 / 成交额，`?m=`）+
  Top-30 按主题分组，`hits≥2` 标「多点开花」，成员行同样进抽屉；
- **列表 tab 增量**：新增「近1年」「近3年」列（整列无数据时隐藏）、排序下拉多三项；
- **抽屉**：区间表现补「近6月/近1年/近3年」与「份额变化（自积累起点）」；
- 新浪渠道缺 `主力净流入` → 反查的该指标沿用 `dataSource.missing` 机制禁用并说明。

## 7. 定时任务

| 任务 | cron | 门槛 | 行为 |
|---|---|---|---|
| `etf.periods` | `0 4 * * 1`（周一 04:00，避开 03:00 的联接反查） | `runOnBoot` 带「距上次抓取 ≥6 天」门槛（取 6 不取 7 的理由同 `ETF_FEEDER_REFRESH_AFTER_MS`） | 非货币 ETF 中「缺失或 `captured_at` 超 7 天」的代码批量抓接口 H，成功才落库 |

## 8. 测试

| 层 | 文件 | 覆盖 |
|---|---|---|
| core | `etf/theme.test.ts` | 规则顺序（具体先于宽泛）、兜底回落分类、**1675 只真实名单的覆盖率护栏** |
| core | `etf/hotspot.test.ts` | 等权均值的 null 处理、排名与 `rankedCount`、信号四态、反查分组/K 截断/升降序 |
| core | `etf/sort.test.ts` | 新排序键 + null 排最后 |
| sources | `eastmoney/parsers.test.ts` + fixture `period-increase/510300.json` | 接口 H 的 ETF 用例（`6Y/1N/3N` 解析） |
| server | `etf-api.test.ts` | `/periods/refresh` 成功/失败/跳过货币、`periodReturns` 覆盖统计、dataset 新字段、任务门槛 |
| 一致性 | `contract.test.ts` | 任务名清单 + cron 5 段式 |
| web | `filters.test.ts` | 新排序键进 URL 白名单 |

## 9. 局限与待办（必须对用户诚实）

- **份额变化从启用日起积累**：起点之前无历史，UI 标注「自 YYYY-MM-DD 起积累」；
  积累不足两天时显示 `—` 而不是 0%；
- **成交额 ≠ 净申购**：成交额是二级市场换手，份额变化才是一级市场申赎 —— 两个口径并列展示，不混用；
- **次新 ETF 没有 3 年数据**：`covered3y < total` 属正常，表头给出覆盖率而不是静默剔除；
- **等权口径**：主题均值不区分成员体量，资金体量看成交额/规模列；规模加权榜留作待办；
- **上游同类排名不采用**（口径不透明）；全市场分位需要时用本地 `ret_1y` 分布现算；
- **待办**：滚动窗口的份额/成交额变化（如近20日）等 `etf_spot_daily` 积累够长后加；
  港股/A 股同名主题（医药）拆分需引入第二维（区域）时再做。
