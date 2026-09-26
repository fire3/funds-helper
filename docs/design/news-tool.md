# 信息流与 AI 每日简报（`news` 工具）设计方案

> 定位：工具箱的**第五个工具**。解决的问题是：
> **「全球英文财经媒体今天发生了什么，用中文给我讲清楚。」**
>
> 信源调研见 [`global-financial-news-sources.md`](./global-financial-news-sources.md)
> （2026-09-25 实测，A/B/C 三类信源分级、轮询策略与去重口径都在那里）；
> 框架能力见 [`architecture.md`](./architecture.md)。
>
> **本文只讨论 `news` 工具的设计**，不重复框架内容。

---

## 0. 结论摘要（三个已定决策）

| 决策点 | 选择 | 直接后果 |
|---|---|---|
| **AI 协议范围** | 只实现 **OpenAI 兼容** `POST {baseUrl}/chat/completions` | 一套请求/响应映射覆盖 OpenAI、DeepSeek、Kimi、智谱、DashScope、OpenRouter、vLLM、Ollama 等；Anthropic 原生、Gemini 等留到真正需要时再加 adapter 层 |
| **喂给模型的粒度** | **只喂 RSS 标题 + 摘要 + 元数据**，不抓正文 | 无付费墙风险、不绕 WAF、抓取层最简；代价是模型只能做「要闻级」总结，不能复述正文细节 —— 这与工具定位一致 |
| **总结产物形态** | **结构化 JSON**（Zod 校验后入库）+ 前端分区渲染 | 每条要点能回链原文、按日期归档、可重生成；schema 不匹配走一次自动修复重试 |

**一句话方案**：定时拉取约 16 个英文信源的 RSS → 归一化去重落库 → 按窗口（今日/昨日/近7日）
组装一份**有 token 预算的编号条目清单** → 用可配置的模型与提示词生成**带引用编号的结构化 JSON**
→ 校验引用后入库 → 前端渲染「中文简报 + 原始信息流」双栏。

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 | 说明 |
|---|---|---|
| N1 | **信息流可读** | 按信源分组、按时间倒序，支持窗口/信源/关键词筛选，筛选条件写入 URL（与其它工具一致） |
| N2 | **当日中文简报** | 一次调用产出分区结构化的中文总结，每条要点回链原始条目 |
| N3 | **模型完全可配置** | baseUrl / apiKey / model / 参数 / 提示词都能在界面上改，**改完不重启进程** |
| N4 | **失败可解释** | 上游抓不到、模型超时、JSON 不合法、引用越界 —— 每种失败都有明确状态，绝不静默返回空简报 |
| N5 | **克制** | 信源轮询有硬节奏；模型调用按天有次数上限与 token 预算；正文不抓 |
| N6 | **落到既有架构里** | 新增工具 = 新增目录切片 + 注册表加一行，不改框架代码（`architecture.md` §4.5） |

### 1.2 非目标

- ❌ **不抓正文、不绕付费墙、不绕 WAF** —— 只用 RSS 公开字段（调研文档 §6 明确的边界）
- ❌ **不做多轮对话 / 问答** —— 只有「按窗口生成一份总结」这一种调用形态
- ❌ **不做实时推送 / 告警** —— 有更合适的工具形态（站内提醒在 `architecture.md` M3）
- ❌ **不做向量检索 / RAG** —— 一天几百条标题，按窗口直接组装即可，引入 embedding 属于过度设计
- ❌ **不翻译全文** —— 总结里出现的英文专名保留原文，避免误译金融术语
- ❌ **不引入新运行时依赖**（不引 RSS 库、不引 AI SDK）—— 见 D2、D4

---

## 2. 总体数据流

```
  16 个英文信源（RSS 2.0 / RDF / Atom）
        │
        │  news.fetch（每 10 分钟一跳，按各信源自己的 next_fetch_at 决定是否到点）
        │  HttpClient（复用框架的限流/重试/体积上限）+ ETag 条件请求
        ▼
  ┌─────────────────────────────────────────────┐
  │ 解析 → 归一化 → canonical URL 去重 → 落库    │   packages/sources/feeds + core/news
  │ news_source.last_status 留痕（403/404/429） │
  └──────────────────┬──────────────────────────┘
                     ▼
             ┌──────────────┐
             │  SQLite      │  条目永久累积（按月清理）
             │ news_item    │
             └──────┬───────┘
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
  N1 信息流（纯查询）      N2 AI 简报（news.summary 任务 / 手动触发）
                                  │
                                  ├─ core/news/window.ts  选窗口、去重、按配额排序、截断到 token 预算
                                  ├─ core/news/prompt.ts  模板渲染（纯函数，可单测）
                                  ▼
                          OpenAI 兼容 chat/completions
                                  │
                                  ├─ 第 1 次：response_format=json_schema 严格模式
                                  ├─ 不合法 → 第 2 次：附上校验错误的「修复重试」
                                  ├─ 仍不合法 → 状态 failed，前端显示原因，信息流不受影响
                                  ▼
                          core/news/citations.ts 校验 refs 越界
                                  ▼
                            news_summary 落库（含 usage、prompt_hash）
                                  ▼
                            前端分区渲染 + 引用回链
```

**关键取舍：信息流与简报是两条独立读路径。** 模型挂了、配额用完了、提示词改坏了，
信息流照样能看（N4 的落点）。简报只是信息流之上的一层「读法」，不是前置依赖。

---

## 3. 信源层

### 3.1 信源注册表：硬编码在代码里，不接受外部传入 URL

```ts
// packages/sources/src/feeds/registry.ts
export interface FeedDefinition {
  id: string;                    // 'ft.home'
  name: string;                  // 'FT'
  homeUrl: string;               // 展示用，跳转原文时用条目自己的 link
  url: string;                   // RSS 地址（**只从这里取，绝不来自请求参数**）
  category: NewsCategory;        // 决定信息流分组与总结配额
  cadenceSec: number;            // 该信源自己的轮询间隔
  /** 'rss2' | 'rdf' | 'atom' | 'auto' —— auto 按根元素探测 */
  format: FeedFormat;
  weight: number;                // 总结配额里的权重（政策源更高）
}
```

**为什么硬编码**：`architecture.md` §13 明确「上游 URL 全部硬编码，不接受外部传入 URL（防 SSRF）」。
信源是长期资产而不是用户输入，用户要加信源就改代码 —— 这也天然保留了 fixture 测试的前提
（每个信源一组 fixture）。UI 上**不提供**「新增信源」表单。

**首版启用的信源**（直接来自调研文档 §5 的「最小可用配置」，A 类源）：

| 分组 | 信源 | cadence | weight |
|---|---|---|---|
| `media` 全球财经 | FT home、FT markets、CNBC markets、Yahoo Finance | 30 min | 3 |
| `media` 亚洲 | Nikkei Asia、SCMP | 30 min | 3 |
| `opinion` 观点 | Economist finance、Project Syndicate、Foreign Affairs | 60 min | 1 |
| `policy` 政策与监管 | ECB press、BoE news、Fed press、SEC press | 60 min | 5 |
| `discovery` 发现 | Google News `site:reuters.com business when:1d`、Google News 泛财经 | 60 min | 1 |

