import {
  buildAdvice,
  buildFundLimit,
  buildStats,
  classify,
  diffFundLimits,
  FEATURED_REGIONS,
  FEATURED_THEMES,
  type FundLimit,
  findSiblingShareClasses,
  isBuyable,
  isFundCode,
  isOnExchange,
  isQdii,
  limitDisplay,
  minPurchaseDisplay,
  orderedCounts,
  parseCurrency,
  parsePurchaseStatus,
  parseRedeemStatus,
  periodLabel,
  periodRank,
  summarizeNav,
} from '@funds-helper/core';
import type { Db } from '@funds-helper/db';
import {
  DISCLAIMER,
  type Freshness,
  type FundRecord,
  type QdiiChangesResponse,
  type QdiiDatasetResponse,
  type QdiiFundDetailResponse,
  type QdiiPremiumResponse,
  type ShareClass,
} from '@funds-helper/shared';
import {
  extractAllocation,
  extractHolders,
  extractNavTrend,
  extractScale,
  noticeUrl,
  ParseError,
  tsToDate,
  UpstreamError,
} from '@funds-helper/sources';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../../config.ts';
import { AppError, badRequest, notFound } from '../../errors.ts';
import type { QdiiDataSource } from './data-source.ts';
import type { ChangeRow, QdiiRepository, SnapshotRow } from './repository.ts';

/** QDII 数量的回归护栏：跌破这个数说明上游基金类型标签八成变了 */
export const QDII_MIN_EXPECTED = 500;

/** 净值走势只回传最近约 3.2 年（800 个交易日），全量 3000+ 点没有意义 */
export const NAV_POINTS = 800;

const DATASET_CACHE_KEY = 'qdii.dataset';
const PREMIUM_CACHE_KEY = 'qdii.premium';

export interface CaptureStats {
  total: number;
  inserted: number;
  changed: number;
  dataDate: string | null;
  durationMs: number;
}

export interface QdiiServiceDeps {
  db: Db;
  repo: QdiiRepository;
  source: QdiiDataSource;
  cache: import('../../cache.ts').TtlCache;
  config: AppConfig;
  logger: FastifyBaseLogger;
  now?: () => number;
}

function todayInShanghai(now: number): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}

function rowToFundLimit(row: SnapshotRow): FundLimit {
  return {
    code: row.code,
    name: row.name,
    fundType: row.fund_type,
    currency: parseCurrency(row.currency),
    status: parsePurchaseStatus(row.status),
    dailyLimit: row.daily_limit,
    minPurchase: row.min_purchase,
    nextOpenDate: row.next_open_date,
    redeemStatus: parseRedeemStatus(row.redeem_status),
    nav: row.nav,
    navDate: row.nav_date,
    fee: row.fee ?? '',
  };
}

export class QdiiService {
  private readonly deps: QdiiServiceDeps;
  private readonly now: () => number;

