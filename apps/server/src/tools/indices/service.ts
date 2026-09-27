import {
  annualizedVolatility,
  dayChange,
  downsample,
  extremes,
  getIndexDefinition,
  INDEX_CROSS_SOURCE_DRIFT,
  INDEX_DEFAULT_CODE,
  INDEX_MAX_CHART_POINTS,
  INDEX_REGION_KEYS,
  INDEX_REGION_LABELS,
  INDEX_REGISTRY,
  type IndexBar,
  type IndexDefinition,
  type IndexRangeKey,
  intervalChanges,
  latestWeekdayDateInZone,
  sliceRange,
  yearlyStats,
} from '@funds-helper/core';
import type { Db } from '@funds-helper/db';
import {
  type Freshness,
  INDEX_DISCLAIMER,
  type IndexDatasetResponse,
  type IndexIntervalChange,
  type IndexOverviewResponse,
  type IndexQuote,
  type IndexRegionGroup,
  type IndexSummary,
} from '@funds-helper/shared';
import { ParseError, UpstreamError } from '@funds-helper/sources';
import type { FastifyBaseLogger } from 'fastify';
import type { TtlCache } from '../../cache.ts';
import type { AppConfig } from '../../config.ts';
import { AppError } from '../../errors.ts';
import type { IndicesDataSource } from './data-source.ts';
import {
  type IndexBarInput,
  type IndexRecentClose,
  type IndicesRepository,
  rowToBar,
} from './repository.ts';

/**
 * 国际行情工具的服务层：唯一编排 IO 的地方（缓存 → 数据库 → 上游）。
 *
 * 与 fx 的差别只在**多标的**：
 * - fx 只有一条 USD/CNY 序列，缓存 key 是常量；这里按指数分 key（`indices.dataset.{code}`）
 *   + 一个概览 key，切换指数/区间不会打上游；
 * - 新增**跨源新鲜度护栏**：本次抓到的最新收盘与库里另一源的同日收盘偏差 >0.5% 时告警 ——
 *   调研里新浪全球指数「陈旧 feed」就是靠数值比对发现的（报告 §7.1），这道检查防止重蹈覆辙；
 * - 新增**批量实时缺失补齐**（2026-09-27，akshare 线索）：日线四源全挂/从未入库的指数，
 *   概览用东财 clist 单请求补一条报价（不写库，日期按交易所时区推导，见 §14）。
 *
 * 序列统计（区间/年度/极值/波动率）**直接复用 fx 的纯函数**
 * （`core/fx/series.ts`，本质是通用日线统计）；本层只做字段命名映射
 * （`startRate/rate` → `start/value` —— 指数点位不是汇率）。
 */

export interface IndicesCaptureStats {
  /** 本次成功的指数数量 */
  indices: number;
  /** 写入的 K 线总行数 */
  bars: number;
  inserted: number;
  dataDate: string | null;
  failed: { code: string; message: string }[];
  durationMs: number;
}

export interface IndicesServiceDeps {
  db: Db;
  repo: IndicesRepository;
  source: IndicesDataSource;
  cache: TtlCache;
  config: AppConfig;
  logger: FastifyBaseLogger;
  now?: () => number;
}

export interface IndexDatasetOptions {
  code: string;
  range: IndexRangeKey;
  force?: boolean;
}

interface DatasetBase {
  freshness: Freshness;
  bars: IndexBar[];
}

const OVERVIEW_CACHE_KEY = 'indices.overview';
const datasetCacheKey = (code: string): string => `indices.dataset.${code}`;

/**
 * 概览触发补抓时，库里已入库指数少于此**比例**就先同步抓一轮再返回 ——
 * 首访/只抓过个别指数时概览会明显缺块，等一次比返回半截数据好。
 */
const OVERVIEW_SYNC_CAPTURE_MIN_RATIO = 0.5;

/**
 * 后台自动补抓的最小间隔（节流）。
 * `hasMissing` 长期为真是常态（罗素/VIX/恒生科技在稳定源里没有代码），
 * 不加节流会变成每次重建概览都去抓一轮上游。定时任务在服务器常驻时独立刷新，
 * 这里只是交互式访问的兜底。
 */
const AUTO_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;

/** 注册表里必然存在；找不到只可能是编程错误，显式抛 500 而不是 undefined 静默传播 */
function requireDefinition(key: string): IndexDefinition {
  const def = getIndexDefinition(key);
  if (def === undefined) {
    throw new AppError('INTERNAL', `指数注册表缺少 ${key}（请检查 INDEX_REGISTRY）`);
  }
  return def;
}

