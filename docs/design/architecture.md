# funds-helper 技术架构设计方案

> 定位：个人使用的**基金理财工具箱**。一个可持续扩展的工具箱外壳 + 若干独立工具，
> 第一个工具是 QDII 基金额度查询。
>
> 本文只讨论**架构**。第一个工具的业务细节见 [`qdii-tool.md`](./qdii-tool.md)，
> 上游接口结论见 [`qdii-data-sources.md`](./qdii-data-sources.md)。

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 | 说明 |
|---|---|---|
| G1 | **可扩展的工具箱外壳** | 新增一个工具 = 新增一个目录切片 + 注册一行，不改动框架代码 |
| G2 | 前后端类型贯通 | 上游字段、领域模型、API 响应、前端消费共用一套类型定义，改字段时编译器能指出所有受影响处 |
| G3 | 数据可累积 | 上游没有额度历史接口，时间序列只能靠自己落库；这是相对 `qdii-helper` 的核心增量价值 |
| G4 | 上游故障可降级 | 上游不可达时回退到最近一次落库数据，并明确标注「数据陈旧」，不静默出错 |
| G5 | 本地与服务器双跑 | 本地 `pnpm dev` 热更新开发；服务器 Docker 常驻 + 定时抓取 |
| G6 | 单人可维护 | 技术栈统一、无隐藏魔法、关键决策有文档；依赖数量克制 |

### 1.2 非目标

- ❌ **不做下单交易** —— 只做信息聚合与决策辅助
- ❌ **不做净值预测 / 盘中估值** —— 旧估值接口已失效（见 `qdii-data-sources.md` §11）
- ❌ **不做多用户 / 账号体系** —— 个人自用，无鉴权（服务器部署时用反向代理或内网兜底）
- ❌ **不引入付费数据源**（Tushare / Wind 等）
- ❌ **不追求高可用** —— 单实例、单机 SQLite 即可；不做集群、不做读写分离

---

## 2. 总体架构

### 2.1 架构原则

1. **领域逻辑与框架解耦**：归一化、归类、排序等规则是**纯函数**，放在 `packages/core`，
   不依赖 Fastify、不依赖数据库、不依赖 React。这样规则可以被服务端任务、API、前端、
   测试以完全相同的方式调用，避免出现第二套口径（`qdii-helper` 的 P0/P1 共用同一模块，正是这个原则的体现）。
2. **IO 与计算分离**：`core` 只做计算，`sources` 只做 IO，`db` 只做持久化。三者依赖方向单向。
3. **契约先行**：跨包、跨前后端的类型与校验规则用 Zod 定义在 `packages/shared`，
   它是**单一事实来源**；服务端用它校验输入，前端用它解析响应。
4. **失败要显式**：上游改版、解析异常必须抛出结构化错误，绝不静默返回空数据。
5. **默认克制**：对上游的请求频率、并发、重试都有硬约束（见 §6.1）。

### 2.2 分层与依赖方向

```
┌──────────────────────────────────────────────────────────────────┐
│                          apps/web (React)                        │
│   路由 / 布局 / 工具页面 / 通用组件 / API Client                    │
└───────────────────────────────┬──────────────────────────────────┘
                                │ HTTP JSON（类型来自 shared）
┌───────────────────────────────▼──────────────────────────────────┐
│                        apps/server (Fastify)                     │
│   路由 / 校验 / 错误处理 / 定时任务 / 静态资源                       │
└───────┬───────────────────────────────────────────────┬──────────┘
        │                                               │
┌───────▼──────────────┐  ┌──────────────────┐  ┌───────▼──────────┐
│   packages/sources   │  │  packages/core   │  │   packages/db    │
│  上游适配器（IO）      │  │  领域逻辑（纯）    │  │  SQLite 仓储      │
│  http / eastmoney    │  │  normalize/class │  │  schema/migrate  │
└──────────────────────┘  └──────────────────┘  └──────────────────┘
        │                         ▲                     ▲
        │                         │                     │
        │                  ┌──────┴─────────────────────┴──────┐
        └─────────────────▶│        packages/shared            │
                           │  类型契约 / Zod schema / 工具元数据  │
                           └───────────────────────────────────┘
```

**依赖规则（用 ESLint/Biome 的 `no-restricted-imports` 强制）**：

| 包 | 允许依赖 | 禁止依赖 |
|---|---|---|
| `shared` | 仅 `zod` | 其余一切 |
| `core` | `shared` | `sources` / `db` / 任何框架 |
| `sources` | `shared` | `core` / `db` / 任何 Web 框架 |
| `db` | `shared` | `sources` / `core` / 任何 Web 框架 |
| `apps/server` | 以上全部 + Fastify | `react` |
| `apps/web` | `shared` + React 生态 | `sources` / `db` / Fastify |

`apps/web` 不得直接依赖 `core` 的**上游相关**逻辑：前端只消费服务端已经归一化好的数据，
保证「一个口径」。若确有纯展示需要的规则（如排序），从 `shared` 取。

### 2.3 仓库结构（monorepo）