  constructor(deps: QdiiServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  private get sourceName(): string {
    return this.deps.source.name;
  }

  private freshness(overrides: Partial<Freshness> = {}): Freshness {
    return {
      dataDate: this.deps.repo.latestDataDate(),
      fetchedAt: this.deps.repo.latestCapturedAt() ?? new Date(this.now()).toISOString(),
      stale: false,
      source: this.sourceName,
      ...overrides,
    };
  }

  private toRecord(fund: FundLimit, dataDate: string | null, capturedAt: string): FundRecord {
    const { region, theme } = classify(fund.name);
    return {
      code: fund.code,
      name: fund.name,
      fundType: fund.fundType,
      currency: fund.currency,
      region,
      theme,
      status: fund.status,
      redeemStatus: fund.redeemStatus,
      dailyLimit: fund.dailyLimit,
      limitText: limitDisplay(fund),
      minPurchase: fund.minPurchase,
      minPurchaseText: minPurchaseDisplay(fund),
      nextOpenDate: fund.nextOpenDate,
      nav: fund.nav,
      navDate: fund.navDate,
      fee: fund.fee,
      onExchange: isOnExchange(fund),
      buyable: isBuyable(fund),
      capturedAt,
      dataDate,
    };
  }

  // -------------------------------------------------------------------------
  // 抓取与落库
  // -------------------------------------------------------------------------

  /**
   * 拉一次接口 A、归一化、落库，并计算与上一交易日的差异。
   * 整个写入在一个事务里完成：要么全部生效，要么完全不生效。
   */
  async captureSnapshot(): Promise<CaptureStats> {
    const startedAt = this.now();
    const { rows, meta } = await this.deps.source.fetchSnapshot();

    const funds = rows.map(buildFundLimit).filter((fund) => isQdii(fund.fundType));
    if (funds.length === 0) {
      throw new ParseError('上游响应中没有匹配到任何 QDII，可能基金类型标签已变更');
    }
    if (funds.length < QDII_MIN_EXPECTED) {
      this.deps.logger.warn(
        { count: funds.length, expected: QDII_MIN_EXPECTED },
        'QDII 数量明显偏少，上游基金类型标签可能已变更',
      );
    }
    if (meta.skippedRows > 0) {
      // 上游确实存在字段残缺的行（实测），记一笔但不当错误 —— 需要时能查得到
      this.deps.logger.warn({ skippedRows: meta.skippedRows }, '上游存在缺少基金代码的行，已跳过');
    }

    const dataDate = meta.showday[0] ?? todayInShanghai(this.now());
    const capturedAt = new Date(this.now()).toISOString();

    const changed = this.deps.db.transaction(() => {
      this.deps.repo.upsertFunds(funds, capturedAt);

      const baselineDate = this.deps.repo.previousDataDate(dataDate);
      const previous = baselineDate
        ? this.deps.repo.loadSnapshot(baselineDate).map(rowToFundLimit)
        : [];

      const before = this.deps.repo.countSnapshot(dataDate);
      this.deps.repo.upsertSnapshots(funds, dataDate, capturedAt);
      const inserted = this.deps.repo.countSnapshot(dataDate) - before;

      const changes = diffFundLimits(previous, funds);
      if (changes.length > 0) this.deps.repo.insertChanges(changes, dataDate, capturedAt);

      return { changed: changes.length, inserted };
    });

    // 快照变了，派生数据（数据集、溢价）必须失效
    this.deps.cache.delete(DATASET_CACHE_KEY);
    this.deps.cache.delete(PREMIUM_CACHE_KEY);

    const stats: CaptureStats = {
      total: funds.length,
      inserted: changed.inserted,
      changed: changed.changed,
      dataDate,
      durationMs: this.now() - startedAt,
    };
    this.deps.logger.info({ ...stats }, 'QDII 快照已更新');
    return stats;
  }

  // -------------------------------------------------------------------------
  // 数据集（列表页核心载荷）
  // -------------------------------------------------------------------------

  async getDataset(force = false): Promise<QdiiDatasetResponse> {
    if (force) this.deps.cache.delete(DATASET_CACHE_KEY);
    return this.deps.cache.getOrBuild(
      DATASET_CACHE_KEY,
      () => this.buildDataset(),
      this.deps.config.memoryCacheTtlSec * 1000,
    );
  }

  private async buildDataset(): Promise<QdiiDatasetResponse> {
    const staleWindowMs = this.deps.config.staleWindowSec * 1000;
    const capturedAt = this.deps.repo.latestCapturedAt();
    const hasData = this.deps.repo.latestDataDate() !== null;
    const age =
      capturedAt === null ? Number.POSITIVE_INFINITY : this.now() - Date.parse(capturedAt);

    let stale = false;
    let staleReason: string | undefined;

    if (age > staleWindowMs) {
      try {
        await this.captureSnapshot();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!hasData) {
          throw new AppError(
            'UPSTREAM_UNAVAILABLE',
            '上游接口不可用，且本地还没有任何数据',
            message,
          );
        }
        // 关键降级：宁可返回「陈旧但真实」的快照，也不返回错误页
        stale = true;
        staleReason = message;
        this.deps.logger.warn({ err: message }, '上游拉取失败，回退到本地快照');
      }
    }

    const dataDate = this.deps.repo.latestDataDate();
    const snapshotCapturedAt =
      this.deps.repo.latestCapturedAt() ?? new Date(this.now()).toISOString();
    const snapshot = this.deps.repo.loadLatestSnapshot();
    const funds = snapshot.map(rowToFundLimit);
    const records = funds.map((fund) => this.toRecord(fund, dataDate, snapshotCapturedAt));

    return {
      freshness: this.freshness({
        dataDate,
        fetchedAt: snapshotCapturedAt,
        stale,
        ...(staleReason === undefined ? {} : { staleReason }),
      }),
      total: records.length,
      stats: buildStats(funds),
      categories: {
        regions: orderedCounts(records, 'region', FEATURED_REGIONS),
        themes: orderedCounts(records, 'theme', FEATURED_THEMES),
      },
      funds: records,
      disclaimer: DISCLAIMER,
    };
  }