共 16 个。`discovery` 组只做「发现线索」，条目上标记 `discovery: true`，
**不进入事实性表述的引用池**（模型被明确告知：discovery 条目只能用来提示「有这条线索」，
不能作为事实依据）—— 对应调研文档 §2.4 的结论。

Economist 的 `the-world-this-week` 是周刊节奏，日窗口下几乎无增量，**首版不启用**（记在 §14 演进）。

### 3.2 抓取节奏：一个任务 + 每信源自己的到期时间

**不用 4 个 cron 分组**，而是用**一个** `news.fetch` 任务每 10 分钟跑一次，
表里每个信源存 `next_fetch_at`，到点的才拉。理由：

- 分组 cron 会让「调整某个信源的频率」变成改代码 + 重启；
- 单任务 + 到期判断是幂等的，重启后 `runOnBoot` 补跑一次也不会重复打全部信源
  （对比 `etf.feeders` 的「距上次 ≥6 天」门槛，这里是更精确的 `next_fetch_at`）。

请求量估算（16 信源，media 8×48 + policy 4×24 + opinion/discovery 6×24）：

```
≈ 384 + 96 + 144 = 624 请求/天 ≈ 0.43 请求/分钟（全局）
单 host 最密的是 FT（2 个 feed × 48）= 96/天 = 每 15 分钟一次
```

对 RSS 站点这个量级是常规水平。再叠加 **ETag / If-Modified-Since 条件请求**，
绝大多数轮询返回 304，真正解析的次数远低于 624。

`HttpClient` 是全局共享的（`concurrency: 2`、`minIntervalMs: 300`），信源抓取会与基金行情任务
共用同一个信号量 —— 这是**有意的**：不让新闻抓取把上游通道挤满。代价是新闻抓取可能被
行情快照拖慢几分钟，可接受（新闻不是秒级需求）。

### 3.3 解析与护栏

调研文档 §3.3 已经把字段清单定了，这里只补充**实现形态**：

```ts
// packages/sources/src/feeds/rss.ts
export function parseFeed(text: string, format: FeedFormat): ParsedFeedEntry[]
```

- **纯函数 + fixture**：与 `eastmoney/*` 完全一致的模式（`parseX` 可离线测，`fetchX` 走 IO）。
  16 个信源 = 16 份真实响应 fixture，每个文件头注明**采集日期与原始 URL**。
- 三种格式全部支持：RSS 2.0 `<item>`、RSS 1.0/RDF `<item rdf:about>`（Nikkei 用这个）、
  Atom `<entry>`；命名空间与 CDATA 必须处理。
- **不引 XML 库（D2）**：只做条目级正则/切片提取，不构建 DOM。理由见 §6 决策记录。
- **HTML 剥离**：RSS 的 `description` 常常是 HTML（FT/CNBC 都是），
  抽出 `<p>` 内的纯文本、实体解码（`&amp;` `&#8217;` …）、空白折叠、**按 400 字符截断**。
  剥离失败（返回的还是标签串）不致命 —— 条目降级为「只有标题」，`hasSummary: false`。
- **护栏**（`architecture.md` D8「行级宽松、结构级严格」在这里同样适用）：
  - 根本不是 XML（返回 HTML 挑战页、404 页）→ 抛 `ParseError`，写 `news_source.last_status`，
    **该信源本轮标记失败，不影响其它信源**；
  - 单条残缺（缺 title、缺 link）→ 跳过该条并计数进 `stats.skipped`，不整批失败；
  - `pubDate` 缺失（Nikkei 就没有）→ `published_at = NULL`，
    界面标「时间未知」并按**抓取时刻**兜底排序，**绝不伪造时间**（调研文档 §3.3）；
  - 403/429 → 按 `HttpClient` 既有退避重试；仍失败则把 `next_fetch_at` 推后一倍（上限 4 小时），
    写 `last_error`，避免每 10 分钟反复打一个正在挑战你的站点。
- **SSRF 与体积**：只请求注册表里的 host；响应走 `HttpClient` 的 16 MB 上限。

### 3.4 去重口径（继承调研文档 §3.4）

三段式，逐级降级：

```
1) canonical_url 相同          → 同一条目
   canonical 化规则：小写 host、去 utm_*/fbclid 等跟踪参数、去尾部 /
                      Google News 条目保留其跳转目标（discovery 标记）
2) canonical 不可用 / 是跳转链接 → (source_id, 标准化标题, 发布日期) 相同
   标准化：NFKC → 小写 → 去标点 → 折叠空白
3) 都不可用                    → 不合并（宁可重复，不可错合并）
```

- 主键：`canonical_url` 非空时用 `url` 列唯一索引；否则用 `dedup_key`
  （`source_id|hash(title)|date`），两者都进同一张表的两个可空唯一列。
- **聚合器（Google News）与原文不会自动合并**，因为 canonical 不同 —— 这是**期望的行为**：
  调研文档说聚合器只能当发现层，把它们合并进原文反而会抹掉「这是线索不是原文」的信息。
- 同一窗口内**跨信源**的重复报道不去重（FT 和 CNBC 报同一件事是两条，模型自己归纳）——
  去重的目的是控制 token，不是做事实归并，所以去重只在**组装 prompt 前**再做一次
  标题近似合并（§5.2）。

### 3.5 存量回填（首启才需要）

RSS 通常一次给 20–300 条，但发布时间跨度从 1 天（FT）到几个月（Economist 300 条）。
首启直接拉一遍就有 3–4 天的存量，**不需要单独的 backfill 任务**。
唯一要注意的是：首启时 `next_fetch_at` 全部置为「立即」，一次并发 16 个请求会被
`HttpClient` 的信号量自然串行化，不会打爆。

---

## 4. 信息流读模型（core）

```ts
export interface NewsItem {
  id: number;
  sourceId: string;
  sourceName: string;
  category: NewsCategory;      // media | opinion | policy | discovery
  title: string;
  summary: string | null;      // 已剥离 HTML、已截断
  url: string;                 // 条目原文链接（canonical）
  publishedAt: string | null;  // ISO8601，可为 null
  fetchedAt: string;
  discovery: boolean;
}
```

**筛选维度**（全部纯函数，写在 `apps/web/src/tools/news/filters.ts`，与 etf 的 filters.ts 同构）：

| 维度 | 取值 | URL 参数 |
|---|---|---|
| 窗口 | 今日 / 昨日 / 近 3 日 / 近 7 日 / 全部 | `?range=today` |
| 分组 | 全球财经 / 亚洲 / 观点 / 政策与监管 / 发现 | `?cat=media,policy`（多选取并集） |
| 信源 | 16 个信源多选 | `?src=ft.home,ecb` |
| 关键词 | 标题+摘要，**回车才提交**（避免打断中文输入法，见 taste） | `?q=fed` |

**阈值约定**（`architecture.md` §7.2）：信息流一次全量返回是不可行的 —— 累积几个月就是几万条。
因此 `GET /items` 是**服务端分页**（`limit` 默认 100、`cursor` 游标），带 `?range/cat/src/q` 服务端筛选。
这正好是文档里写的「超过约 5 万行改为服务端分页」的正常延伸。