```
funds-helper/
├─ package.json                  # 根：脚本编排、共享 devDependencies
├─ pnpm-workspace.yaml
├─ tsconfig.base.json            # 共享编译选项 + path alias
├─ biome.json                    # lint + format 一把梭
├─ .env.example
├─ docker-compose.yml
├─ Dockerfile
├─ docs/
│  └─ design/                    # 方案目录（本目录）
│     ├─ architecture.md
│     ├─ qdii-tool.md
│     └─ qdii-data-sources.md
│
├─ apps/
│  ├─ server/                    # Fastify 后端
│  │  ├─ src/
│  │  │  ├─ index.ts             # 进程入口：读配置 → 建 app → listen
│  │  │  ├─ app.ts               # 组装 Fastify 实例（可被测试注入）
│  │  │  ├─ plugins/             # 横切能力
│  │  │  │  ├─ db.ts             # 注入 Db
│  │  │  │  ├─ http.ts           # 注入 Httpx（限流/重试的上游客户端）
│  │  │  │  ├─ cache.ts          # 注入进程内 TTL 缓存
│  │  │  │  ├─ scheduler.ts      # 注入任务调度器
│  │  │  │  ├─ errors.ts         # 统一错误处理
│  │  │  │  └─ static.ts         # 生产环境托管 web 构建产物
│  │  │  ├─ routes/
│  │  │  │  ├─ health.ts         # /api/health
│  │  │  │  ├─ tools.ts          # /api/tools（工具清单）
│  │  │  │  └─ index.ts
│  │  │  └─ tools/               # 工具的服务端切片
│  │  │     ├─ registry.ts       # 工具注册表（唯一的"新增工具要改的文件"）
│  │  │     └─ qdii/
│  │  │        ├─ index.ts       # ServerTool 定义：descriptor + register + jobs
│  │  │        ├─ service.ts     # 用例编排：拉取 → 归一化 → 落库 → 组装响应
│  │  │        ├─ repository.ts  # 该工具的 SQL（基于 db 包）
│  │  │        └─ jobs.ts        # 定时任务定义
│  │  └─ test/
│  │
│  └─ web/                       # React 前端
│     ├─ index.html
│     ├─ vite.config.ts          # dev 时 /api 代理到 server
│     └─ src/
│        ├─ main.tsx
│        ├─ app/
│        │  ├─ router.tsx
│        │  ├─ layout/           # 侧边栏 + 顶栏 + 内容区
│        │  └─ home.tsx          # 工具箱首页（工具卡片墙）
│        ├─ components/          # 跨工具通用组件
│        ├─ lib/                 # api client / 格式化 / hooks
│        └─ tools/               # 工具的前端切片
│           ├─ registry.ts       # 工具注册表
│           └─ qdii/
│              ├─ page.tsx       # 路由入口（懒加载）
│              ├─ filters.tsx
│              ├─ fund-table.tsx
│              └─ fund-drawer.tsx
│
└─ packages/
   ├─ shared/                    # 类型契约（前后端共享）
   │  └─ src/
   │     ├─ tool.ts              # ToolDescriptor / 健康状态
   │     ├─ money.ts             # 金额/币种/限额的可空语义类型
   │     └─ envelope.ts          # API 响应信封（data / meta / disclaimer）
   ├─ core/                      # 领域逻辑（纯函数）
   │  └─ src/
   │     ├─ qdii/
   │     │  ├─ model.ts          # FundLimit 等核心模型
   │     │  ├─ normalize.ts      # 限额哨兵 / 币种 / 状态归一化
   │     │  ├─ classify.ts       # 地区 × 主题 双维度归类规则
   │     │  └─ sort.ts           # 排序与分档
   │     └─ fund/
   │        └─ code.ts           # 基金代码校验等通用规则
   ├─ sources/                   # 上游数据源适配器
   │  └─ src/
   │     ├─ http.ts              # 带限流/重试/超时/编码处理的 HTTP 客户端
   │     ├─ errors.ts            # UpstreamError / ParseError
   │     └─ eastmoney/
   │        ├─ purchase-snapshot.ts   # 接口 A
   │        ├─ fund-detail.ts         # 接口 B
   │        ├─ notices.ts             # 接口 D
   │        ├─ fund-list.ts           # 接口 E
   │        ├─ quote.ts               # 接口 F
   │        ├─ pingzhong.ts           # 接口 G
   │        ├─ period-increase.ts     # 接口 H
   │        └─ holdings.ts            # 接口 I
   └─ db/                        # SQLite 持久化
      └─ src/
         ├─ client.ts            # node:sqlite 连接 + PRAGMA + 事务
         ├─ migrate.ts           # 版本化迁移执行器
         ├─ backup.ts            # 迁移前备份
         ├─ migrations/          # 迁移 SQL（按 id 升序）
         └─ repositories/        # 框架级仓储（工具专属 SQL 放各自 tools/ 下）
```

**关于包数量的取舍**：4 个包（`shared` / `core` / `sources` / `db`）是**按依赖方向真实存在
的边界**划分的，不是为了分层而分层。若某个包长期只有几十行，允许合并回 `apps/server`
（例如 `db` 若始终只被 server 使用，可降级为 `apps/server/src/db/`），但 `shared` 必须独立，
因为前端要消费它。

---

## 3. 技术选型

### 3.1 选型总表

| 层次 | 选型 | 版本策略 | 理由 |
|---|---|---|---|
| 语言 | **TypeScript**（strict） | 最新稳定 | 前后端同语言，类型贯通（G2） |
| 包管理 | **pnpm workspaces** | 最新稳定 | workspace 原生、硬链接省盘、依赖隔离严格 |
| 后端框架 | **Fastify** | 5.x | 插件模型天然贴合「工具即插件」；内置 pino 日志与 schema 校验；比 Express 快且 API 更现代 |
| 校验/契约 | **Zod** | 最新稳定 | 一套 schema 同时产出运行时校验与 TS 类型（G2）；可对接 Fastify type provider |
| 前端框架 | **React** | 19.x | 生态最厚，图表/表格库齐全 |
| 构建 | **Vite** | 最新稳定 | 冷启动快、HMR 好、配置少 |
| 路由 | **React Router** | 7.x | 稳定、文档全；工具页面天然是嵌套路由 |
| 服务端状态 | **TanStack Query** | 5.x | 缓存/重取/失效/加载态全部托管，省掉手写请求状态机 |
| 样式 | **Tailwind CSS** | 4.x | 无 CSS 命名负担，深色模式与响应式成本极低 |
| UI 原语 | **Radix UI**（按需） | 最新稳定 | 无样式、可访问性好（抽屉/弹层/下拉），不自建轮子 |
| 表格 | **TanStack Table** | 8.x | 无头表格，排序/筛选/列控制逻辑与渲染解耦 |
| 图表 | **ECharts** | 5.x | 金融时间序列/双轴/回撤填充/缩放成熟；中文文档友好 |
| 数据库 | **SQLite** + **`node:sqlite`**（Node 内置） | Node ≥ 22.6 | 单文件、零运维；用内置模块省掉原生编译（见 D6） |
| 持久化实现 | **手写 SQL + 版本化迁移** | — | SQL 不复杂，ORM 的抽象成本大于收益（见 D6） |
| 任务调度 | **croner** | 最新稳定 | 轻量、无 Redis 依赖、支持时区；单实例场景足够 |
| 日志 | **pino**（Fastify 内置） | — | 结构化 JSON 日志，零额外集成 |
| 测试 | **Vitest** + **fastify.inject** | 最新稳定 | 单元/集成统一；`inject` 免监听端口即可测路由 |
| E2E（可选） | **Playwright** | 最新稳定 | 关键路径（筛选→详情→分享链接）冒烟 |
| Lint/Format | **Biome** | 最新稳定 | 一个工具替代 ESLint+Prettier，配置极简、速度极快 |
| 容器 | **Docker** 多阶段构建 | — | 单镜像同时托管 API 与前端静态资源（G5） |

### 3.2 关键决策记录（为什么这样选）

**D1 · 为什么不用 tRPC 而用 REST + Zod**

`tRPC` 能自动贯通类型，但它把前后端绑成一个不可分割的整体，且外部（curl、脚本、
未来的 CLI/定时任务）无法直接消费。本工具箱强调「工具可生长」，未来很可能出现
脚本或第三方消费同一份 API。选择 **REST + 共享 Zod schema**：服务端用 schema 校验出入参，
前端用同一个 schema 解析响应，同样获得端到端类型安全，但 API 保持通用。
若后续确认永远不会外部消费，再迁移到 tRPC 的成本也很低（service 层无需改动）。

**D2 · 为什么用 SQLite 而不是继续用 JSON 文件缓存**

`qdii-helper` 用 JSON 文件做 30 分钟 TTL 缓存，对「查当前额度」够用，但**无法回答
「这只基金上个月限购多少、什么时候变的」**，而上游没有额度历史接口（G3）。
SQLite 是单文件、零运维、可 SQL 查询的最小持久化方案。不选 PostgreSQL：个人自用引入
独立数据库服务的运维成本远超收益（非目标 §1.2）。