  // -------------------------------------------------------------------------
  // 单只基金详情
  // -------------------------------------------------------------------------

  async getFundDetail(code: string, fresh = false): Promise<QdiiFundDetailResponse> {
    if (!isFundCode(code)) throw badRequest('基金代码必须是 6 位数字', code);

    if (fresh) this.deps.repo.clearDetail(code);
    const cached = this.deps.repo.loadDetail(
      code,
      this.deps.config.memoryCacheTtlSec * 1000,
      this.now(),
    );
    if (cached !== null) return JSON.parse(cached) as QdiiFundDetailResponse;

    const dataset = await this.getDataset();
    const record = dataset.funds.find((fund) => fund.code === code);
    if (!record) {
      throw notFound(`未找到 QDII 基金 ${code}`, '可能不是 QDII，或代码有误');
    }

    const detail = await this.buildFundDetail(record, dataset.funds);
    this.deps.repo.saveDetail(code, JSON.stringify(detail), new Date(this.now()).toISOString());
    return detail;
  }

  /** 四类上游数据各自独立容错：某块失败只影响对应区块，其余照常返回 */
  private async buildFundDetail(
    record: FundRecord,
    allRecords: readonly FundRecord[],
  ): Promise<QdiiFundDetailResponse> {
    const code = record.code;
    const errors: string[] = [];
    const timed = <T extends Error>(label: string, error: T): void => {
      errors.push(`${label}不可用：${error.message}`);
    };

    let base: QdiiFundDetailResponse['base'] = null;
    let navTrend: QdiiFundDetailResponse['navTrend'] = [];
    let navSummary: QdiiFundDetailResponse['navSummary'] = [];
    let scale: QdiiFundDetailResponse['scale'] = [];
    let allocation: QdiiFundDetailResponse['allocation'] = [];
    let holders: QdiiFundDetailResponse['holders'] = [];
    let periods: QdiiFundDetailResponse['periods'] = [];
    let holdings: QdiiFundDetailResponse['holdings'] = {
      stocks: [],
      bonds: [],
      etf: null,
    };
    let reportDate: string | null = null;
    let notices: QdiiFundDetailResponse['notices'] = [];

    try {
      const detail = await this.deps.source.fetchFundDetail(code);
      base = {
        name: detail.name,
        fundType: detail.fundType,
        company: detail.company,
        manager: detail.manager,
        purchaseStatus: detail.purchaseStatus,
        redeemStatus: detail.redeemStatus,
        maxPurchase: toNumberOrNull(detail.maxPurchase),
        minPurchase: toNumberOrNull(detail.minPurchase),
        nav: toNumberOrNull(detail.nav),
        navDate: detail.navDate,
        nextOpenDate: detail.nextOpenDate,
        sourceRate: detail.sourceRate,
        rate: detail.rate,
        riskLevel: detail.riskLevel,
      };
    } catch (error) {
      if (error instanceof UpstreamError) timed('详情接口', error);
      else throw error;
    }

    try {
      const pingzhong = await this.deps.source.fetchPingzhong(code);
      const points = extractNavTrend(pingzhong).map((point) => ({
        date: tsToDate(point.x),
        nav: point.y,
        change: point.equityReturn,
      }));
      // 区间统计用完整历史，图表只回传最近 NAV_POINTS 个点
      navSummary = summarizeNav(points);
      navTrend = points.slice(-NAV_POINTS);
      scale = extractScale(pingzhong).map((point) => ({
        date: point.date,
        scale: point.scale,
        mom: point.mom,
      }));
      allocation = extractAllocation(pingzhong).map((item) => ({
        name: item.name,
        value: item.value,
      }));
      holders = extractHolders(pingzhong).map((item) => ({ name: item.name, value: item.value }));
    } catch (error) {
      if (error instanceof UpstreamError) timed('净值走势', error);
      else throw error;
    }

    try {
      const increase = await this.deps.source.fetchPeriodIncrease(code);
      periods = increase.periods
        .map((period) => ({
          key: period.title,
          label: periodLabel(period.title),
          ret: toNumberOrNull(period.ret),
          avg: toNumberOrNull(period.avg),
          bench: toNumberOrNull(period.bench),
          rank: toNumberOrNull(period.rank),
          total: toNumberOrNull(period.total),
        }))
        .sort((a, b) => periodRank(a.key) - periodRank(b.key));
    } catch (error) {
      if (error instanceof UpstreamError) timed('阶段涨幅', error);
      else throw error;
    }

    try {
      const raw = await this.deps.source.fetchHoldings(code);
      reportDate = raw.reportDate;
      holdings = { stocks: raw.stocks, bonds: raw.bonds, etf: raw.etf };
    } catch (error) {
      if (error instanceof UpstreamError) timed('持仓数据', error);
      else throw error;
    }

    try {
      const raw = await this.deps.source.fetchNotices(code, 8);
      this.deps.repo.upsertNotices(code, raw);
      notices = raw.map((notice) => ({
        id: notice.id,
        title: notice.title,
        publishDate: notice.publishDate,
        url: noticeUrl(code, notice.id),
      }));
    } catch (error) {
      if (error instanceof UpstreamError) timed('限购公告', error);
      else throw error;
    }

    // 同基金其它份额类别（A/C 选择用）
    const siblings: ShareClass[] = findSiblingShareClasses(
      record,
      allRecords,
      (item) => item.currency,
    ).map((item) => ({
      code: item.code,
      name: item.name,
      dailyLimit: item.dailyLimit,
      status: item.status,
    }));

    const advice = buildAdvice({
      fund: recordToFundLimit(record),
      siblings: siblings.map((sibling) => ({
        code: sibling.code,
        name: sibling.name,
        dailyLimit: sibling.dailyLimit,
        limitText: sibling.dailyLimit === null ? '无限额' : `${sibling.dailyLimit} 元`,
        status: sibling.status,
      })),
      company: base?.company ?? null,
      rate: base?.rate ?? null,
    });

    return {
      code,
      record,
      base,
      navTrend,
      navSummary,
      scale,
      allocation,
      holders,
      periods,
      holdings,
      reportDate,
      shareClasses: siblings,
      advice,
      notices,
      errors,
      freshness: this.freshness(),
      disclaimer: DISCLAIMER,
    };
  }