---

## 5. AI 总结管线

### 5.1 窗口语义

`window` 是一个**显式的、入库的时间区间**，不是一个模糊的「今天」：

| window | 区间（Asia/Shanghai） | 用途 |
|---|---|---|
| `today` | 今日 00:00 → 现在 | 默认视图，随新条目累积而变化 |
| `yesterday` | 昨日 00:00 → 今日 00:00 | **每日任务的产出**（完整一天，可归档） |
| `last7d` | 近 7 天 | 周报视角 |

- 每日任务 `news.summary` 在 **08:30（Asia/Shanghai）** 生成 `yesterday`
  —— 美股已收盘、亚太开盘前，是「读昨天发生了什么」的最佳时点。
- `today` 由前端**按需触发**（`POST /summaries/generate`），服务端按陈旧规则决定是否真的调模型：
  **距上次生成 ≥ 4 小时，或期间新增条目 ≥ 30 条**，否则直接返回缓存的那份。
  `today` 的自动重生成（每 4 小时一次 cron）作为可选开关，默认关 —— 省配额。
- 同一 `(window, window_start)` 保留历史多份（`id` 自增），UI 取最新，`history` 端点可回看。
  换模型/改提示词后重新生成不会覆盖旧版本，便于对比。

### 5.2 预算与排序：把「几百条」压进「一次调用」

这是整个管线里**唯一需要算法**的地方，因此放 `packages/core`（纯函数，可单测）：

```ts
// packages/core/src/news/budget.ts
export interface PromptBudgetInput {
  items: NewsItem[];
  /** 目标 token 数，默认取配置的 maxTotalTokens × 0.6（留给输出） */
  targetInputTokens: number;
}
export interface PromptBudgetResult {
  selected: NewsItem[];         // 带 [n] 编号的最终清单
  dropped: number;              // 被预算挤掉的条数
  droppedByCategory: Record<NewsCategory, number>;
}
```

算法（确定性，无随机）：

1. **窗口内 + 去重**：先按 §3.4 的标题近似合并去掉同标题重复（保 canonical 最优的那条）。
2. **按分组配额**：`policy` 保底 20%、`media` 保底 45%、`opinion` 保底 10%、`discovery` 封顶 10%。
   配额是**保底 + 封顶**，不是硬切：某类不足配额时，余额自动让给其它类。
   `policy` 保底的理由是调研文档 §3.1「政策与监管是事实核验层」—— 二手报道再多，
   也不能盖过央行与证监会的一手公告。
3. **组内排序**：`weight` 降序 → `publishedAt` 降序（NULL 的排最后，按 `fetchedAt` 兜底）。
4. **累加到预算截断**：逐条累加 `estimateTokens(line)`，超预算即停，
   记录 `dropped`。**不静默丢弃**：`dropped > 0` 时写进生成记录并在 UI 上标注
   「已从 N 条中抽取 M 条送入模型」。

`estimateTokens`：英文 `Math.ceil(chars / 4)`，中文 `Math.ceil(chars / 1.6)`，
按字符类型分段估算。**这是估算不是精确计数** —— 我们没有 tokenizer 依赖（D5），
留 40% 余量（`targetInputTokens = maxTotalTokens × 0.6`）就足够安全。

### 5.3 提示词模板与变量

提示词是**用户可编辑的资产**，因此模板是数据不是代码：

```
--- system ---
{systemPrompt}
--- user ---
{render(userTemplate, vars)}
```

| 变量 | 示例值 | 说明 |
|---|---|---|
| `{{date}}` | `2026-09-25（周四）` | 按 `Asia/Shanghai` |
| `{{window_label}}` | `2026-09-25 全天（00:00–24:00，Asia/Shanghai）` | |
| `{{item_count}}` | `187` | 实际送入模型的条数 |
| `{{source_count}}` | `14` | |
| `{{items}}` | `[1] 09:03 CNBC Markets｜Fed holds…<br>    https://…` | 见下方条目格式 |
| `{{extra}}` | 用户在界面上填的额外要求，可为空 | |
| `{{output_language}}` | `中文（简体）` | 模板里可引用，也可被用户改掉 |

**条目行格式**（每条一行，编号即引用号）：

```
[12] 2026-09-25 09:03 · CNBC Markets · 政策
      Fed holds rates steady as officials signal one cut this year
      The Federal Reserve held its benchmark rate…
      https://www.cnbc.com/2026/09/25/….html
```

**默认提示词要点**（写在 `DEFAULT_SYSTEM_PROMPT`，用户可改）：

1. 你是中文财经编辑；只依据给定条目，**禁止使用条目之外的知识**，禁止编造数字；
2. 金融专名（机构名、产品名、人名）**保留英文原文**，只翻译叙述部分；
3. 输出**简体中文**；
4. 引用只能放进 `refs` 数组，**正文里不要出现 `[n]` 字样**；
5. `discovery` 类条目只能表述为「有报道称 / 线索」，不能作为事实断言；
6. 相互矛盾的条目（不同信源说法不一）必须在 `risk` 段落里点明分歧，不要擅自裁决；
7. 没有对应信息的段落**留空数组**，不要凑字数、不要写「今日无相关消息」。

### 5.4 请求构造

```ts
POST {baseUrl}/chat/completions
Authorization: Bearer {apiKey}
Content-Type: application/json

{
  "model": "...",
  "messages": [
    { "role": "system", "content": "<systemPrompt>" },
    { "role": "user",   "content": "<rendered user template>" }
  ],
  "temperature": 0.3,
  "max_tokens": 4000,
  "stream": false,
  "response_format": {
    "type": "json_schema",
    "json_schema": { "name": "news_summary", "strict": true, "schema": {...} }
  }
}
```

- `baseUrl` 归一化：去掉尾部 `/`，若已含 `/chat/completions` 则不再拼接
  （用户经常直接粘完整地址 —— 这是配置类功能最常见的坑，必须容错）。
- **模型能力探测不做**（不先打 `/models`）：直接请求，失败时按状态码分类给出可行动的中文错误。
  `400 + response_format 相关` 时**自动降级**为不带 `response_format` 的重试，
  让不支持结构化输出的兼容端点也能用（DeepSeek/Kimi/部分 vLLM 版本历史上有差异）。
- `temperature` 默认 0.3（总结要稳，不要创造性）；`max_tokens` 默认 4000。
- 超时：**120 秒**（默认 `Http` 的 60s 对长输出偏紧），且**不重试**——
  模型调用失败重试会放大成本与延迟，宁可让这次生成失败、下次手动再来。
- 响应读取 `usage.prompt_tokens` / `completion_tokens` 一并入库。

### 5.5 结构化输出：两级校验 + 一次修复重试