**D3 · 为什么用进程内缓存 + SQLite，而不是只用其中一个**

两者职责不同，缺一不可：

| 层 | 作用 | 典型 TTL |
|---|---|---|
| 进程内内存缓存 | 挡住高频读（页面反复刷新、前端每次筛选），避免重复反序列化 | 30 分钟 |
| SQLite | 持久化快照与时间序列；上游故障时作为降级数据源 | 永久累积 |
| 上游接口 | 唯一事实来源 | 由任务刷新 |

**D4 · 为什么定时任务默认只在服务器开启**

「本地开发 + 服务器常驻」双跑时，若两边都跑任务，会对上游产生双倍请求，也可能
两边同时写同一个 SQLite 文件（本地与服务器路径不同，实际不冲突，但请求是浪费的）。
因此任务由环境变量 `JOBS_ENABLED` 控制：**本地默认 `false`，服务器 `true`**。
本地开发改为按需手动触发（`POST /api/tools/qdii/refresh`）。

**D5 · 为什么上游解析全部基于固定 fixture 做测试**

上游是非官方接口，随时可能改版。**录一次真实响应存成 fixture，之后所有解析逻辑都用
fixture 测试**——这样上游真改版时，测试会立刻失败并指出改了什么，而不是等到线上
静默出错。这是本方案里**投入产出比最高的一条工程实践**（见 §10.2）。

**D6 · 用 Node 内置 `node:sqlite`，不用 better-sqlite3 + Drizzle**（实施期调整）

原方案选的是 `better-sqlite3` + Drizzle ORM。实施时实测 Node 26 已内置 `node:sqlite`
（`DatabaseSync` / `StatementSync` / `backup`），于是改为**内置模块 + 手写 SQL**：

| 维度 | better-sqlite3 + Drizzle | node:sqlite + 手写 SQL |
|---|---|---|
| 原生编译 | 需要（新 Node ABI 常缺预编译包） | **零编译** |
| 依赖数量 | 2 个运行时依赖 | **0 个** |
| 类型安全 | ORM 推导 | 表 → 行类型手写，SQL 显式可读 |
| 迁移 | drizzle-kit 生成 | 手写版本化 SQL + 迁移执行器（约 40 行） |

本项目 SQL 不复杂（7 张表、以 upsert 与单表查询为主），ORM 带来的抽象成本大于收益。
取舍点：若日后出现大量多表连接与动态查询，再引入 Drizzle 的成本也不高（仓储层是唯一的改动面）。

**D7 · 不设构建步骤：直接运行 TypeScript 源码**（实施期新增）

Node ≥ 22.6 可原生执行 TS（strip-only 模式），配合 `exports` 指向 `./src/index.ts`，
**packages 与 server 都不需要编译**：`node src/index.ts` 即生产运行方式，
`tsc --noEmit` 只做类型检查。收益：没有构建产物、没有 stale dist、改完即生效。

代价与对策：strip-only 模式**只支持可擦除语法**（不支持构造函数参数属性、`enum`、
`namespace`）。vitest 走 esbuild 能跑通这类语法，于是会出现「测试全绿但 `node` 起不来」。
对策是在 `tsconfig.base.json` 打开：

```jsonc
"erasableSyntaxOnly": true   // 让 tsc 直接拒绝不可擦除语法
```

并在 §10.4 增加一个**跑真实 Node 运行时的冒烟脚本**（`pnpm smoke`）。事实上有两个真实缺陷
正是这一步发现的（见 §10.4），这类缺口靠单元测试永远暴露不出来。

**D8 · 上游解析：行级宽松、结构级严格**（实施期新增）

首次跑真实上游时，解析器因**一行**「基金类型」为空串（`028912`）而整批 27538 行失败。
结论：脏数据是真实存在的，**个别行残缺不该让整个数据集失败**。

- **行级宽松**：只要求「基金代码」存在；其余字段缺失留空，由 core 的业务口径过滤
- **结构级严格**：**列数变化**才是「上游改版」的信号，仍然立刻抛 `ParseError`
- 跳过的行数计入 meta 并写日志，不静默吞掉

---

## 4. 工具插件机制（可扩展性的核心）

工具箱的扩展性完全落在「新增一个工具要改什么」这个问题上。目标是：
**新增工具只需新增目录 + 在注册表加一行，不改动任何框架代码。**

### 4.1 工具的描述契约（`packages/shared/src/tool.ts`）

描述符是**前后端共享的元数据**，服务端用它生成 `/api/tools`，前端用它生成导航与卡片墙：

```ts
import { z } from 'zod';

export const ToolDescriptorSchema = z.object({
  id: z.string(),                    // 'qdii'，用于路由与 API 前缀，全局唯一
  name: z.string(),                  // 'QDII 额度'
  summary: z.string(),               // 一句话说明
  question: z.string(),              // 该工具回答的用户问题（用于首页卡片）
  status: z.enum(['ready', 'beta', 'planned']),
  version: z.string(),               // 工具自身版本，便于单独演进
  dataFreshness: z.enum(['realtime', 'daily', 'ondemand']),  // 决定顶栏如何提示时效
  tags: z.array(z.string()).default([]),
});

export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;
```

### 4.2 服务端工具契约

```ts
import type { FastifyInstance } from 'fastify';
import type { ToolDescriptor } from '@funds-helper/shared';

/** 框架注入给工具的上下文：工具只依赖这些能力，不直接 new 任何全局单例 */
export interface ToolContext {
  db: Db;                 // packages/db
  httpx: Http;            // packages/sources 的受限客户端
  cache: TtlCache;        // 进程内缓存
  logger: Logger;
  config: AppConfig;
}

export interface JobDefinition {
  /** 任务名，全局唯一，如 'qdii.snapshot' */
  name: string;
  /** 标准 cron 表达式（5 段），按 config.timezone 解释 */
  cron: string;
  /** 空闲时是否立即跑一次（服务重启后尽快有数据） */
  runOnBoot?: boolean;
  handler: (ctx: ToolContext) => Promise<JobResult>;
}

export interface ServerTool {
  descriptor: ToolDescriptor;
  /** 注册该工具的 HTTP 路由，prefix 由框架统一加为 /api/tools/{id} */
  register(app: FastifyInstance, ctx: ToolContext): Promise<void>;
  /** 该工具需要的定时任务 */
  jobs?: JobDefinition[];
}
```

### 4.3 前端工具契约

```ts
import type { ComponentType, LazyExoticComponent } from 'react';
import type { ToolDescriptor } from '@funds-helper/shared';

export interface WebTool {
  descriptor: ToolDescriptor;
  /** 懒加载的页面组件，框架统一挂在 /tools/{id} 下 */
  page: LazyExoticComponent<ComponentType>;
  /** 可选：详情页（若工具需要独立 URL 表达选中项，如 /tools/qdii/:code） */
  detailPage?: LazyExoticComponent<ComponentType>;
}
```

