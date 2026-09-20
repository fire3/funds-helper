import {
  annualizedVolatility,
  convertBar,
  dayChange,
  downsample,
  extremes,
  FX_DIRECTIONS,
  FX_MAX_CHART_POINTS,
  type FxBar,
  type FxDirection,
  type FxRangeKey,
  intervalChanges,
  sliceRange,
  yearlyStats,
} from '@funds-helper/core';
import type { Db } from '@funds-helper/db';
import {
  type Freshness,
  FX_DISCLAIMER,
  type FxDatasetResponse,
  type FxSummary,
} from '@funds-helper/shared';
import { ParseError, UpstreamError } from '@funds-helper/sources';
import type { FastifyBaseLogger } from 'fastify';
import type { TtlCache } from '../../cache.ts';
import type { AppConfig } from '../../config.ts';
import { AppError } from '../../errors.ts';
import type { FxDataSource } from './data-source.ts';
import type { FxBarInput, FxBarRow, FxRepository } from './repository.ts';

/** 落库用的标的键，与 core 的报价方向同源 */
export const FX_PAIR = FX_DIRECTIONS.UsdCny;

/** 日线数量的回归护栏：实测 8021 根（1994-08-30 起）。跌破说明上游缩短了历史或已改版 */
export const FX_MIN_EXPECTED = 5000;

/**
 * 缓存 key 只落在**不变量**上（全量历史 + 新鲜度）。
 * 响应由 `(range, direction)` 两个维度决定，若按「参数组合」缓存，
 * 用户每切一次区间就会打一次上游。
 */
const BASE_CACHE_KEY = 'fx.base';

export interface FxCaptureStats {
  bars: number;
  inserted: number;
  dataDate: string | null;
  durationMs: number;
}

export interface FxServiceDeps {
  db: Db;
  repo: FxRepository;
  source: FxDataSource;
  cache: TtlCache;
  config: AppConfig;
  logger: FastifyBaseLogger;
  now?: () => number;
}

export interface FxDatasetOptions {
  range: FxRangeKey;
  direction: FxDirection;
  force?: boolean;
}

interface FxBase {
  freshness: Freshness;
  /** 全量历史（基准方向 USD/CNY），已按日期升序 */
  bars: FxBar[];
}

function rowToBar(row: FxBarRow): FxBar {
  return {
    date: row.data_date,
    open: row.open,
    low: row.low,
    high: row.high,
    close: row.close,
  };
}

/**
 * 汇率工具的服务层：唯一编排 IO 的地方（缓存 → 数据库 → 上游）。
 *
 * 与 QDII / 美元份额的差别只在**缓存分两层**：不变量的全量历史进 TTL 缓存，
 * 派生统计（区间涨跌 / 年度 / 概要）是纯函数计算的，每次都按请求参数现算 ——
 * 既不打上游，也没有缓存 key 爆炸。降级语义与其它工具完全一致。
 */
export class FxService {
  private readonly deps: FxServiceDeps;
  private readonly now: () => number;