```
第 1 次调用（严格 json_schema）
      │
      ├─ response 不是合法 JSON ──────────────┐
      ├─ Zod 校验失败（缺字段/枚举不符/refs 非数字）┤
      └─ 成功 ────────────────────────────────┼→ 进入 5.6 引用校验
                                              ▼
                                第 2 次调用：「修复重试」
                                user 消息追加：
                                  上一次的输出是：…
                                  校验错误是：…
                                  请只输出修正后的 JSON，不要解释
                                              │
                              ┌───────────────┴───────────────┐
                              ▼                               ▼
                          仍失败                          成功 → 5.6
                              ▼
                    status = 'failed'，error 记原因
                    **不返回半成品**，前端显示失败原因
                    （信息流不受影响，可继续阅读）
```

- **修复重试只允许一次**。两次都失败就停 —— 这是成本护栏，也是「失败要显式」的落点。
- 校验用 `packages/shared/src/news.ts` 里的 `NewsSummaryPayloadSchema`，
  前端用**同一个 schema** 解析响应（`architecture.md` D1 的 REST + Zod 约定）。

### 5.6 引用校验与降级

模型最容易犯的错是**编造引用编号**（`refs: [999]` 而清单只有 187 条）。处理策略：

| 情况 | 处理 |
|---|---|
| 所有 `refs` 都在 `[1, itemCount]` 内 | 通过 |
| 部分越界 | **丢弃越界引用**，该要点保留（正文仍是可读的），`stats.invalidRefs` 计数并写日志 |
| 某个 section 的**全部** points 引用都越界 | 该 section 仍保留（不整段丢），因为标题与正文可能仍有价值 |
| `refs` 为空 | 允许 —— 对应「背景性表述」，UI 不渲染引用角标 |
| 完全没有有效引用（全部越界或全空） | 通过但标记 `citations: 'none'`，UI 顶部提示「本次总结未能关联到原文条目」 |

**为什么不因为越界就整单作废**：一次调用已经花了 token，整单丢弃的边际收益接近零；
丢掉坏引用、保留可读正文，再在界面上标注，比再打一次模型更符合 N5。
（真正致命的是 JSON 不合法 —— 那条路径已经在 5.5 停住了。）

被引用的条目信息**回填进 summary 的 payload**（`items: { [ref]: {id, title, url, sourceName} }`），
这样前端渲染引用角标时**不需要再查一次条目表**，也保证「简报里看到的链接」与生成时一致
（即使那条原始条目后来被清理任务删掉，引用仍然可点）。

---

## 6. 配置：环境变量给默认，`app_setting` 给覆盖

沿用 ETF 行情渠道的既有模式（`config.ts` 注释 + `app_setting` KV，见迁移 0007）：
**环境变量是「没有运行时配置时」的默认值，运行时配置优先，改完不重启。**

### 6.1 模型配置

```
app_setting.key = 'news.aiConfig'   （单条 JSON，整体读写）
```

```ts
export const NewsAiConfigSchema = z.object({
  baseUrl: z.string().url(),                       // OpenAI 兼容端点根地址
  apiKey: z.string().default(''),                  // 允许空（本地 Ollama 不需要 key）
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.3),
  maxTokens: z.number().int().min(256).max(32_000).default(4000),
  timeoutMs: z.number().int().min(5_000).max(300_000).default(120_000),
  maxInputTokens: z.number().int().default(60_000),   // 预算上限，实际取 0.6 作为输入目标
  dailyLimit: z.number().int().min(1).max(100).default(10),
  enabled: z.boolean().default(true),
});
```

- **默认值来自环境变量**（`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` / `AI_TEMPERATURE` /
  `AI_MAX_TOKENS` / `AI_MAX_INPUT_TOKENS` / `AI_DAILY_LIMIT`），`.env.example` 补齐。
- **`dailyLimit` 是硬护栏**：每天最多 N 次调用（跨 `news_summary` 行按 `date(generated_at)`
  统计），超了返回 `UPSTREAM_UNAVAILABLE` + 「今日 AI 调用已达上限（10/10）」。
  界面上显示剩余次数。这是「个人自用但要克制」的直接落点。
- `enabled = false` → 任务直接跳过，UI 显示「AI 总结已关闭」，信息流不受影响。

### 6.2 提示词库

```
app_setting.key = 'news.prompt.<key>'
```

```ts
export const NewsPromptSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  systemPrompt: z.string().min(1),
  userTemplate: z.string().min(1),
  isDefault: z.boolean(),
  updatedAt: z.string(),
});
```

- 首启写入 3 个内置模板：**每日简报**（默认）、**政策聚焦**（只喂 policy 组 + 更短输出）、
  **周报**（`last7d` + 更长输出）。用户可改、可另存为新模板，**不提供删除默认模板**。
- 生成记录里存 `prompt_key` + `prompt_hash`（system+user 的 sha256 前 8 位）——
  **提示词改了但没重新生成时，UI 能提示「当前简报是用旧提示词生成的」**。
  没有这个字段，「改了提示词但看到的还是旧结果」会变成一个查不出原因的 bug。

### 6.3 配置读写路径

- `GET  /api/tools/news/config` → `{ ai: NewsAiConfigPublic, prompts: NewsPrompt[], usage: {used, limit, date} }`
  —— **`apiKey` 永远以 `hasApiKey: boolean` 下发，不回传明文**（回传也没多大意义，只会让它出现在日志与浏览器里）。
- `PUT  /api/tools/news/config` → 校验 `NewsAiConfigSchema` → 写 `app_setting`
  → 立刻返回新配置（**不重启进程**；service 每次读配置都是从 settings 拿，不做长缓存，
  或缓存 TTL ≤ 5 秒）。
- `PUT  /api/tools/news/prompts/:key` → 校验 `NewsPromptSchema` → 写入。
- `POST /api/tools/news/config/test` → 用当前配置发一次**最小请求**
  （`max_tokens: 16`，`messages: [{role:'user', content:'回复 OK'}]`），
  返回耗时、模型名、原始错误 detail —— 这是配置类功能的刚需：**不测就只能等第二天早上 08:30 才知道配错了**。
  这次测试**计入 `dailyLimit`**（否则它就是个绕过护栏的口子），但单独标 `kind: 'test'` 便于在历史里区分。

---

## 7. 数据模型（迁移 `0012-news.ts`）