### 4.4 注册表（唯一需要手改的「框架文件」）

刻意**不使用** `import.meta.glob` 之类的自动发现：显式注册能获得完整的类型检查与
「这个工具被谁引用」的可追踪性，代价只是每次加一行。

```ts
// apps/server/src/tools/registry.ts
import { qdiiTool } from './qdii';
// import { xxxTool } from './xxx';     // ← 新增工具只加这一行

export const SERVER_TOOLS: ServerTool[] = [qdiiTool];
```

```ts
// apps/web/src/tools/registry.ts
export const WEB_TOOLS: WebTool[] = [
  { descriptor: qdiiTool.descriptor, page: lazy(() => import('./qdii/page')) },
];
```

> **注意**：前端注册表里的 `descriptor` 必须与服务端一致。做法是让描述符定义在
> `packages/shared` 的 `TOOL_CATALOG` 常量里，两端都从这里取，而不是各自手写一份。
> 服务端启动时做一次一致性断言，防止两处漂移。

### 4.5 新增一个工具的检查清单

1. `packages/shared` 里登记 `ToolDescriptor`（若工具需要跨端类型，一并加）
2. `packages/core` 加纯领域逻辑（可选）
3. `packages/sources` 加上游适配器（可选，若复用已有数据源则跳过）
4. `apps/server/src/tools/<id>/` 实现 `register` 与 `jobs`
5. `apps/web/src/tools/<id>/` 实现页面，前端注册表加一行
6. 两处注册表各加一行
7. 加测试：core 单测 + sources fixture 解析测试 + 路由集成测试

---

## 5. 数据架构

### 5.1 三层数据流

```
       上游（天天基金 / 东方财富，非官方）
                 │  sources/ 适配器按需拉取，带限流与重试
                 ▼
   ┌──────────────────────────────┐
   │  定时任务：拉取 → 归一化 → 落库  │   core/ 归一化（纯函数）
   └──────────────┬───────────────┘
                  ▼
        ┌─────────────────┐
        │     SQLite      │  永久累积：快照、变更事件、公告、行情
        └────────┬────────┘
                 ▼
        ┌─────────────────┐
        │  进程内 TTL 缓存  │  TTL 内直接命中，不打上游也少打 DB
        └────────┬────────┘
                 ▼
             API 响应（携带数据日期与新鲜度）
```

**读路径的分级降级**（关键设计）：

```
请求数据 →
  1) 内存缓存命中且未过期（TTL 30 min）      → 返回（stale: false）
  2) 内存未命中 → 读 SQLite 最新快照
        ├─ 快照 fetchedAt 在 staleWindow 内   → 回填内存缓存 → 返回（stale: false）
        └─ 快照超过 staleWindow              → 走 3)
  3) 触发一次上游拉取
        ├─ 成功 → 归一化 → 落库 → 回填缓存 → 返回（stale: false）
        └─ 失败 → 回退到 SQLite 中最近一次快照 → 返回（stale: true + staleReason）
```

**绝不返回空数据**：只要库里有过数据，宁可返回「陈旧但真实」的快照，也不返回错误页。

### 5.2 数据表设计

通用表（框架级，与具体工具无关）：

```sql
-- 任务执行日志：任何任务失败都能被看到，而不是只留在日志文件里
CREATE TABLE job_run (
  id           INTEGER PRIMARY KEY,
  job_name     TEXT NOT NULL,
  started_at   TEXT NOT NULL,          -- ISO8601（含时区）
  finished_at  TEXT,
  status       TEXT NOT NULL,          -- running | success | failed
  duration_ms  INTEGER,
  stats        TEXT,                   -- JSON：本次处理条数等
  error        TEXT
);
CREATE INDEX idx_job_run_name_time ON job_run(job_name, started_at DESC);
```

QDII 工具专属表：

```sql
-- 基金主数据（随快照更新，用于搜索联想与稳定展示名）
CREATE TABLE qdii_fund (
  code           TEXT PRIMARY KEY,      -- 6 位代码
  name           TEXT NOT NULL,
  fund_type      TEXT NOT NULL,
  currency       TEXT NOT NULL,         -- CNY | USD | HKD
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL
);

-- 额度快照（时间序列的核心表）
-- 唯一键 (code, data_date)：上游是日频数据，同一天多次抓取只保留最新一次
CREATE TABLE qdii_limit_snapshot (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL REFERENCES qdii_fund(code),
  data_date      TEXT NOT NULL,         -- 上游数据日期 YYYY-MM-DD（来自 showday[0]）
  captured_at    TEXT NOT NULL,         -- 本地抓取时刻 ISO8601
  status         TEXT NOT NULL,         -- 开放申购 | 限大额 | 暂停申购 | 场内交易 | ...
  redeem_status  TEXT NOT NULL,
  daily_limit    REAL,                  -- NULL = 无限额（哨兵值已在归一化阶段消灭）
  min_purchase   REAL,
  next_open_date TEXT,
  nav            REAL,
  nav_date       TEXT,
  fee            TEXT,
  UNIQUE (code, data_date)
);
CREATE INDEX idx_snapshot_code_date ON qdii_limit_snapshot(code, data_date DESC);
CREATE INDEX idx_snapshot_limit     ON qdii_limit_snapshot(daily_limit);

-- 额度变更事件（由相邻两次快照 diff 推导，是「趋势图 / 告警」的数据基础）
CREATE TABLE qdii_limit_change (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL,
  data_date     TEXT NOT NULL,          -- 变更对应的数据日期
  detected_at   TEXT NOT NULL,
  field         TEXT NOT NULL,          -- daily_limit | status | redeem_status | min_purchase
  old_value     TEXT,
  new_value     TEXT
);
CREATE INDEX idx_change_code_date ON qdii_limit_change(code, data_date DESC);

-- 申购类公告（接口 D，type=5）
CREATE TABLE qdii_notice (
  id            TEXT PRIMARY KEY,       -- 上游公告 ID，天然幂等键
  code          TEXT NOT NULL,
  title         TEXT NOT NULL,
  publish_date  TEXT NOT NULL,
  category      TEXT
);
CREATE INDEX idx_notice_code_date ON qdii_notice(code, publish_date DESC);

-- 场内折溢价（接口 F，时间序列）
CREATE TABLE qdii_premium (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL,
  captured_at   TEXT NOT NULL,
  price         REAL,
  discount_rate REAL,                   -- 负值 = 溢价
  UNIQUE (code, captured_at)
);

-- 基金详情缓存（接口 B/G/H/I 的原始结构化结果，按 code 缓存，避免频繁打上游）
CREATE TABLE qdii_detail_cache (
  code          TEXT PRIMARY KEY,
  fetched_at    TEXT NOT NULL,
  payload       TEXT NOT NULL           -- JSON
);
```

**设计取舍**：

- **不落 `region` / `theme`**：归类规则是纯函数且可能随上游改名而调整（`qdii-helper`
  明确留了「规则需更新」的演进路径）。落库会把派生值固化成需要回填的脏数据。
  735 行数据在内存里归类是微秒级，每次读时计算即可。