export class IndicesService {
  private readonly deps: IndicesServiceDeps;
  private readonly now: () => number;
  /** 后台补抓任务：同一时刻只跑一个（dedupe），避免并发请求把上游压力放大 */
  private backgroundRefresh: Promise<unknown> | null = null;
  /** 上一次自动补抓的触发时刻（节流，见 AUTO_REFRESH_MIN_INTERVAL_MS） */
  private lastAutoRefreshAt = 0;

  constructor(deps: IndicesServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // 抓取与落库
  // -------------------------------------------------------------------------

  /** 抓一个指数（四源降级由数据源层编排），带跨源漂移检查与缓存失效 */
  async captureCode(def: IndexDefinition): Promise<{ bars: number; inserted: number }> {
    const since = this.deps.repo.latestBarDate(def.key);
    const result = await this.deps.source.fetchBars(def, { since });

    if (result.bars.length === 0) {
      throw new ParseError(`${def.key}（${def.name}）上游没有返回任何日线数据`);
    }

    // 跨源新鲜度护栏：同一天、不同源、收盘差 >0.5% —— 说明其中一个源陈旧了
    const previous = this.deps.repo.latestBar(def.key);
    const newest = result.bars.at(-1);
    if (
      previous !== null &&
      newest !== undefined &&
      previous.source !== result.source &&
      previous.data_date === newest.date &&
      previous.close > 0
    ) {
      const drift = Math.abs(newest.close - previous.close) / previous.close;
      if (drift > INDEX_CROSS_SOURCE_DRIFT) {
        this.deps.logger.warn(
          {
            code: def.key,
            date: newest.date,
            driftPct: Number((drift * 100).toFixed(2)),
            existing: previous.source,
            incoming: result.source,
          },
          '跨源收盘价偏差超过 0.5%，疑似某个数据源数据陈旧',
        );
      }
    }

    const capturedAt = new Date(this.now()).toISOString();
    const inputs: IndexBarInput[] = result.bars.map((bar) => ({ ...bar }));

    const inserted = this.deps.db.transaction(() => {
      const before = this.deps.repo.countBars(def.key);
      this.deps.repo.upsertBars(def.key, inputs, capturedAt, result.source);
      return this.deps.repo.countBars(def.key) - before;
    });

    this.deps.cache.delete(datasetCacheKey(def.key));
    this.deps.cache.delete(OVERVIEW_CACHE_KEY);
    return { bars: result.bars.length, inserted };
  }

  /**
   * 抓全部指数（定时任务 / 手动刷新）。
   * **部分失败不算失败**：单个指数的上游故障记入 `failed`，其余照常落库 ——
   * 28 个指数里东财缺 4 个、Yahoo 偶发 429，全部成功反而是罕见情况。
   * 只有「一个都没成功」才抛 UpstreamError（让 job_run 记 failed、接口降级）。
   */
  async captureAll(): Promise<IndicesCaptureStats> {
    const startedAt = this.now();
    let ok = 0;
    let bars = 0;
    let inserted = 0;
    let dataDate: string | null = null;
    const failed: { code: string; message: string }[] = [];

    for (const def of INDEX_REGISTRY) {
      try {
        const result = await this.captureCode(def);
        ok += 1;
        bars += result.bars;
        inserted += result.inserted;
        const latest = this.deps.repo.latestBarDate(def.key);
        if (latest !== null && (dataDate === null || latest > dataDate)) dataDate = latest;
      } catch (error) {
        // 只吞上游错误；数据库/编程错误必须原样暴露（500），不能伪装成上游故障
        if (!(error instanceof UpstreamError)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ code: def.key, message });
        this.deps.logger.warn({ code: def.key, err: message }, '指数抓取失败（继续处理其余指数）');
      }
    }

    if (ok === 0) {
      throw new UpstreamError(
        `全部 ${failed.length} 个指数抓取失败：${failed[0]?.message ?? '未知原因'}`,
      );
    }

    const stats: IndicesCaptureStats = {
      indices: ok,
      bars,
      inserted,
      dataDate,
      failed,
      durationMs: this.now() - startedAt,
    };
    this.deps.logger.info({ ...stats, failed: failed.length }, '国际指数日线已更新');
    return stats;
  }