```sql
-- 信源运行状态（一个信源一行；轮询节奏与失败退避都在这里）
CREATE TABLE news_source (
  id            TEXT PRIMARY KEY,        -- 'ft.home'
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  category      TEXT NOT NULL,           -- media | opinion | policy | discovery
  weight        INTEGER NOT NULL,
  cadence_sec   INTEGER NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  etag          TEXT,
  last_modified TEXT,                    -- If-Modified-Since 用
  last_fetched_at TEXT,
  next_fetch_at TEXT NOT NULL,
  last_status   INTEGER,                 -- HTTP 状态码
  last_error    TEXT,
  consec_failures INTEGER NOT NULL DEFAULT 0
);

-- 信息流条目（永久累积，按月清理）
CREATE TABLE news_item (
  id            INTEGER PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES news_source(id),
  guid          TEXT,                    -- 上游 <guid> / <entry><id>，可空
  url           TEXT,                    -- canonical URL
  dedup_key     TEXT,                    -- url 为空时的退化去重键
  title         TEXT NOT NULL,
  summary       TEXT,
  published_at  TEXT,                    -- 可空：上游没给就不伪造
  fetched_at    TEXT NOT NULL,
  discovery     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_news_item_url    ON news_item(url)          WHERE url IS NOT NULL;
CREATE UNIQUE INDEX idx_news_item_dedup  ON news_item(dedup_key)    WHERE dedup_key IS NOT NULL;
CREATE INDEX        idx_news_item_pub    ON news_item(published_at DESC);
CREATE INDEX        idx_news_item_source ON news_item(source_id, published_at DESC);
CREATE INDEX        idx_news_item_fetch  ON news_item(fetched_at DESC);

-- AI 配置与提示词（走通用 app_setting KV，不单独建表 —— 见 0007 的理由）

-- 每日抓取任务留痕：把 HTTP 429/403 这类「上游在拒绝我」变成可查询的事实
CREATE TABLE news_fetch_run (
  id           INTEGER PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  ok_feeds     INTEGER NOT NULL DEFAULT 0,
  fail_feeds   INTEGER NOT NULL DEFAULT 0,
  new_items    INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);

-- AI 生成记录（历史多份，UI 取最新）
CREATE TABLE news_summary (
  id            INTEGER PRIMARY KEY,
  window        TEXT NOT NULL,          -- today | yesterday | last7d
  window_start  TEXT NOT NULL,          -- ISO8601
  window_end    TEXT NOT NULL,
  generated_at  TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- scheduled | manual | test
  status        TEXT NOT NULL,          -- success | failed
  model         TEXT,
  prompt_key    TEXT,
  prompt_hash   TEXT,
  payload       TEXT,                   -- 结构化 JSON（NewsSummaryPayload）
  item_count    INTEGER,                -- 送入模型的条数
  dropped_count INTEGER,
  invalid_refs  INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  duration_ms   INTEGER,
  error         TEXT
);
CREATE INDEX idx_news_summary_win ON news_summary(window, generated_at DESC);
CREATE INDEX idx_news_summary_gen ON news_summary(generated_at DESC);
```

**取舍**：

- **`app_setting` 而不是 `news_ai_config` 表**：0007 已经把「运行时配置」做成框架级 KV，
  ETF 渠道切换就是这么做的，理由（不写死在代码、改了不重启、框架不认识业务枚举）逐条成立。
  再开一张表会多一处读写路径，且 `SettingRepository` 已经现成。
- **`news_item` 用两个可空唯一索引而不是一个 `canonical_url` NOT NULL 列**：
  Nikkei/Google News 经常给不出稳定 canonical，硬塞 NOT NULL 只会逼出伪造值。
- **`news_fetch_run` 独立于 `job_run`**：`job_run` 记「任务跑没跑成功」，
  但一次任务里 16 个信源可能 12 成 4 败 —— 任务是 success 的，信源是坏的。
  这张表记的是**信源维度**的健康，与 `news_source.last_status` 互补。
- **不落 `region`/`theme` 之类的派生字段**（对齐 `architecture.md` §5.2 的同类决策）：
  分组来自注册表，每次读时查一次就够。

**清理**：`news.itemRetentionDays` 默认 180 天，由 `news.fetch` 任务顺带删
（`DELETE FROM news_item WHERE fetched_at < ?`），防表无限膨胀。
**AI 生成记录永久保留**（体积小，且是唯一的「历史简报」资产）。

---

## 8. 服务端 API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/tools/news/feed` | 分页信息流：`?range&cat&src&q&cursor&limit`（服务端筛选 + 游标分页） |
| `GET` | `/api/tools/news/sources` | 16 个信源的健康状态（最近抓取、状态码、连续失败、下次抓取） |
| `GET` | `/api/tools/news/summary?window=yesterday` | 最新一份成功简报 + 其引用回填的条目 |
| `GET` | `/api/tools/news/summary/history?window=` | 该窗口的历史（模型、时间、token、状态） |
| `POST` | `/api/tools/news/summaries/generate` | 生成 `{window, promptKey}`，遵守陈旧规则与 `dailyLimit` |
| `GET` | `/api/tools/news/config` | 模型配置（**不含 apiKey 明文**）+ 提示词 + 今日用量 |
| `PUT` | `/api/tools/news/config` | 更新模型配置 |
| `PUT` | `/api/tools/news/prompts/:key` | 更新提示词 |
| `POST` | `/api/tools/news/config/test` | 连通性测试（最小请求，计入日限额） |
| `POST` | `/api/tools/news/refresh` | 手动抓一次全部信源（走调度器，留 `job_run`） |
| `POST` | `/api/tools/news/jobs/fetch/:name/execute` | 按名触发任务（沿用其它工具的手动触发习惯） |

**错误码映射**（复用 `AppError`）：

| 场景 | code | HTTP | detail |
|---|---|---|---|
| 窗口/分组参数非法 | `BAD_REQUEST` | 400 | 原始入参 |
| 简报尚未生成 | `NOT_FOUND` | 404 | 「该窗口还没有生成过简报」 |
| 模型端点超时/5xx/连不上 | `UPSTREAM_UNAVAILABLE` | 503 | 上游原文片段（**必须带 detail**，见 taste：错误要给真实根因） |
| 两次输出都不合法 JSON | `PARSE_FAILED` | 502 | 模型原始输出的前后各 300 字符 |
| 今日调用已达上限 | `UPSTREAM_UNAVAILABLE` | 503 | 「今日 AI 调用已达上限（10/10），明日重置」 |
| 配置未填写 | `BAD_REQUEST` | 400 | 「还没有配置模型地址，请到设置页填写 baseUrl / model」 |

`UPSTREAM_UNAVAILABLE` 复用既有语义（`architecture.md` §7.3「上游不可达」）——
模型端点在本工具里就是上游，不必新增错误码。

---

## 9. 定时任务

| 任务 | cron（Asia/Shanghai） | 说明 |
|---|---|---|
| `news.fetch` | `*/10 * * * *`，`runOnBoot: true` | 只拉 `next_fetch_at <= now` 的信源；写 `news_fetch_run`；顺带做保留期清理 |
| `news.summary` | `30 8 * * *`，`runOnBoot: false` | 生成 `yesterday` 简报；`runOnBoot` **关** —— 服务重启不该白白烧一次调用 |

**为什么 `news.summary` 不 runOnBoot**：`etf.snapshot` 那类任务 runOnBoot 是因为
「库里没数据页面就空白」；简报不一样，它有历史记录可展示，重启后补跑一次纯属浪费配额。
如果某天任务失败了，`/api/health` 会显示最近成功时间，用户可以手动触发。

**任务失败不影响其它任务**（`Scheduler` 已有此保证），`news.summary` 失败时
`job_run` 记 `failed` + 错误信息，前端简报区显示上一次成功的版本并标注
「最近一次自动生成失败：<原因>」。

---

## 10. 前端

### 10.1 页面结构