- **快照唯一键用 `(code, data_date)` 而不是 `captured_at`**：上游日频，
  一天抓 48 次只有最后一次有意义；否则时间序列会被重复点淹没。
- **变更事件独立成表**：不要在查询时对快照表做窗口函数推导趋势——那是读放大。
  变更在写入快照的同一事务里算好，读的时候直接查。
- **金额字段可空 + 语义显式**：`daily_limit = NULL` 表示「无限额」，
  归一化阶段就把 1e10/1e11 哨兵值消灭掉，下游不必再写 `if (x >= 1e8)`。
  这与 `qdii-helper` 的 `FundLimit.daily_limit: float | None` 是同一决策。

### 5.3 数据新鲜度契约（所有响应强制携带）

任何一个返回上游数据的响应都**必须**带上这段 meta，前端固定展示，避免用户基于过期数据决策：

```ts
export const FreshnessSchema = z.object({
  dataDate: z.string().nullable(),   // 上游数据日期（如 '2026-09-14'）
  fetchedAt: z.string(),             // 本地抓取时刻
  stale: z.boolean(),                // true = 上游拉取失败，返回的是旧快照
  staleReason: z.string().optional(),// 陈旧原因（用于前端提示）
  source: z.string(),                // 'eastmoney'
});
```

前端顶栏固定展示：`数据日期 2026-09-14 · 12 分钟前更新`；`stale` 时转为警示色并显示原因。

### 5.4 迁移策略

- 用**版本化 SQL 迁移**（`packages/db/src/migrations/`，按 id 升序执行），提交进仓库
- 服务启动时**自动执行未应用的迁移**（个人自用，不需要人工运维步骤）
- 迁移前自动备份：把 `data/funds.db` 复制为 `data/funds.db.bak.{timestamp}`（保留最近 5 份）
- PRAGMA 基线：`journal_mode=WAL`（读写并发）、`foreign_keys=ON`、`busy_timeout=5000`
- 应用层设置 `data` 目录权限为当前用户，容器内挂载 volume

---

## 6. 上游数据源层

### 6.1 HTTP 客户端约束（`packages/sources/src/http.ts`）

对非官方接口必须保持克制，把这些约束收敛在**一个**客户端里，业务代码无法绕过：

| 约束 | 取值 | 理由 |
|---|---|---|
| 超时 | 连接 5s / 整体 60s | 接口 A 约 4 MB，需要宽裕的整体超时 |
| 并发上限 | 每个 host 2 | 避免对上游造成压力 |
| 同 host 最小间隔 | 300ms | 同上 |
| 重试 | 最多 2 次，指数退避 1s/2s + 抖动 | 只重试网络错误与 5xx，4xx 不重试 |
| 请求头 | 每数据源独立配置 `User-Agent` / `Referer` | 接口 A/D/G 对 `Referer` 有要求 |
| 编码 | 统一按 `utf-8-sig` 解码（接口 E 带 BOM） | 否则首个字符会变成 `\uFEFF` |
| 体积上限 | 单响应 16 MB 硬上限 | 防止上游异常返回把内存打爆 |
| 主备切换 | 接口 F 主域名超时自动切备用域名 | `push2` 偶发超时，`push2delay` 稳定 |

**不做自动高频重试，不做后台轮询兜底**：宁可返回陈旧数据，也不放大请求量。

### 6.2 适配器契约

每个适配器 = **一个函数 + 一个输出类型 + 一组 fixture**：

```ts
export interface Adapter<TOut> {
  /** 唯一标识，用于日志、限流分组与 fixture 命名 */
  id: string;
  /** 人类可读的上游说明，出现在错误信息里 */
  upstream: string;
  fetch(client: Http, params: Params): Promise<TOut>;
}
```

适配器**只负责「把上游响应变成结构化对象」**，不负责归一化业务语义
（例如「1e11 是无限额」属于 `core` 的职责，不属于 `sources`）。
这条边界让 fixture 测试非常单纯：输入固定文本 → 断言结构化输出。

### 6.3 解析容错原则

1. **不做整体 JSON 解析**（接口 A 的响应不是合法 JSON，外层 key 无引号）——
   按 `qdii-data-sources.md` §2.4 的方式截取 `datas` 数组
2. **结构校验前置**：解析后断言关键结构（如每行必须 13 列、`record` 必须存在），
   不符立刻抛 `ParseError` 并附上实际结构，而不是让脏数据流到下游
3. **JS 文本按块解析**（接口 G 的 `pingzhongdata`）——逐 `var` 块截取，非 JSON 块跳过
4. **时区显式**：上游时间戳是北京时间零点，必须按 UTC+8 换算日期，否则差一天
5. **每块独立容错**（详情聚合接口）：某一块失败只影响对应区块，其余照常返回，
   错误写进响应的 `errors[]`（对应 `qdii-helper` 的 `_fund_extra` 设计）

---

## 7. 服务端设计

### 7.1 请求处理链路

```
HTTP 请求
  → Fastify 路由（schema 校验：入参用 shared 的 Zod schema）
  → 工具 service 层（用例编排：读缓存 → 读库 → 必要时打上游）
  → core 领域函数（归一化 / 归类 / 排序）
  → 组装响应信封（data + freshness + disclaimer）
  → 统一错误处理（UpstreamError → 503，校验失败 → 400，未找到 → 404）
```

**service 层是唯一编排 IO 的地方**。路由只做「校验入参 + 调 service + 返回」，
不允许在路由里直接调上游或写 SQL。

### 7.2 路由约定

| 路径 | 说明 |
|---|---|
| `GET /api/health` | 存活 + 依赖状态（DB 可写、最近任务执行时间） |
| `GET /api/tools` | 工具清单（由注册表生成，前端据此渲染导航与首页） |
| `GET /api/tools/:id/...` | 工具专属路由，由各 `ServerTool.register` 挂在各自 prefix 下 |

QDII 工具的路由示例：

| 路径 | 说明 |
|---|---|
| `GET /api/tools/qdii/dataset` | 全量数据集（735 只 + 统计 + 分类计数），**一次返回，前端本地筛选** |
| `GET /api/tools/qdii/funds/:code` | 单只详情（实时字段 + 净值走势 + 阶段收益 + 持仓 + 公告） |
| `GET /api/tools/qdii/premium` | 场内折溢价排行 |
| `GET /api/tools/qdii/changes` | 额度变更记录（新能力，`qdii-helper` 没有） |
| `POST /api/tools/qdii/refresh` | 手动触发一次快照拉取（本地开发与排障用） |

**为什么 dataset 一次全量返回**：735 条记录对浏览器是小数据量（gzip 后约 20 KB），
换来的是零延迟筛选。每次点筛选都发请求既慢又浪费上游配额——这个结论直接继承
`qdii-helper` 的实测经验。**阈值约定**：单工具数据集超过约 5 万行时，该工具改为
服务端分页 + 筛选，`dataset` 模式不适合。

