import {
  buildFundLimit,
  classify,
  describeUsdLimit,
  FEATURED_REGIONS,
  FEATURED_THEMES,
  type FundLimit,
  isBuyable,
  isChannelNotSold,
  isFundCode,
  isOnExchange,
  isUsdShare,
  minPurchaseDisplay,
  orderedCounts,
  parseCurrency,
  parsePurchaseStatus,
  parseRedeemStatus,
  parseUsdKind,
  shareClassKey,
} from '@funds-helper/core';
import type { Db } from '@funds-helper/db';
import {
  DISCLAIMER,
  type Freshness,
  type UsdDatasetResponse,
  type UsdFundDetailResponse,
  type UsdFundRecord,
  type UsdStats,
} from '@funds-helper/shared';
import { ParseError, UpstreamError } from '@funds-helper/sources';
import type { FastifyBaseLogger } from 'fastify';
import type { TtlCache } from '../../cache.ts';
import type { AppConfig } from '../../config.ts';
import { AppError, badRequest, notFound } from '../../errors.ts';
import { buildFundDetailSections } from '../../fund-detail/sections.ts';
import { todayInShanghai } from '../../time.ts';
import type { UsdDataSource } from './data-source.ts';
import type {
  UsdFundInput,
  UsdRepository,
  UsdSiblingInput,
  UsdSnapshotInput,
  UsdSnapshotRow,
} from './repository.ts';

/** 美元份额数量的回归护栏：跌破这个数说明上游币种标记（名称后缀）八成变了 */
export const USD_MIN_EXPECTED = 100;

const DATASET_CACHE_KEY = 'usd.dataset';

export interface UsdCaptureStats {
  total: number;
  inserted: number;
  changed: number;
  dataDate: string | null;
  durationMs: number;
}

export interface UsdServiceDeps {
  db: Db;
  repo: UsdRepository;
  source: UsdDataSource;
  cache: TtlCache;
  config: AppConfig;
  logger: FastifyBaseLogger;
  now?: () => number;
}