  /**
   * 后台补抓：**不阻塞响应**，抓完由 `captureCode` 顺带失效概览/单指数缓存。
   *
   * 为什么需要它：`hasMissing` 一旦有「稳定源里没有代码」的指数（罗素 2000 / VIX /
   * 恒生科技…）就会**长期为真**，于是每次重建概览都会触发一次全量抓取。
   * 2026-09-27 实测这条同步路径把 `/overview` 卡住约 40 秒（东财 503 重试 × 28 指数 +
   * Yahoo 429 冷却），前端就一直停在「加载指数概览…」。库里已经有可展示的数据时，
   * 正确做法是**先返回 SQLite 快照**，把抓取丢到后台。
   */
  private scheduleBackgroundRefresh(reason: string): void {
    if (this.backgroundRefresh !== null) return;
    if (this.now() - this.lastAutoRefreshAt < AUTO_REFRESH_MIN_INTERVAL_MS) return;
    this.lastAutoRefreshAt = this.now();

    const task = this.captureAll()
      .then((stats) => {
        this.deps.logger.info(
          { ...stats, failed: stats.failed.length, reason },
          '国际指数后台补抓完成',
        );
      })
      .catch((error: unknown) => {
        // 上游故障不是异常：库里仍有数据可展示，只记日志（与概览的降级语义一致）
        this.deps.logger.warn(
          { err: error instanceof Error ? error.message : String(error), reason },
          '国际指数后台补抓失败（继续用本地数据）',
        );
      });

    this.backgroundRefresh = task.finally(() => {
      this.backgroundRefresh = null;
    });
  }

  // -------------------------------------------------------------------------
  // 概览（全部指数的最新收盘与日涨跌）
  // -------------------------------------------------------------------------

  async getOverview(force = false): Promise<IndexOverviewResponse> {
    if (force) this.deps.cache.delete(OVERVIEW_CACHE_KEY);
    return this.deps.cache.getOrBuild(
      OVERVIEW_CACHE_KEY,
      () => this.buildOverview(),
      this.deps.config.memoryCacheTtlSec * 1000,
    );
  }