  constructor(deps: FxServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  private get sourceName(): string {
    return this.deps.source.name;
  }

  // -------------------------------------------------------------------------
  // 抓取与落库
  // -------------------------------------------------------------------------

  /** 拉一次全量日线并整段落库（单事务，幂等） */
  async captureSnapshot(): Promise<FxCaptureStats> {
    const startedAt = this.now();
    const { bars, skippedRows } = await this.deps.source.fetchDailySeries();

    if (bars.length === 0) {
      throw new ParseError('上游没有返回任何汇率日线数据，可能接口已改版');
    }
    if (bars.length < FX_MIN_EXPECTED) {
      this.deps.logger.warn(
        { count: bars.length, expected: FX_MIN_EXPECTED },
        '汇率日线数量明显偏少，上游可能已缩短历史或改变了字段',
      );
    }
    if (skippedRows > 0) {
      this.deps.logger.warn({ skippedRows }, '上游存在日期非法或缺收盘价的行，已跳过');
    }

    const capturedAt = new Date(this.now()).toISOString();
    const inputs: FxBarInput[] = bars.map((bar) => ({
      date: bar.date,
      open: bar.open,
      low: bar.low,
      high: bar.high,
      close: bar.close,
    }));

    const inserted = this.deps.db.transaction(() => {
      const before = this.deps.repo.countBars(FX_PAIR);
      this.deps.repo.upsertBars(FX_PAIR, inputs, capturedAt);
      return this.deps.repo.countBars(FX_PAIR) - before;
    });

    // 历史变了，派生的基础数据必须失效
    this.deps.cache.delete(BASE_CACHE_KEY);

    const stats: FxCaptureStats = {
      bars: bars.length,
      inserted,
      dataDate: bars.at(-1)?.date ?? null,
      durationMs: this.now() - startedAt,
    };
    this.deps.logger.info({ ...stats }, '汇率日线已更新');
    return stats;
  }

  // -------------------------------------------------------------------------
  // 数据集（走势 + 统计）
  // -------------------------------------------------------------------------

  async getDataset(options: FxDatasetOptions): Promise<FxDatasetResponse> {
    if (options.force === true) this.deps.cache.delete(BASE_CACHE_KEY);

    const base = await this.deps.cache.getOrBuild(
      BASE_CACHE_KEY,
      () => this.buildBase(),
      this.deps.config.memoryCacheTtlSec * 1000,
    );
    return this.derive(base, options.range, options.direction);
  }

  private async buildBase(): Promise<FxBase> {
    const staleWindowMs = this.deps.config.staleWindowSec * 1000;
    const capturedAt = this.deps.repo.latestCapturedAt(FX_PAIR);
    const hasData = this.deps.repo.latestBarDate(FX_PAIR) !== null;
    const age =
      capturedAt === null ? Number.POSITIVE_INFINITY : this.now() - Date.parse(capturedAt);

    let stale = false;
    let staleReason: string | undefined;

    if (age > staleWindowMs) {
      try {
        await this.captureSnapshot();
      } catch (error) {
        // 只有上游故障才降级。数据库/编程错误必须原样暴露（500），
        // 否则会被伪装成「上游不可用」，掩盖真正的 bug。
        if (!(error instanceof UpstreamError)) throw error;

        const message = error instanceof Error ? error.message : String(error);
        if (!hasData) {
          throw new AppError(
            'UPSTREAM_UNAVAILABLE',
            '上游接口不可用，且本地还没有任何汇率数据（可稍后点「重新抓取上游」重试）',
            message,
          );
        }
        // 关键降级：宁可返回「陈旧但真实」的历史序列，也不返回错误页
        stale = true;
        staleReason = message;
        this.deps.logger.warn({ err: message }, '上游拉取失败，回退到本地汇率日线');
      }
    }

    return {
      freshness: {
        dataDate: this.deps.repo.latestBarDate(FX_PAIR),
        fetchedAt: this.deps.repo.latestCapturedAt(FX_PAIR) ?? new Date(this.now()).toISOString(),
        stale,
        ...(staleReason === undefined ? {} : { staleReason }),
        source: this.sourceName,
      },
      bars: this.deps.repo.loadBars(FX_PAIR).map(rowToBar),
    };
  }

  /** 纯函数派生：方向换算 → 区间裁剪/抽稀 → 统计表 */
  private derive(base: FxBase, range: FxRangeKey, direction: FxDirection): FxDatasetResponse {
    const converted = base.bars.map((bar) => convertBar(bar, direction));
    const last = converted.at(-1);
    if (last === undefined) {
      // buildBase 已保证非空；这里显式失败，而不是下发一个形状不全的响应
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        '本地没有任何汇率数据（可稍后点「重新抓取上游」重试）',
      );
    }

    // 极值取未抽稀的区间序列；抽稀只影响「图」，不影响「数」
    const ranged = sliceRange(converted, range);
    const rangeExtremes = extremes(ranged);
    const allExtremes = extremes(converted);
    const change = dayChange(converted);

    const summary: FxSummary = {
      latest: { date: last.date, rate: last.close },
      previous: change?.previous ?? null,
      dayChange: change?.change ?? null,
      dayChangePct: change?.changePct ?? null,
      rangeHigh: rangeExtremes.high,
      rangeLow: rangeExtremes.low,
      allTimeHigh: allExtremes.high,
      allTimeLow: allExtremes.low,
      annualizedVolatility: annualizedVolatility(converted),
      totalBars: converted.length,
      firstDate: converted[0]?.date ?? last.date,
      lastDate: last.date,
    };

    return {
      symbol: this.deps.source.symbol,
      direction,
      range,
      points: downsample(ranged, FX_MAX_CHART_POINTS),
      intervals: intervalChanges(converted),
      yearly: yearlyStats(converted),
      summary,
      freshness: base.freshness,
      disclaimer: FX_DISCLAIMER,
    };
  }
}