  // -------------------------------------------------------------------------
  // 场内折溢价
  // -------------------------------------------------------------------------

  async getPremium(force = false): Promise<QdiiPremiumResponse> {
    if (force) this.deps.cache.delete(PREMIUM_CACHE_KEY);
    return this.deps.cache.getOrBuild(
      PREMIUM_CACHE_KEY,
      () => this.buildPremium(),
      this.deps.config.memoryCacheTtlSec * 1000,
    );
  }

  private async buildPremium(): Promise<QdiiPremiumResponse> {
    const dataset = await this.getDataset();
    const exchange = dataset.funds.filter((fund) => fund.onExchange);

    if (exchange.length === 0) {
      return { items: [], freshness: this.freshness(), disclaimer: DISCLAIMER };
    }

    let stale = false;
    let staleReason: string | undefined;
    let rates = new Map<string, { price: number | null; discountRate: number | null }>();

    try {
      const quotes = await this.deps.source.fetchQuotes(exchange.map((fund) => fund.code));
      const capturedAt = new Date(this.now()).toISOString();
      const items = quotes.map((quote) => ({
        code: quote.code,
        price: quote.price,
        discountRate: quote.discountRate,
      }));
      this.deps.repo.upsertPremiums(items, capturedAt);
      rates = new Map(items.map((item) => [item.code, item]));
    } catch (error) {
      // 行情接口失败不该阻断主流程：回退到最近一次落库的行情
      const message = error instanceof Error ? error.message : String(error);
      const latestAt = this.deps.repo.latestPremiumAt();
      if (latestAt === null) throw error;
      stale = true;
      staleReason = message;
      rates = new Map(
        this.deps.repo
          .loadPremiums(latestAt)
          .map((row) => [row.code, { price: row.price, discountRate: row.discount_rate }]),
      );
      this.deps.logger.warn({ err: message }, '行情接口失败，回退到本地溢价快照');
    }

    const items = exchange
      .map((fund) => {
        const rate = rates.get(fund.code);
        const discountRate = rate?.discountRate ?? null;
        return {
          code: fund.code,
          name: fund.name,
          discountRate,
          // f402 负值 = 溢价，这里做语义转换供界面直接展示
          premiumRate: discountRate === null ? null : -discountRate,
          price: rate?.price ?? null,
          nav: fund.nav,
        };
      })
      .filter((item) => item.discountRate !== null)
      // 折价率升序 = 溢价最高在前
      .sort((a, b) => (a.discountRate ?? 0) - (b.discountRate ?? 0));

    return {
      items,
      freshness: this.freshness(
        stale ? { stale, ...(staleReason === undefined ? {} : { staleReason }) } : {},
      ),
      disclaimer: DISCLAIMER,
    };
  }