  private async buildOverview(): Promise<IndexOverviewResponse> {
    const capturedAt = this.deps.repo.latestCapturedAtAny();
    const staleWindowMs = this.deps.config.staleWindowSec * 1000;
    const age =
      capturedAt === null ? Number.POSITIVE_INFINITY : this.now() - Date.parse(capturedAt);

    let stale = false;
    let staleReason: string | undefined;

    // 触发补抓的两个条件（满足其一）：
    // 1. 全局抓取超过 staleWindow；
    // 2. **注册表里有指数从未入库** —— 只看全局 capturedAt 会踩一个真实坑：
    //    用户先打开某一个指数的走势（只抓了那一个），随后进概览时全局年龄还很新，
    //    结果概览只剩 1 个指数。抓过的指数是增量（回看 10 天），代价可忽略。
    const recentsBefore = this.deps.repo.loadRecentCloses();
    const captured = new Set(recentsBefore.map((row) => row.code));
    const hasMissing = INDEX_REGISTRY.some((def) => !captured.has(def.key));
    const ageStale = age > staleWindowMs;

    if (ageStale || hasMissing) {
      // 需要**同步**等抓取的三种情况：
      // - 库里一行都没有（没有可展示的旧数据，抓不到就 503）；
      // - 数据已过陈旧窗口（返回前必须知道抓取成败，才能如实标 stale）；
      // - 库里明显不全（首访只抓过个别指数，等一次好过返回半截概览）。
      // 其余情况 = 库里已有大部分新鲜数据、只是某些指数永远补不上（稳定源没代码）：
      // 先返回 SQLite 快照，抓取放后台 —— 否则每次重建概览都要卡约 40 秒。
      const materiallyIncomplete =
        captured.size < INDEX_REGISTRY.length * OVERVIEW_SYNC_CAPTURE_MIN_RATIO;
      if (recentsBefore.length === 0 || ageStale || materiallyIncomplete) {
        try {
          await this.captureAll();
        } catch (error) {
          if (!(error instanceof UpstreamError)) throw error;
          const message = error instanceof Error ? error.message : String(error);
          // 关键降级：宁可返回「陈旧但真实」的收盘数据，也不返回错误页。
          // 「一行都没有」时不立刻 503 —— 先尝试下面的批量实时补齐，全空才 503
          // （实战动机：2026-09-27 东财 K 线 + Yahoo 双故障，clist 仍活）。
          stale = true;
          staleReason = message;
          this.deps.logger.warn({ err: message }, '指数抓取失败，回退到本地日线');
        }
      } else {
        this.scheduleBackgroundRefresh('部分指数从未入库，本地已有新鲜数据');
      }
    }

    // 每个指数取最新两根收盘 → 日涨跌（各市场休市节奏不同，日期必须逐条展示）
    const recents = this.deps.repo.loadRecentCloses();
    const byCode = new Map<string, IndexRecentClose[]>();
    for (const row of recents) {
      const list = byCode.get(row.code);
      if (list) list.push(row);
      else byCode.set(row.code, [row]);
    }

    const quotesByKey = new Map<string, IndexQuote>();
    for (const def of INDEX_REGISTRY) {
      const rows = byCode.get(def.key);
      const latest = rows?.[0];
      if (latest === undefined) continue; // 从未抓到过（一直失败）的指数不进概览
      const previous = rows?.[1];

      const change =
        previous === undefined || previous.data_date === latest.data_date
          ? null
          : latest.close - previous.close;
      quotesByKey.set(def.key, {
        code: def.key,
        name: def.name,
        currency: def.currency,
        price: latest.close,
        prevClose: previous?.close ?? null,
        change,
        changePct:
          change === null || previous === undefined || previous.close === 0
            ? null
            : (change / previous.close) * 100,
        date: latest.data_date,
        source: latest.source,
        open: latest.open,
        high: latest.high,
        low: latest.low,
      });
    }

    // ---- 批量实时缺失补齐（best-effort）----
    // 只补**库里没有**的指数（日线全链路失败/首次加载），不覆盖库里已有行情 ——
    // 实时值不是收盘价，覆盖会污染区间/年度统计；库里数据永远优先。
    const missingDefs = INDEX_REGISTRY.filter((def) => !quotesByKey.has(def.key));
    const liveSources = new Set<string>();
    const filledKeys: string[] = [];
    if (missingDefs.length > 0) {
      try {
        const live = await this.deps.source.fetchLiveQuotes(missingDefs);
        for (const item of live) {
          const def = getIndexDefinition(item.key);
          if (def === undefined || quotesByKey.has(item.key)) continue;
          quotesByKey.set(item.key, {
            code: def.key,
            name: def.name,
            currency: def.currency,
            price: item.price,
            prevClose: item.prevClose,
            change: item.change,
            changePct: item.changePct,
            // clist 没有交易日期字段：按交易所时区推导「最近交易日」（周末回退周五）；
            // 节假日会标错日期，只影响未入库指数的卡片、日线恢复后自愈（见 session.ts）
            date: latestWeekdayDateInZone(this.now(), def.timeZone),
            source: item.source,
            open: item.open,
            high: item.high,
            low: item.low,
          });
          liveSources.add(item.source);
          filledKeys.push(item.key);
        }
        if (filledKeys.length > 0) {
          this.deps.logger.info(
            { codes: filledKeys, missed: missingDefs.length - filledKeys.length },
            '概览用批量实时补齐了缺失指数的报价',
          );
        }
      } catch (error) {
        // 批量实时只是兜底：失败不影响概览返回库里数据
        this.deps.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          '批量实时补齐失败（概览照常返回本地数据）',
        );
      }
    }