### 7.3 错误模型（统一响应）

```ts
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(['BAD_REQUEST', 'NOT_FOUND', 'UPSTREAM_UNAVAILABLE', 'PARSE_FAILED', 'INTERNAL']),
    message: z.string(),      // 面向用户的中文说明
    detail: z.string().optional(), // 面向排障的细节（上游原文片段等）
  }),
});
```

| 错误码 | HTTP | 触发场景 |
|---|---|---|
| `BAD_REQUEST` | 400 | Zod 校验失败（如基金代码非 6 位数字） |
| `NOT_FOUND` | 404 | 基金不存在 / 非 QDII |
| `UPSTREAM_UNAVAILABLE` | 503 | 上游不可达且无可用快照降级 |
| `PARSE_FAILED` | 502 | 上游响应结构不符（可能已改版），**必须显式暴露** |
| `INTERNAL` | 500 | 兜底 |

### 7.4 定时任务

| 任务 | 频率 | 说明 |
|---|---|---|
| `qdii.snapshot` | 每 30 分钟 | 接口 A 全量拉取 → 归一化 → upsert 快照 → 计算变更事件 |
| `qdii.premium` | 交易时段每 30 分钟 | 场内折溢价，仅在 A 股交易时段执行 |
| `qdii.notices` | 每日 1 次（收盘后） | 拉取自选/关注基金的 `type=5` 公告 |
| `fund.catalog` | 每日 1 次 | 全量基金列表（搜索联想用） |

**任务实现要点**：

- **幂等**：任务可安全重复执行（靠 `(code, data_date)` 唯一键与 `notice.id` 主键）
- **单实例互斥**：同一任务重入时直接跳过（进程内 `Set<string>` 记录运行中任务）
- **执行留痕**：每次执行写 `job_run`，`/api/health` 暴露最近一次成功时间
- **失败隔离**：单个任务失败不影响其他任务与 HTTP 服务
- **时区**：所有 cron 按 `Asia/Shanghai` 解释，`TZ` 环境变量固定，避免净值日期错位

### 7.5 配置管理

配置用 **环境变量 + `.env`**，启动时用 Zod 校验（`apps/server/src/config.ts`），
缺关键项直接启动失败而不是运行期报错：

```ts
export const AppConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().default(8787),
  dbPath: z.string().default('./data/funds.db'),
  timezone: z.string().default('Asia/Shanghai'),
  jobsEnabled: z.coerce.boolean().default(false),   // 本地默认关，服务器开
  logLevel: z.enum(['fatal','error','warn','info','debug','trace']).default('info'),
  upstreamTimeoutMs: z.coerce.number().default(60_000),
  upstreamConcurrency: z.coerce.number().default(2),
  upstreamMinIntervalMs: z.coerce.number().default(300),
  // 数据新鲜度
  memoryCacheTtlSec: z.coerce.number().default(1800),
  staleWindowSec: z.coerce.number().default(6 * 3600), // 超过则视为需刷新
});
```

---

## 8. 前端设计

### 8.1 结构与布局

```
┌────────────────────────────────────────────────────────────┐
│ 顶栏：工具箱名 · 数据日期/更新时刻 · 全局刷新 · 深色模式切换    │
├──────────┬─────────────────────────────────────────────────┤
│ 侧边栏    │                                                 │
│          │              工具内容区                          │
│ ▸ 首页    │   （由 /tools/:id 路由渲染对应工具页面）           │
│ ▸ QDII 额度│                                                │
│ ▸ …      │                                                 │
│          │                                                 │
├──────────┴─────────────────────────────────────────────────┤
│ 免责声明（全站固定，随数据展示）                                │
└────────────────────────────────────────────────────────────┘
```

- 路由：`/`（工具卡片墙）→ `/tools/qdii`（列表）→ `/tools/qdii/:code`（详情）
- 详情用**抽屉（Drawer）**呈现（与 `qdii-helper` 一致），但**同时同步 URL**，
  使链接可分享、刷新可复现；点击链接可直达某只基金

### 8.2 数据获取策略

```ts
// 数据集：一次拉全量，长缓存，手动刷新才失效
const dataset = useQuery({
  queryKey: ['qdii', 'dataset'],
  queryFn: () => api.getQdiiDataset(),
  staleTime: 10 * 60_000,
  gcTime: 60 * 60_000,
});

// 详情：不在列表接口里预取，按需拉取（对应上游 4 个接口聚合）
const detail = useQuery({
  queryKey: ['qdii', 'fund', code],
  queryFn: () => api.getQdiiFund(code),
  enabled: !!code,
  staleTime: 10 * 60_000,
});
```

- **筛选/排序/搜索全部在客户端完成**（继承 `qdii-helper` 的实测结论）
- 筛选条件写入 URL query（`?region=纳斯达克100,美国&theme=医药生物&status=可买`），
  可分享、可收藏、可刷新复现
- 响应解析用 `shared` 的 Zod schema，上游字段漂移时前端会明确报错而非静默渲染空白

### 8.3 状态管理

**不引入 Redux / Zustand**。三类状态各有归属：

| 状态类型 | 归属 | 例子 |
|---|---|---|
| 服务端数据 | TanStack Query | 数据集、详情、溢价 |
| 可分享的筛选条件 | URL searchParams | 地区/主题/状态/额度/搜索词 |
| 纯本地 UI 状态 | `useState` | 抽屉开关、深色模式、列显隐 |

### 8.4 组件与视觉

- **通用组件**（跨工具复用）：`DataTable`（基于 TanStack Table）、`Drawer`、
  `FilterGroup`（多选筛选）、`MoneyText`（按币种格式化金额）、
  `FreshnessBadge`（数据新鲜度）、`Disclaimer`、`EmptyState`、`ErrorState`
- **金额展示必须走 `MoneyText`**：`null` 显示「无限额」，美元/港币显示对应单位，
  统一由一处决定，避免各页面各写一套格式化
- **深色模式**：Tailwind `dark:` + `prefers-color-scheme`，手动切换持久化到 localStorage
- **响应式**：≥1024px 侧边栏常驻；<768px 侧边栏折叠为抽屉，表格横向滚动
- **键盘**：`/` 聚焦搜索框，`Esc` 关闭抽屉（保留 `qdii-helper` 的既有习惯）

---

## 9. 部署与运行

### 9.1 本地开发

```bash
pnpm install
cp .env.example .env            # 本地默认 JOBS_ENABLED=false
pnpm dev                        # 并行启动 server(:8787) + web(:5173，/api 代理到 server)
```

- Vite 把 `/api` 代理到 `127.0.0.1:8787`，前端无需处理跨域
- 本地不跑定时任务；需要新鲜数据时点「刷新」或 `POST /api/tools/qdii/refresh`

### 9.2 服务器部署（Docker）

```bash
docker compose up -d --build
```