  // -------------------------------------------------------------------------
  // 额度变更
  // -------------------------------------------------------------------------

  async getChanges(days = 30, limit = 200): Promise<QdiiChangesResponse> {
    const since = new Date(this.now() - days * 86_400_000).toISOString();
    const rows = this.deps.repo.loadChanges(since, limit);
    const dataset = await this.getDataset();
    const names = new Map(dataset.funds.map((fund) => [fund.code, fund.name]));

    const items = rows.map((row: ChangeRow) => ({
      code: row.code,
      name: names.get(row.code) ?? row.code,
      dataDate: row.data_date,
      detectedAt: row.detected_at,
      field: row.field,
      oldValue: row.old_value,
      newValue: row.new_value,
      direction: row.direction === 'loosened' ? ('loosened' as const) : ('tightened' as const),
    }));

    return {
      items,
      summary: {
        tightened: items.filter((item) => item.direction === 'tightened').length,
        loosened: items.filter((item) => item.direction === 'loosened').length,
      },
      freshness: this.freshness(),
      disclaimer: DISCLAIMER,
    };
  }

  totalChanges(): number {
    return this.deps.repo.countChanges();
  }
}

function toNumberOrNull(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** FundRecord → FundLimit（仅用于把已有记录喂给纯函数，不重新归一化） */
function recordToFundLimit(record: FundRecord): FundLimit {
  return {
    code: record.code,
    name: record.name,
    fundType: record.fundType,
    currency: record.currency,
    status: record.status,
    dailyLimit: record.dailyLimit,
    minPurchase: record.minPurchase,
    nextOpenDate: record.nextOpenDate,
    redeemStatus: record.redeemStatus,
    nav: record.nav,
    navDate: record.navDate,
    fee: record.fee,
  };
}