```
┌──────────────────────────────────────────────────────────────────┐
│ [中文简报] [信息流] [信源] [设置]                    窗口：今日 ▾  │
├──────────────────────────────────────────────────────────────────┤
│  顶部条：2026-09-25 全天 · 187 条（送入模型）/ 214 条（窗口内）     │
│          · 模型 deepseek-v3 · 08:32 生成 · [重新生成] [历史 ▾]    │
│          ⚠ 已从 214 条中抽取 187 条送入模型                        │
├──────────────────────────────────────────────────────────────────┤
│  一句话今日要闻                                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ 🔹 宏观与政策                                               │  │
│  │  · Fed 维持利率不变，官员暗示年内仅降息一次 [12] [18]        │  │
│  │  · ECB 管委称通胀回落进入最后阶段 [34]                       │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │ 🔹 市场与资金   🔹 公司与行业   🔹 亚洲   🔹 风险提示        │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │ 🔹 后续关注（0–5 条，无引用）                                │  │
│  └────────────────────────────────────────────────────────────┘  │
│  免责声明：AI 生成内容，仅作信息整理，不构成投资建议                 │
├──────────────────────────────────────────────────────────────────┤
│ 信息流（切换到该 tab）                                             │
│  筛选：窗口 ▾ | 分组（多选 chips）| 信源（多选）| 搜索[回车]          │
│  ── 2026-09-25 ─────────────────────────────────                 │
│  09:03  CNBC Markets  Fed holds rates steady…        ↗           │
│         The Federal Reserve held its benchmark rate…            │
└──────────────────────────────────────────────────────────────────┘
```

- **引用角标 `[12]` 点击 → 打开该条目的原文链接**（新窗口），而不是抽屉 ——
  引用的目的是核验，直接跳原文比看抽屉更快。
- **英文原文不翻译展示**：信息流保留原标题与摘要原文（用户正是要看英文信源），
  中文只出现在简报里。这一条要写死，否则容易被「顺手加个翻译」侵蚀。
- 信息流列表**不做抽屉**（`architecture.md` §8.1 的抽屉是为基金详情设计的；
  新闻条目就是一行标题 + 一行摘要 + 一个外链，抽屉是多余的交互层级）。
  但**条目行可点开原文**，与其它视图的「可点开」习惯一致。
- 设置页三块：**模型配置**（baseUrl/model/参数 + 「测试连接」）、**提示词编辑**
  （system / user 模板分两个 textarea，变量清单以只读提示条展示）、**用量**
  （今日 x/10、上一次调用的 token 数）。
- 搜索框沿用 **回车提交** 而非实时写 URL（taste 记录的中文输入法问题，其它工具已对齐）。

### 10.2 状态与缓存（TanStack Query）

```ts
// 简报：窗口为 key，长缓存；生成是显式 mutation
useQuery(['news','summary',window], () => api.getSummary(window), { staleTime: 5 * 60_000 })
useMutation(api.generateSummary, { onSuccess: () => queryClient.invalidateQueries(['news','summary']) })

// 信息流：cursor 分页（infinite query），筛选条件进 queryKey
useInfiniteQuery(['news','feed',filters], ...)
```

`dropped > 0`、`invalidRefs > 0`、`promptHash 不匹配当前提示词` —— 三种情况都在顶部
用警示条展示，**不藏在 tooltip 里**（taste：错误要暴露真实根因）。

---

## 11. 成本与规模估算

**信源侧**（§3.2）：≈624 请求/天，单 host 最密 96/天，绝大部分 304。

**条目侧**：16 信源 × 每源每天新增 5–30 条 ≈ **150–400 条/天**，
落库 180 天 ≈ 3–7 万行 —— 单表 + 4 个索引，SQLite 毫无压力，分页查询也快。

**Token 侧**（以送入 187 条为基准）：

| 部分 | 估算 |
|---|---|
| system 提示词 | ~700 |
| 条目清单（187 条 × ~85 token） | ~16,000 |
| 输出（4000 上限，实际约 1200–2000） | ~1,800 |
| **单次合计** | **输入 ~17k / 输出 ~2k** |

日限额 10 次 → 每天最多约 17 万输入 token。
按常见兼容端点的定价（输入 ¥1–8 / 百万、输出 ¥4–16 / 百万）估算，
**每日成本约 ¥0.5–2**，每月 ¥15–60 —— 个人自用可接受，且 `dailyLimit` 是硬上限。

**为什么会超预算**：`maxInputTokens` 默认 60,000，实际目标取 0.6 → 36,000 token，
够装约 400 条。若窗口内超过，按 §5.2 截断并在 UI 标注。**绝不静默截断**。

---

## 12. 测试策略

完全套用 `architecture.md` §10 的分层，新增的部分：

| 层 | 用例 |
|---|---|
| `sources` fixture | 16 个信源的真实响应各一份 → 解析出条目；HTML 摘要剥离；`pubDate` 缺失时 `publishedAt = null`；返回 HTML 挑战页 → 抛 `ParseError`；CDATA / 命名空间 / Atom / RDF |
| `core` 单测 | canonical URL 归一化（跟踪参数、大小写、尾斜杠）；三段式去重降级；**预算截断的确定性**（同输入必得同输出，配额保底生效）；提示词渲染（变量缺失不吐 `{{x}}`）；**引用校验**（越界丢弃、全空标记） |
| `shared` 契约 | `NewsSummaryPayloadSchema` 能吃下「正常 / 缺 section / refs 是字符串 / 枚举外的 id」四类样本 |
| `server` 集成 | `fastify.inject()`：feed 分页与筛选；`summary` 404 语义；**mock 模型端点**验证「第 1 次不合法 → 第 2 次修复成功」与「两次都失败 → `PARSE_FAILED` + detail 含模型原文」；`dailyLimit` 打满后返回 503；`config` 不泄漏 `apiKey` |
| `web` | filters 的 URL 往返；引用角标渲染；失败态展示 detail |

**新增的一条护栏测试**（对应 §13）：

> 断言 `NewsItem` 的 `url` 只能来自信源注册表允许的 host —— 也就是断言
> **没有任何一条测试或代码路径会把请求参数当 URL 发出去**。

**fixture 采集约定**：与现有 fixture 一致，文件头注明采集日期 + 原始 URL。
信源改版时用同一 URL 重采、diff、更新解析逻辑 —— 这是把「别人的 RSS」变成
「可检测资产」的唯一办法（`architecture.md` §10.2）。

**`pnpm smoke` 需要扩一条**：真实起服务 → 打真实 RSS → 断言条目数 > 0 且
`publishedAt` 不全是 null。**AI 调用不进 smoke**（会消耗真实配额，且依赖用户的 key），
改为「配置了 `AI_BASE_URL` 时才跑，否则 skip 并打印跳过原因」。

---

## 13. 安全与合规