- **单阶段镜像**（而非原方案的多阶段）：既然服务端不需要构建（D7），
  也就没有需要剥离的构建工具链，多阶段的收益只剩「剔除 devDependencies」，
  不值得为此引入 pnpm 孤立 node_modules 跨阶段拷贝的复杂度。Dockerfile 里只做三件事：
  装依赖 → 构建前端 → 直接跑 TS 源码
- **单容器同时提供 API 与前端静态资源**（`@fastify/static`），无需额外 Nginx
- SQLite 文件通过 volume 挂载到宿主（`./data:/app/data`），容器重建不丢历史
- 服务器 `.env`：`JOBS_ENABLED=true`、`HOST=0.0.0.0`、`TZ=Asia/Shanghai`
- `HEALTHCHECK` 打 `/api/health`
- **无鉴权**：仅内网/局域网使用；若需公网访问，必须在前置反向代理加 HTTP Basic Auth
  或 VPN（README 与 `.env.example` 都要写明）

> **实施状态**：`Dockerfile` / `docker-compose.yml` 已落地，但**开发机没有 docker，
> 镜像构建未经验证**。基础镜像 tag、入口命令、环境变量与 volume 路径均已逐一核对；
> 已实际验证的生产路径是 `pnpm build && pnpm start`（服务端托管前端产物 + SPA 回退，
> 见 §10.4 冒烟脚本）。首次 `docker compose up` 需要人工确认一次。

仓库根目录的 [`docker-compose.yml`](../../docker-compose.yml) 是实际使用的文件（非示意）。

### 9.3 环境变量清单

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8787` | 监听地址 |
| `DB_PATH` | `./data/funds.db` | SQLite 文件路径 |
| `TZ` | `Asia/Shanghai` | 进程时区，影响净值日期与 cron |
| `JOBS_ENABLED` | `false`（服务器设 `true`） | 是否启用定时任务 |
| `SERVE_STATIC` | `true`（`pnpm dev` 设为 `false`） | 是否托管前端构建产物；开发时关掉，避免看到上一次 build 的旧前端 |
| `WEB_DIST_PATH` | `apps/web/dist` | 前端构建产物目录 |
| `LOG_LEVEL` | `info` | pino 日志级别 |
| `UPSTREAM_TIMEOUT_MS` | `60000` | 上游整体超时 |
| `UPSTREAM_CONCURRENCY` | `2` | 上游并发上限 |
| `UPSTREAM_MIN_INTERVAL_MS` | `300` | 同 host 最小请求间隔 |
| `MEMORY_CACHE_TTL_SEC` | `1800` | 进程内缓存 TTL |
| `STALE_WINDOW_SEC` | `21600` | 超过此窗口的快照视为需刷新 |

---

## 10. 测试策略

### 10.1 分层

| 层 | 工具 | 重点 |
|---|---|---|
| `core` 单元测试 | Vitest | 归一化边界、币种优先级、归类规则顺序与覆盖率、排序 |
| `sources` 解析测试 | Vitest + **fixture** | 上游各类响应形态（含异常与 BOM）→ 结构化输出 |
| `db` 迁移与仓储测试 | Vitest + 内存 SQLite | 迁移可重复执行、唯一键幂等、快照 diff 正确 |
| `server` 集成测试 | Vitest + `fastify.inject()` | 路由校验、错误码、降级路径（上游故障时返回 stale） |
| `web` 逻辑测试 | Vitest + Testing Library | 筛选/排序/URL 同步（移植 `qdii-helper` 的 `test_web_logic.mjs` 思路） |
| E2E 冒烟（可选） | Playwright | 「打开 → 筛选 → 打开详情 → 复制分享链接 → 新窗口复现」 |

### 10.2 Fixture 库（本方案的核心资产）

```
packages/sources/test/fixtures/
├─ eastmoney/
│  ├─ purchase-snapshot/
│  │  ├─ normal.js.txt          # 接口 A 真实响应（截取若干行）
│  │  ├─ missing-datas.js.txt   # 结构缺失 → 必须抛 ParseError
│  │  └─ column-changed.js.txt  # 列数变更 → 必须抛 ParseError
│  ├─ pingzhong/
│  │  ├─ 270042.js.txt          # 含非 JSON 块的混合内容
│  │  └─ bom.js.txt             # 带 BOM
│  └─ …
└─ README.md                    # 记录每个 fixture 的采集日期与来源 URL
```

**约定**：每个 fixture 文件头部注释里记录**采集日期**与**原始 URL**。
上游改版时，用同一 URL 重新采集、diff 后更新解析逻辑——这是把「非官方接口」
变成「可测试资产」的唯一办法。

### 10.3 回归护栏（把 `design.md §9 失败模式` 固化成测试）

| 护栏 | 断言 |
|---|---|
| QDII 口径 | 用 fixture 数据断言 QDII 数量 ≥ 500，跌破则测试失败（标签可能已变更） |
| 归类覆盖率 | 断言无基金落入兜底类以外的未分类状态，且兜底类占比不超过预期上限 |
| 限额哨兵 | 断言 `1e10` / `1e11` / `9999999999` 均归一化为 `null` |
| 币种优先级 | 断言「人民币」优先于「美元」（如 `中银美元债…人民币A` 判为 CNY） |
| 时区 | 断言上游时间戳 `1344960000000` → `2012-08-15`（UTC+8） |
| 口径一致性 | 断言 core 的领域枚举与 shared 的传输枚举逐字相同（`apps/server/src/contract.test.ts`） |
| 脏行容错 | 断言字段残缺的真实行（`028912` 基金类型为空）不会让整批解析失败 |

### 10.4 真实运行时冒烟（`pnpm smoke`）

**必须有这一步，且不能并入 `pnpm verify`** —— 两者的取舍正好相反：

| | `pnpm verify` | `pnpm smoke` |
|---|---|---|
| 运行方式 | vitest（esbuild 转译） | **真实 `node`（strip-only 转译）** |
| 数据源 | fixture / 替身，离线 | **真实上游**，需联网 |
| 速度 | 秒级 | 数十秒（含一次 4MB 拉取） |
| 目的 | 逻辑正确性 | **运行时能否真的起来 + 端到端能否真的通** |

`scripts/smoke.mjs` 会：起一个临时库的服务 → 等 `/api/health` → 打真实上游 →
逐项校验（数据集总数、**双维度归类无遗漏**、样例基金、详情、溢价、错误码、SPA 回退、
重复抓取幂等）→ 关服务并清理临时库。19 项检查，失败即非零退出。

**这不是形式主义**：实施期它抓出了两个单元测试全绿却真实存在缺陷：

1. **构造函数参数属性**在 strip-only 模式下不被支持 —— 服务一启动就崩，
   而 229 项测试全部通过。根因是「测试与生产用了不同的转译器」。
   永久对策是 `erasableSyntaxOnly`（D7），冒烟脚本是第二道网。
2. **`setNotFoundHandler` 重复注册** —— 托管前端静态资源时与错误处理插件冲突，
   服务启动即抛错。集成测试用 `serveStatic: false`，因此完全没覆盖到这条路径。

---

## 11. 质量与规范

- **TypeScript strict**：`strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + **`erasableSyntaxOnly`**（见 D7）
- **Biome**：lint + format 一个工具；CI 与 `pnpm check` 均执行
- **依赖方向强制**：用 Biome 的 `noRestrictedImports` 落实 §2.2 的规则
- **提交前**：`pnpm verify` = `typecheck && lint && test`（后续接 pre-commit hook）
- **命名**：包名统一 `@funds-helper/*`；数据库表按 `<tool>_<entity>` 前缀，框架表无前缀
- **注释**：只在「为什么」不明显处写注释（尤其是上游坑点），不写复述代码的注释
- **错误信息**：面向用户的 message 用中文且可行动；detail 保留上游原文片段便于排障