    // 本地无数据 + 抓取失败 + 批量实时也失败/没补上 → 才走到 503
    if (quotesByKey.size === 0) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        '上游接口不可用，且本地还没有任何指数数据（可稍后点「重新抓取上游」重试）',
        staleReason,
      );
    }

    const regions: IndexRegionGroup[] = [];
    for (const key of INDEX_REGION_KEYS) {
      const items: IndexQuote[] = [];
      for (const def of INDEX_REGISTRY) {
        if (def.region !== key) continue;
        const quote = quotesByKey.get(def.key);
        if (quote) items.push(quote);
      }
      if (items.length > 0) regions.push({ key, label: INDEX_REGION_LABELS[key], items });
    }

    const dataDate = [...quotesByKey.values()].reduce<string | null>(
      (max, quote) => (max === null || quote.date > max ? quote.date : max),
      null,
    );
    const sources = this.deps.repo.latestSources();
    for (const source of liveSources) {
      if (!sources.includes(source)) sources.push(source);
    }

    return {
      regions,
      freshness: {
        dataDate,
        fetchedAt: this.deps.repo.latestCapturedAtAny() ?? new Date(this.now()).toISOString(),
        stale,
        ...(staleReason === undefined ? {} : { staleReason }),
        source: sources.length > 0 ? sources.join('+') : this.deps.source.name,
      },
      disclaimer: INDEX_DISCLAIMER,
    };
  }

  // -------------------------------------------------------------------------
  // 单指数数据集（走势 + 统计）
  // -------------------------------------------------------------------------

  async getDataset(options: IndexDatasetOptions): Promise<IndexDatasetResponse> {
    const def = getIndexDefinition(options.code) ?? requireDefinition(INDEX_DEFAULT_CODE);
    const cacheKey = datasetCacheKey(def.key);
    if (options.force === true) this.deps.cache.delete(cacheKey);

    const base = await this.deps.cache.getOrBuild(
      cacheKey,
      () => this.buildBase(def),
      this.deps.config.memoryCacheTtlSec * 1000,
    );
    return this.derive(def, base, options.range);
  }

  private async buildBase(def: IndexDefinition): Promise<DatasetBase> {
    const staleWindowMs = this.deps.config.staleWindowSec * 1000;
    const capturedAt = this.deps.repo.latestCapturedAt(def.key);
    const hasData = this.deps.repo.latestBarDate(def.key) !== null;
    const age =
      capturedAt === null ? Number.POSITIVE_INFINITY : this.now() - Date.parse(capturedAt);

    let stale = false;
    let staleReason: string | undefined;

    if (age > staleWindowMs) {
      try {
        await this.captureCode(def);
      } catch (error) {
        // 只有上游故障才降级；数据库/编程错误原样暴露（500）
        if (!(error instanceof UpstreamError)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (!hasData) {
          throw new AppError(
            'UPSTREAM_UNAVAILABLE',
            `${def.name}暂无本地数据，且上游抓取失败（可稍后点「重新抓取上游」重试）`,
            message,
          );
        }
        stale = true;
        staleReason = message;
        this.deps.logger.warn({ code: def.key, err: message }, '指数抓取失败，回退到本地日线');
      }
    }

    const bars = this.deps.repo.loadBars(def.key).map(rowToBar);
    if (bars.length === 0) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        `${def.name}暂无本地数据（可稍后点「重新抓取上游」重试）`,
      );
    }

    return {
      freshness: {
        dataDate: bars.at(-1)?.date ?? null,
        fetchedAt: capturedAt ?? new Date(this.now()).toISOString(),
        stale,
        ...(staleReason === undefined ? {} : { staleReason }),
        source: this.deps.repo.latestBar(def.key)?.source ?? this.deps.source.name,
      },
      bars,
    };
  }

  /** 纯函数派生：区间裁剪/抽稀 → 统计（复用 fx 的序列函数，只做字段命名映射） */
  private derive(
    def: IndexDefinition,
    base: DatasetBase,
    range: IndexRangeKey,
  ): IndexDatasetResponse {
    const bars = base.bars;
    const last = bars.at(-1);
    if (last === undefined) {
      throw new AppError('UPSTREAM_UNAVAILABLE', `${def.name}暂无本地数据`);
    }

    // 极值取未抽稀的区间序列；抽稀只影响「图」，不影响「数」
    const ranged = sliceRange(bars, range);
    const rangeExtremes = extremes(ranged);
    const allExtremes = extremes(bars);
    const change = dayChange(bars);

    const toExtreme = (item: { date: string; rate: number } | null) =>
      item === null ? null : { date: item.date, value: item.rate };

    const intervals: IndexIntervalChange[] = intervalChanges(bars).map((item) => ({
      key: item.key,
      label: item.label,
      from: item.from,
      to: item.to,
      start: item.startRate,
      end: item.endRate,
      change: item.change,
      changePct: item.changePct,
    }));

    const summary: IndexSummary = {
      latest: { date: last.date, value: last.close },
      previous: change === null ? null : toExtreme(change.previous),
      dayChange: change?.change ?? null,
      dayChangePct: change?.changePct ?? null,
      rangeHigh: toExtreme(rangeExtremes.high),
      rangeLow: toExtreme(rangeExtremes.low),
      allTimeHigh: toExtreme(allExtremes.high),
      allTimeLow: toExtreme(allExtremes.low),
      annualizedVolatility: annualizedVolatility(bars),
      totalBars: bars.length,
      firstDate: bars[0]?.date ?? last.date,
      lastDate: last.date,
    };

    return {
      code: def.key,
      name: def.name,
      currency: def.currency,
      timeZone: def.timeZone,
      range,
      points: downsample(ranged, INDEX_MAX_CHART_POINTS),
      intervals,
      yearly: yearlyStats(bars),
      summary,
      freshness: base.freshness,
      disclaimer: INDEX_DISCLAIMER,
    };
  }
}