| 项 | 做法 |
|---|---|
| **SSRF** | 所有出网 URL 来自硬编码注册表；模型 `baseUrl` 虽是用户配置，但**只允许 http/https**，且只由服务端后台任务与「测试连接」调用，不由任意请求参数驱动 |
| **apiKey 泄漏** | 只存 `app_setting`（本地 SQLite）；API **永不回传明文**；日志不打配置体（`HttpClient` 本来就只记状态码/耗时/体积）；`.gitignore` 已含 `.env` |
| **内容版权** | 只存标题与摘要（RSS 发布者主动提供的字段），**不抓正文**；界面上每条都带原文外链；总结是**重新表述**而非转载；不提供「全文阅读」能力 |
| **聚合器定位** | Google News 条目标 `discovery`，提示词明确禁止其作为事实依据（§3.1、§5.3） |
| **AI 幻觉** | 禁用条目外知识 + 引用必须落到真实条目 + 越界引用丢弃 + UI 标注「AI 生成」+ 免责声明 |
| **成本护栏** | `dailyLimit` 硬上限；修复重试最多 1 次；`maxInputTokens` 预算截断；测试连接也计数 |
| **合规** | 严格遵守调研文档 §1 的边界：不绕登录、付费墙、验证码、站点挑战；403/429 退避并拉长该信源的 `next_fetch_at`，不并发重试放大压力 |
| **网络暴露** | 沿用全站策略：默认 `127.0.0.1`，公网必须反代鉴权 |
| **免责** | 响应带 `disclaimer` 字段，前端固定展示：「AI 生成内容，仅作信息整理，不构成投资建议；事实请以原文为准」 |

---

## 14. 演进路线

| 阶段 | 目标 | 交付 |
|---|---|---|
| **N0 · 信息流** | 「能看」 | 注册表 + 解析 + 去重落库 + `news.fetch` 任务 + 分页 feed 接口 + 前端信息流页 + 信源健康页 |
| **N1 · 单次总结** | 「能读」 | 配置读写 + 提示词库 + 预算组装 + 调用与修复重试 + 引用校验 + 简报渲染 |
| **N2 · 每日自动** | 「不用点」 | `news.summary` cron + 陈旧规则 + 历史版本 + 用量与限额提示 |
| **N3 · 打磨** | 「可靠」 | 保留期清理、更多信源（Economist world、`site:` 定向发现）、导出 markdown、`promptHash` 漂移提示 |
| **N4 · 协议扩展（按需）** | 「换个模型也能用」 | 只有当确实要接非 OpenAI 兼容端点时，才抽出 `ChatProvider` adapter 层 |

**明确不排期**：正文抓取、多轮问答、向量检索、翻译全文、推送告警 —— 前面都写了理由。

---

## 15. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 信源改版 / 返回 HTML 挑战页 | 该信源断供 | fixture 回归 + `ParseError` 显式暴露 + `news_source.last_status/last_error` + 连续失败指数退避（上限 4h）+ 信源健康页可见 |
| 403 / 429 封禁 | 多信源断供 | 全局请求量本就克制（§3.2）+ 条件请求 304 + 单信源退避不波及其它 + 调研文档 §3.2 的「换代理或降级到聚合入口」记为运维手册项 |
| 模型端点不可用 / 超时 | 当天没有简报 | 信息流独立可读（§2）+ `job_run` 留痕 + 手动重试 + 返回上一次成功版本并标注 |
| 模型输出不是合法 JSON | 无简报 | 严格 `json_schema` + 一次修复重试 + `PARSE_FAILED` 带原文片段，**不返回半成品** |
| 模型编造引用 | 点了跳到不存在的条目 | 引用逐个校验、越界丢弃、`invalidRefs` 计数并在 UI 标注 |
| 提示词改了但看到旧结果 | 用户困惑、误以为 bug | `prompt_hash` 入库 + UI 提示「当前简报由旧提示词生成」 |
| Token 超预算 / 成本失控 | 花钱 | `maxInputTokens` 预算截断（并标注丢弃数）+ `dailyLimit` 硬上限 + 修复重试限 1 次 |
| 条目表无限膨胀 | 库变大、查询变慢 | 180 天保留期清理；AI 记录永久保留（小） |
| AI 幻觉被当成事实 | 误导决策 | 禁用条目外知识 + 引用核验 + 免责声明 + `discovery` 不作事实依据 |
| 把「聚合器标题」当原文 | 版权与准确性问题 | `discovery` 标记 + 不合并进原文 + 提示词约束 + 界面上单独分组 |

---

## 16. 实施清单（新增/改动文件）

```
packages/shared/src/news.ts              契约：NewsCategory / 窗口 / 条目 / 简报 payload /
                                          配置与提示词 schema / 各响应 schema
packages/shared/src/index.ts             + export * from './news.ts'
packages/shared/src/tool.ts              + TOOL_CATALOG.news（描述符，前后端同源）
packages/sources/src/feeds/rss.ts        parseFeed（RSS2 / RDF / Atom）+ HTML 剥离
packages/sources/src/feeds/registry.ts   16 个信源的硬编码注册表
packages/sources/src/feeds/index.ts
packages/sources/src/index.ts            + export
packages/sources/test/fixtures/feeds/**  16 份真实响应 fixture
packages/core/src/news/canonicalize.ts   canonical URL + 标题标准化
packages/core/src/news/dedupe.ts         三段式去重
packages/core/src/news/budget.ts         窗口选取 + 配额 + token 预算截断
packages/core/src/news/prompt.ts         模板渲染（纯函数）
packages/core/src/news/citations.ts      引用校验与降级
packages/core/src/index.ts               + export
packages/db/src/migrations/0012-news.ts  四张表
packages/db/src/migrations/index.ts      + 登记
apps/server/src/tools/news/index.ts      createNewsTool（对照 createEtfTool）
apps/server/src/tools/news/routes.ts
apps/server/src/tools/news/service.ts    编排：抓取 / 组装 / 调用 / 校验 / 落库
apps/server/src/tools/news/repository.ts 该工具的 SQL
apps/server/src/tools/news/jobs.ts       news.fetch + news.summary
apps/server/src/tools/news/ai.ts         OpenAI 兼容客户端（唯一出网点）
apps/server/src/tools/news/defaults.ts   内置提示词与默认配置
apps/server/src/tools/news/*.test.ts
apps/server/src/tools/registry.ts        + createNewsTool(options.news)
apps/server/src/contract.test.ts         + news 口径一致性断言
apps/server/src/news-api.test.ts
apps/server/src/config.ts                + AI_* 环境变量
.env.example                             + AI_BASE_URL / AI_API_KEY / AI_MODEL / …
apps/web/src/tools/news/page.tsx         四个 tab：简报 / 信息流 / 信源 / 设置
apps/web/src/tools/news/SummaryView.tsx
apps/web/src/tools/news/FeedList.tsx
apps/web/src/tools/news/SourcesPanel.tsx
apps/web/src/tools/news/SettingsPanel.tsx
apps/web/src/tools/news/filters.ts + filters.test.ts
apps/web/src/tools/registry.ts           + 一行
apps/web/src/lib/api.ts                  + news 相关方法
scripts/smoke.mjs                        + 信息流冒烟（AI 部分条件跳过）
docs/design/news-tool.md                 本文件
README.md                                + 方案文档表与工具清单行
```

按 `architecture.md` §4.5 的检查清单走，**框架文件只改两处注册表**（server + web 各一行）
加一个 `shared` 的描述符 —— 这是「新增工具不改框架」的验收标准。

---

## 附：本方案的三个关键判断

1. **信息流与简报必须是两条独立读路径** —— 这决定了整个工具的可用性下限。
   模型是这一层里**最不可控**的依赖（端点可能挂、配额可能尽、输出可能不合法），
   把它放在读路径的支线上，失败就只是「今天没有简报」，而不是「工具打不开」。