---

## 12. 可观测性

个人自用项目不需要 Prometheus/Grafana，但要能回答三个问题：

| 问题 | 载体 |
|---|---|
| 上游还好吗？ | `job_run` 表 + `/api/health` 暴露各任务最近成功时间 |
| 数据新鲜吗？ | 每个响应的 `freshness` 字段 + 前端顶栏徽标 |
| 哪里出错了？ | pino 结构化日志（含 `reqId`、`tool`、`adapter`、上游耗时） |

**日志纪律**：上游响应**不整体打日志**（接口 A 有 4 MB），只记状态码、耗时、
体积、以及解析失败时的**片段**（前后各 200 字符）。

---

## 13. 安全与合规

| 项 | 做法 |
|---|---|
| 上游合规 | 非官方接口，低频访问（≥30 分钟）、并发 ≤2、禁商业分发；频率约束由 `Http` 客户端强制 |
| 免责声明 | 「仅供参考，实际限额以基金公司最新公告为准」——数据端点返回 `disclaimer` 字段，前端固定展示 |
| 数据日期 | 所有数据响应携带 `dataDate`，界面固定展示，防止误用过期数据 |
| 网络暴露 | 默认绑定 `127.0.0.1`；公网必须加反向代理鉴权或走 VPN |
| 依赖安全 | 定期 `pnpm audit`；上游 URL 全部硬编码，不接受外部传入 URL（防 SSRF） |
| 输入校验 | 所有入参 Zod 校验（基金代码必须是 6 位数字） |
| 容器 | 非 root 用户运行；volume 仅挂载 data 目录 |

---

## 14. 演进路线

| 阶段 | 目标 | 交付 |
|---|---|---|
| **M0 · 骨架** | 跑通「工具箱外壳」 | monorepo + 4 包 + 工具注册机制 + `/api/tools` + 前端布局与首页卡片墙 + 一个占位的 qdii 页面 |
| **M1 · QDII 功能对齐** | 追平 `qdii-helper` 的能力 | dataset/fund/premium 三组接口 + 双维度筛选 + 详情抽屉（购买建议/净值/收益/持仓）+ 场内溢价页 |
| **M2 · 落库与时间序列** | 兑现相对 `qdii-helper` 的增量 | SQLite 迁移 + 快照任务 + 变更事件 + **额度变更时间线 / 趋势图**（新能力） |
| **M3 · 关注与提醒** | 从「查询工具」到「主动服务」 | 自选列表 + 额度放宽/收紧检测 + 站内提醒（可选：本地通知） |
| **M4 · 第二个工具** | 验证扩展性 | 用 §4.5 清单落地一个新工具；据此修正插件契约 |
| **M5 · 打磨** | 日常可用 | 移动端适配、E2E、部署脚本、备份策略 |

**关键校验点**：M4 是架构的真正验收——如果新增第二个工具需要改动框架代码，
说明插件边界没划对，应回到 §4 修正契约。

---

## 15. 从 `qdii-helper` 迁移对照

| `qdii-helper` 资产 | 处置 | 落点 |
|---|---|---|
| `docs/api.md` 接口调研 | **迁移**（转语言无关） | `docs/design/qdii-data-sources.md` |
| `docs/design.md` 业务规则 | **迁移** | `docs/design/qdii-tool.md` |
| `is_qdii` / `parse_currency` / `normalize_limit` | **重写为 TS 纯函数** | `packages/core/src/qdii/normalize.ts` |
| 归类规则表（地区/主题 + 顺序） | **原样迁移规则，重写实现** | `packages/core/src/qdii/classify.ts` |
| 排序与额度分档 | **重写** | `packages/core/src/qdii/sort.ts` |
| 接口 A~I 的解析逻辑 | **重写为适配器 + fixture 测试** | `packages/sources/src/eastmoney/*` |
| `qdii_web.py`（HTTP 服务） | **替换** | `apps/server`（Fastify） |
| `web/index.html` + `app.js` + `style.css` | **重写** | `apps/web`（React + Vite） |
| JSON 文件缓存（30 min TTL） | **替换为三层** | 内存缓存 + SQLite + 上游 |
| CLI（`qdii_limit.py`） | **暂不迁移** | 后续可作为 `apps/cli` 消费同一 API，或直接调 `core` |
| 现有测试用例（归一化 + 前端逻辑） | **移植为 Vitest** | `core` 与 `web` 测试 |

**明确保留不动的结论**（避免重复踩坑）：上游接口选型、QDII 双标签口径、
限额哨兵阈值、币种优先级、归类规则顺序、数据集一次全量返回、`f402` 的溢价语义。

---

## 16. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 上游改版 / 字段漂移 | 解析失败，数据断供 | fixture 回归测试（§10.2）+ 结构校验前置 + `PARSE_FAILED` 显式暴露 + 覆盖率护栏 |
| 上游不可达 / 限流 | 无数据 | 三层降级（§5.1），返回陈旧快照并标注 `stale`；退避重试 |
| 单机 SQLite 损坏 | 历史丢失 | WAL + 迁移前自动备份（保留 5 份）+ volume 挂载；数据可由上游重建（除时间序列） |
| 时间序列出现空洞 | 趋势图失真 | 任务幂等 + `job_run` 留痕 + `/api/health` 暴露「最近成功时间」，前端标出缺口 |
| 时区错位 | 净值日期差一天 | 全进程 `TZ=Asia/Shanghai` + 显式 UTC+8 换算 + 单测断言 |
| 工具箱过度设计 | 维护成本 > 收益 | 包边界按真实需要划分，允许合并（§2.3）；非目标清单（§1.2）严格守住 |
| 无鉴权被公网访问 | 数据与配额暴露 | 默认绑 `127.0.0.1`；公网必须加反代鉴权（§13） |

---

## 附：本方案的三个关键判断

1. **`core` 必须是纯函数包** —— 它是「一个口径」的唯一保证，也是本方案里最容易
   被侵蚀的边界（一旦有人在里面 `import` 了数据库或 Fastify，可测试性与复用性同时崩掉）。
2. **Fixture 是新代码库里最重要的测试资产** —— 面对非官方接口，只有固定样本
   才能把「上游不可控」变成「上游可检测」。
3. **M4（第二个工具）才是架构的验收点** —— 第一个工具无论怎么设计都能跑通，
   真正的可扩展性要在第二个工具落地时验证。