function rowToFundLimit(row: UsdSnapshotRow): FundLimit {
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

function buildUsdStats(records: readonly UsdFundRecord[]): UsdStats {
  const status: Record<string, number> = {};
  const usdKind: Record<string, number> = {};
  let buyable = 0;

  for (const record of records) {
    status[record.status] = (status[record.status] ?? 0) + 1;
    usdKind[record.usdKind] = (usdKind[record.usdKind] ?? 0) + 1;
    if (record.buyable) buyable += 1;
  }

  return { status, usdKind, buyable };
}

/**
 * 美元份额工具的服务层：唯一编排 IO 的地方（缓存 → 数据库 → 上游）。
 *
 * 「可买」以**申购状态**为准（开放申购 / 限大额）；日限额因美元份额在天天基金
 * 渠道通常不售而不可靠，只做展示并标注「渠道不适用」。
 */
export class UsdService {
  private readonly deps: UsdServiceDeps;
  private readonly now: () => number;

  constructor(deps: UsdServiceDeps) {
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

  private toRecord(
    fund: FundLimit,
    channelNotSold: boolean,
    dataDate: string | null,
    capturedAt: string,
  ): UsdFundRecord {
    const { region, theme } = classify(fund.name);
    const limit = describeUsdLimit(fund, channelNotSold);

    return {
      code: fund.code,
      name: fund.name,
      fundType: fund.fundType,
      currency: fund.currency,
      usdKind: parseUsdKind(fund.name),
      region,
      theme,
      status: fund.status,
      redeemStatus: fund.redeemStatus,
      buyable: isBuyable(fund),
      onExchange: isOnExchange(fund),
      dailyLimit: fund.dailyLimit,
      limitText: limit.text,
      dailyLimitNote: limit.note,
      minPurchase: fund.minPurchase,
      minPurchaseText: minPurchaseDisplay(fund),
      nextOpenDate: fund.nextOpenDate,
      nav: fund.nav,
      navDate: fund.navDate,
      fee: fund.fee,
      capturedAt,
      dataDate,
    };
  }

  // -------------------------------------------------------------------------
  // 抓取与落库
  // -------------------------------------------------------------------------

  /**
   * 拉一次接口 A（全市场），筛出美元份额、归一化、落库，并算好同基金的人民币份额对照。
   * 整个写入在一个事务里完成。
   */
  async captureSnapshot(): Promise<UsdCaptureStats> {
    const startedAt = this.now();
    const { rows, meta } = await this.deps.source.fetchSnapshot();

    // 全市场行先归一化，再按币种筛出美元份额（「人民币」优先的规则在 core 里）
    const allFunds = rows.map(buildFundLimit);
    const usdFunds = allFunds.filter((fund) => isUsdShare(fund));

    if (usdFunds.length === 0) {
      throw new ParseError('上游响应中没有匹配到任何美元份额，可能份额币种标记已变更');
    }
    if (usdFunds.length < USD_MIN_EXPECTED) {
      this.deps.logger.warn(
        { count: usdFunds.length, expected: USD_MIN_EXPECTED },
        '美元份额数量明显偏少，上游名称后缀或口径可能已变更',
      );
    }
    if (meta.skippedRows > 0) {
      this.deps.logger.warn({ skippedRows: meta.skippedRows }, '上游存在缺少基金代码的行，已跳过');
    }

    const dataDate = meta.showday[0] ?? todayInShanghai(this.now());
    const capturedAt = new Date(this.now()).toISOString();

    // 原始日限额只在这里可见：归一化后「渠道不售的 0」与哨兵值都会变成 null
    const rawLimitByCode = new Map(rows.map((row) => [row.code, row.dailyLimit]));

    const fundInputs: UsdFundInput[] = usdFunds.map((fund) => ({
      code: fund.code,
      name: fund.name,
      fundType: fund.fundType,
      currency: fund.currency,
      usdKind: parseUsdKind(fund.name),
    }));

    const snapshotInputs: UsdSnapshotInput[] = usdFunds.map((fund) => ({
      code: fund.code,
      status: fund.status,
      redeemStatus: fund.redeemStatus,
      dailyLimit: fund.dailyLimit,
      channelNotSold: isChannelNotSold(fund, rawLimitByCode.get(fund.code) ?? null),
      minPurchase: fund.minPurchase,
      nextOpenDate: fund.nextOpenDate,
      nav: fund.nav,
      navDate: fund.navDate,
      fee: fund.fee,
    }));

    // 同基金其它（非美元）份额：按份额家族键分组，一次遍历即可
    const byFamily = new Map<string, FundLimit[]>();
    for (const fund of allFunds) {
      const key = shareClassKey(fund.name);
      const list = byFamily.get(key);
      if (list) list.push(fund);
      else byFamily.set(key, [fund]);
    }
    const siblingsFor = (fund: FundLimit): UsdSiblingInput[] =>
      (byFamily.get(shareClassKey(fund.name)) ?? [])
        .filter((item) => item.code !== fund.code && item.currency !== 'USD')
        .map((item) => ({
          code: item.code,
          name: item.name,
          currency: item.currency,
          status: item.status,
          dailyLimit: item.dailyLimit,
        }));

    const inserted = this.deps.db.transaction(() => {
      this.deps.repo.upsertFunds(fundInputs, capturedAt);

      const before = this.deps.repo.countSnapshot(dataDate);
      this.deps.repo.upsertSnapshots(snapshotInputs, dataDate, capturedAt);
      const count = this.deps.repo.countSnapshot(dataDate) - before;

      for (const fund of usdFunds) this.deps.repo.replaceSiblings(fund.code, siblingsFor(fund));

      return count;
    });

    // 快照变了，派生的数据集必须失效
    this.deps.cache.delete(DATASET_CACHE_KEY);

    const stats: UsdCaptureStats = {
      total: usdFunds.length,
      inserted,
      changed: 0,
      dataDate,
      durationMs: this.now() - startedAt,
    };
    this.deps.logger.info({ ...stats }, '美元份额快照已更新');
    return stats;
  }

  // -------------------------------------------------------------------------
  // 数据集（列表页核心载荷）
  // -------------------------------------------------------------------------

  async getDataset(force = false): Promise<UsdDatasetResponse> {
    if (force) this.deps.cache.delete(DATASET_CACHE_KEY);
    return this.deps.cache.getOrBuild(
      DATASET_CACHE_KEY,
      () => this.buildDataset(),
      this.deps.config.memoryCacheTtlSec * 1000,
    );
  }

  private async buildDataset(): Promise<UsdDatasetResponse> {
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
        // 只有上游故障才降级。数据库/编程错误必须原样暴露（500），
        // 否则会被伪装成「上游不可用」，掩盖真正的 bug。
        if (!(error instanceof UpstreamError)) throw error;

        const message = error instanceof Error ? error.message : String(error);
        if (!hasData) {
          throw new AppError(
            'UPSTREAM_UNAVAILABLE',
            '上游接口不可用，且本地还没有任何数据（可稍后点「重新抓取上游」重试）',
            message,
          );
        }
        // 关键降级：宁可返回「陈旧但真实」的快照，也不返回错误页
        stale = true;
        staleReason = message;
        this.deps.logger.warn({ err: message }, '上游拉取失败，回退到本地美元份额快照');
      }
    }

    const dataDate = this.deps.repo.latestDataDate();
    const snapshotCapturedAt =
      this.deps.repo.latestCapturedAt() ?? new Date(this.now()).toISOString();
    const records = this.deps.repo
      .loadLatestSnapshot()
      .map((row) =>
        this.toRecord(
          rowToFundLimit(row),
          row.channel_not_sold === 1,
          dataDate,
          snapshotCapturedAt,
        ),
      );

    return {
      freshness: this.freshness({
        dataDate,
        fetchedAt: snapshotCapturedAt,
        stale,
        ...(staleReason === undefined ? {} : { staleReason }),
      }),
      total: records.length,
      stats: buildUsdStats(records),
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

  async getFundDetail(code: string, fresh = false): Promise<UsdFundDetailResponse> {
    if (!isFundCode(code)) throw badRequest('基金代码必须是 6 位数字', code);

    if (fresh) this.deps.repo.clearDetail(code);
    const cached = this.deps.repo.loadDetail(
      code,
      this.deps.config.memoryCacheTtlSec * 1000,
      this.now(),
    );
    if (cached !== null) return JSON.parse(cached) as UsdFundDetailResponse;

    const dataset = await this.getDataset();
    const record = dataset.funds.find((fund) => fund.code === code);
    if (!record) {
      throw notFound(`未找到美元份额基金 ${code}`, '可能不是美元份额，或代码有误');
    }

    // 通用区块（净值/收益/持仓/公告）与 QDII 共用同一份聚合
    const sections = await buildFundDetailSections(this.deps.source, code);

    const cnySiblings = this.deps.repo.loadSiblings(code).map((row) => ({
      code: row.sibling_code,
      name: row.sibling_name,
      dailyLimit: row.sibling_daily_limit,
      status: parsePurchaseStatus(row.sibling_status),
    }));

    const detail: UsdFundDetailResponse = {
      code,
      record,
      base: sections.base,
      navTrend: sections.navTrend,
      navEvents: sections.navEvents,
      navSummary: sections.navSummary,
      navSummaryNote: sections.navSummaryNote,
      scale: sections.scale,
      allocation: sections.allocation,
      holders: sections.holders,
      periods: sections.periods,
      holdings: sections.holdings,
      reportDate: sections.reportDate,
      notices: sections.notices,
      cnySiblings,
      errors: sections.errors,
      freshness: this.freshness(),
      disclaimer: DISCLAIMER,
    };

    this.deps.repo.saveDetail(code, JSON.stringify(detail), new Date(this.now()).toISOString());
    return detail;
  }
}