2. **提示词是数据，不是代码** —— 存库、可编辑、带 `prompt_hash`。
   可配置提示词很容易被做成「改代码里的一段字符串」，那样既不满足 N3，
   也会让「改了没生效」变成查不出原因的 bug。hash 入库这一笔是整个配置设计的关键。

3. **预算与引用校验是唯一必须放 `core` 的新算法** —— 抓取是 IO、渲染是 UI，
   但「从 214 条里挑 187 条、每条引用必须指向真实条目」是**口径**，
   必须是可单测的纯函数（`architecture.md` §2.1 原则一）。
   它同时也是成本护栏与幻觉护栏的共同落点。
---

## 17. 实施记录（落地时与本方案的偏差）

实施完成于 2026-09-26，`pnpm verify`（typecheck + lint + 测试，共 746 项）与 `pnpm smoke`
（63/63，真实 RSS）均通过。以下是与上文**不一致或上文没写清楚**的地方，逐条说明理由：

| # | 偏差 | 理由 |
|---|---|---|
| 1 | 实际启用 **15 个**信源，不是 16 个 | §3.1 的名单表是 6+4+5=15，§3.2 的请求量估算行写的是 8+4+6=18（结论又说 16）——**三处互相对不上**。以名单表为准（估算本来就是量级参考），并在 `registry.ts` 注释里留了这段话 |
| 2 | `NewsPromptSchema` 增加 `categories` 字段；下发时补 `promptHash` | 「政策聚焦（只喂 policy 组）」光靠提示词约束做不到，必须**不送进去**才算隔离；`prompt_hash` 入库了但模板对象上没有，前端就无从比对「旧提示词」，因此下发时由服务端现算 |
| 3 | `NewsAiConfigSchema` 的 `baseUrl` / `model` **允许空串** | 「还没配置」是必须能表达的状态：严格 `z.url()` 会让**没配置过的首次 `GET /config` 直接解析失败**，而 §8 又要求「配置未填写 → 400」。空串 = 未配置，生成/测试连接时显式 400 |
| 4 | 手动触发任务的路径是 `POST /jobs/:name/execute` | §8 写的是 `/jobs/fetch/:name/execute`，中间那个 `fetch` 与 `:name` 语义重复（`name` 本身就是 `news.fetch`）。取更短的那个，并在校验里限定只能触发本工具的两个任务 |
| 5 | 信息流排序键是 `COALESCE(published_at, fetched_at)`，并建了对应表达式索引；开放式窗口（today/3d/7d）的**右边界含当刻**（`< now+1ms`） | Nikkei 整个 feed 没有 `pubDate`，兜底排序键取 `fetched_at`。右边界若用 `< now`，刚抓进来的条目会被**自己的窗口**挡在外面（首屏直接少一条，`today` 生成也会误判为「窗口内没条目」） |
| 6 | `core/news` 多了一个 `model.ts`；`shared/news` 多了 `NEWS_SOURCE_IDS` | 沿用本仓库既有约定：`core`/`sources` 不依赖 `shared`，字面量各自维护、`contract.test.ts` 断言逐字相同。前端要**纯函数地**清洗 URL 里的 `src=`（笔误不该让服务端回 400 把信息流打死），所以信源 id 清单也放一份进 `shared` |
| 7 | 抓取失败的 `last_status` **可能是 null** | 网络层失败（DNS/超时）根本没有 HTTP 状态码；此时 `last_error` 有值、`consec_failures` 照常累加、退避照常生效。冒烟断言按「有状态码**或**有错误」写，否则网络受限的环境会误报 |
| 8 | 运维项（对应 §15 的「换代理」）：Node 的 `fetch` **默认不读** `HTTP(S)_PROXY` | 实测本机 `https_proxy` 已设但 Node 直连 FT/Nikkei/SCMP/Economist/Google News 全部 `UND_ERR_CONNECT_TIMEOUT`，而 curl 正常。解法是零代码的：`NODE_USE_ENV_PROXY=1` 启动（Node ≥ 24）。已写进 `.env.example` 与冒烟输出的提示里；**没有**为此在 `HttpClient` 里造一套代理配置——那属于框架变更，不在本工具范围内 |
| 9 | 保留期天数走环境变量 `NEWS_ITEM_RETENTION_DAYS`（默认 180） | §7 写的是 `news.itemRetentionDays`，但它既不是模型配置也不是提示词，没必要进 `app_setting`；与其它框架级参数一致走 `config.ts` |
| 10 | AI 简报**不进默认冒烟**，配置了 `AI_BASE_URL` + `AI_MODEL` 才跑 | §12 的要求：会消耗真实配额且依赖用户的 key；未配置时打印跳过原因而不是静默略过 |

fixture 侧：15 个信源的真实响应 + 3 份合成样例（Atom / HTML 挑战页 / 429 文本）+ `README.md`
（逐条记录采集日期与原始 URL）。采集时 Yahoo Finance 首次返回 **429**、退避后重采成功 ——
这正是 `consec_failures` 与「`next_fetch_at` 翻倍、上限 4 小时」要解决的问题，样例也留了档。

测试覆盖（本方案 §12 的清单）：

- `sources` fixture：15 个信源逐个解析、CDATA/命名空间/HTML 剥离/`pubDate` 缺失为 null、
  HTML 挑战页与 429 文本抛 `ParseError`、残缺条目只跳过并计数、相对链接按 baseUrl 解析；
- `core` 单测：canonical 化（跟踪参数/大小写/尾斜杠/参数排序）、三段式去重降级、
  **预算截断的确定性**与保底/封顶生效、提示词渲染（缺失变量不吐 `{{x}}`）、引用校验（越界丢弃、全空标记）；
- `shared` 契约：`NewsSummaryPayloadSchema` 吃「正常 / 缺 section / refs 是字符串 / 枚举外的 id」四类样本，
  且 JSON schema 与 Zod schema 的必填键一致；
- `server` 集成：feed 分页与筛选、summary 404 语义、**真本地模型端点**验证
  「第一次不合法 → 修复重试成功」「两次都失败 → `PARSE_FAILED` + detail 带模型原文」
  「端点不支持 `response_format` → 自动降级」「5xx/连不上 → 503」、
  `dailyLimit` 打满后 503、`config` 不泄漏 `apiKey`、单信源坏掉不波及其它信源、304 条件请求幂等；
- `web`：筛选的 URL 往返（含非法值清洗）、接口 query 构造；
- `pnpm smoke`：真实起服务 → 打真实 RSS → 条目数 > 0、`publishedAt` 不全是 null、
  摘要无标签、游标分页不重不漏、`config` 无 `apiKey`、未生成时 404。

**SSRF 护栏的验收断言**（§12 最后那条）落在两处：`sources/feeds/registry.test.ts` 断言
`isRegistryUrl` 只认注册表地址（含 `127.0.0.1` 反例），`contract.test.ts` 断言注册表里没有任何
非 https 或本机地址；服务层在每次抓取前再过一遍 `isRegistryUrl`。
