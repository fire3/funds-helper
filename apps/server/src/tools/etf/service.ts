import {
  aggregateEtfStats,
  classifyEtfOrFallback,
  describePremium,
  EMPTY_ETF_FLAGS,
  ETF_MARKETS,
  type EtfCoverage,
  type EtfFlags,
  type EtfMarket,
  isFundCode,
  premiumRateFromDiscount,
} from '@funds-helper/core';
import type { Db } from '@funds-helper/db';
import {
  ETF_DISCLAIMER,
  type EtfDatasetResponse,
  type EtfFundDetailResponse,
  type EtfFundProfile,
  type EtfRecord,
  type EtfStats,
} from '@funds-helper/shared';
import {
  type FundProfileData,
  ParseError,
  type RawEtfProfile,
  type RawEtfSpotItem,
  UpstreamError,
} from '@funds-helper/sources';
import type { FastifyBaseLogger } from 'fastify';
import type { TtlCache } from '../../cache.ts';
import type { AppConfig } from '../../config.ts';
import { AppError, badRequest, notFound } from '../../errors.ts';
import { buildFundDetailSections } from '../../fund-detail/sections.ts';
import { todayInShanghai } from '../../time.ts';
import type { EtfDataSource } from './data-source.ts';
import type {
  EtfProfileInput,
  EtfProfileRow,
  EtfRepository,
  EtfSpotInput,
  EtfSpotRow,
} from './repository.ts';

/**
 * ETF 工具的服务层：唯一编排 IO 的地方（缓存 → 数据库 → 上游）。
 *
 * 两个上游角色不同：
 * - **接口 A（行情）是主源** —— 没有行情就没有这个工具，失败即失败；
 * - **接口 B（目录/跟踪指数）是增强源** —— 失败只降级：分类回退名称判定、跟踪指数留空，
 *   数据集照常返回并记一条 warn。
 */

/** 行情数量的回归护栏：实测 1623 只。跌破说明板块 `fs` 或分页行为变了 */
export const ETF_MIN_EXPECTED = 800;

const DATASET_CACHE_KEY = 'etf.dataset';

export interface EtfCaptureStats {
  spot: number;
  profile: number;
  inserted: number;
  dataDate: string;
  durationMs: number;
  /** 接口 B 失败时的原因（数据集仍可用，只是分类走了名称回退） */
  profileError?: string;
}

export interface EtfServiceDeps {
  db: Db;
  repo: EtfRepository;
  source: EtfDataSource;
  cache: TtlCache;
  config: AppConfig;
  logger: FastifyBaseLogger;
  now?: () => number;
}

/** 上游 `f13`：1 = 沪市、0 = 深市 */
function marketLabel(market: number | null): EtfMarket {
  return market === 1 ? ETF_MARKETS.Sh : ETF_MARKETS.Sz;
}

/** 秒级时间戳 → ISO8601（上游时间戳是 UTC 秒，展示层按 Asia/Shanghai 理解） */
function isoTimestamp(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/** 秒级时间戳 → Asia/Shanghai 的日期（数据日期取该批行情的最大时间戳，而不是本地「今天」） */
function shanghaiDateOf(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000 + 8 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * 数据日期 = 该批行情里最新的行情时间（北京时间）。
 *
 * 不能用「本地今天」：周末/节假日刷新时行情时间仍是上一交易日，
 * 用本地日期会写出一行没有行情的「假日期」，破坏 `(code, data_date)` 的幂等语义。
 */
export function spotDataDate(items: readonly RawEtfSpotItem[], now: number): string {
  let latest: number | null = null;
  for (const item of items) {
    if (item.quoteTs === null) continue;
    if (latest === null || item.quoteTs > latest) latest = item.quoteTs;
  }
  return shanghaiDateOf(latest) ?? todayInShanghai(now);
}

function flagsOf(row: EtfProfileRow | undefined): EtfFlags {
  if (!row) return EMPTY_ETF_FLAGS;
  return {
    money: row.is_money === 1,
    crossBorder: row.is_cross_border === 1,
    bond: row.is_bond === 1,
    commodity: row.is_commodity === 1,
    broad: row.is_broad === 1,
    industry: row.is_industry === 1,
    style: row.is_style === 1,
  };
}

/** 规模优先取行情的场内市值；缺失时用目录的规模估算（亿元 → 元） */
function resolveScale(spot: EtfSpotRow, profile: EtfProfileRow | undefined): number | null {
  if (spot.scale !== null) return spot.scale;
  if (profile?.net_assets_yi === null || profile?.net_assets_yi === undefined) return null;
  return profile.net_assets_yi * 1e8;
}

export class EtfService {
  private readonly deps: EtfServiceDeps;
  private readonly now: () => number;

  constructor(deps: EtfServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  private get sourceName(): string {
    return this.deps.source.name;
  }

  private profileMap(): Map<string, EtfProfileRow> {
    return new Map(this.deps.repo.loadProfiles().map((row) => [row.code, row]));
  }

  // ---------------------------------------------------------------------------
  // 抓取与落库
  // ---------------------------------------------------------------------------

  async captureSnapshot(): Promise<EtfCaptureStats> {
    const startedAt = this.now();
    const items = await this.deps.source.fetchEtfSpot();

    if (items.length === 0) {
      throw new ParseError('上游未返回任何 ETF 行情，疑似板块参数或接口结构变更');
    }
    if (items.length < ETF_MIN_EXPECTED) {
      this.deps.logger.warn(
        { count: items.length, expected: ETF_MIN_EXPECTED },
        'ETF 行情数量明显偏少，板块参数或分页行为可能已变更',
      );
    }

    const dataDate = spotDataDate(items, this.now());
    const capturedAt = new Date(this.now()).toISOString();

    const spotInputs: EtfSpotInput[] = items.map((item) => ({
      code: item.code,
      name: item.name ?? item.code,
      market: marketLabel(item.market),
      price: item.price,
      changePct: item.changePct,
      changeAmt: item.changeAmt,
      open: item.open,
      high: item.high,
      low: item.low,
      prevClose: item.prevClose,
      amplitude: item.amplitude,
      turnover: item.turnover,
      volumeRatio: item.volumeRatio,
      volume: item.volume,
      amount: item.amount,
      scale: item.scale,
      floatScale: item.floatScale,
      // 唯一一次口径转换：上游 f402 是「负的溢价率」
      premiumRate: premiumRateFromDiscount(item.discountRate),
      listingDate: item.listingDate,
      mainInflow: item.mainInflow,
      quoteAt: isoTimestamp(item.quoteTs),
    }));

    // 接口 B 是增强源：失败只降级，不阻塞行情落库
    let profiles: RawEtfProfile[] = [];
    let profileError: string | undefined;
    try {
      profiles = await this.deps.source.fetchEtfProfiles();
    } catch (error) {
      if (!(error instanceof UpstreamError) && !(error instanceof ParseError)) throw error;
      profileError = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn(
        { err: profileError },
        'ETF 目录（跟踪指数）拉取失败，分类回退名称判定',
      );
    }

    const profileInputs: EtfProfileInput[] = profiles.map((row) => ({
      code: row.code,
      name: row.name,
      indexCode: row.indexCode,
      indexName: row.indexName,
      money: row.money,
      crossBorder: row.crossBorder,
      bond: row.bond,
      commodity: row.commodity,
      broad: row.broad,
      industry: row.industry,
      style: row.style,
      change1w: row.change1w,
      change1m: row.change1m,
      change3m: row.change3m,
      ytdChange: row.ytdChange,
      maxDrawdown1y: row.maxDrawdown1y,
      netAssetsYi: row.netAssetsYi,
      shares: row.shares,
    }));

    const inserted = this.deps.db.transaction(() => {
      const before = this.deps.repo.countSpot(dataDate);
      this.deps.repo.upsertSpot(spotInputs, dataDate, capturedAt);
      const count = this.deps.repo.countSpot(dataDate) - before;
      // 目录为空（上游故障）时保留上一次的目录，不要把已有跟踪指数清空
      if (profileInputs.length > 0) this.deps.repo.upsertProfiles(profileInputs, capturedAt);
      return count;
    });

    this.deps.cache.delete(DATASET_CACHE_KEY);

    const stats: EtfCaptureStats = {
      spot: spotInputs.length,
      profile: profileInputs.length,
      inserted,
      dataDate,
      durationMs: this.now() - startedAt,
      ...(profileError === undefined ? {} : { profileError }),
    };
    this.deps.logger.info({ ...stats }, 'ETF 行情快照已更新');
    return stats;
  }

  // ---------------------------------------------------------------------------
  // 数据集（汇总展示的核心载荷）
  // ---------------------------------------------------------------------------

  async getDataset(force = false): Promise<EtfDatasetResponse> {
    if (force) this.deps.cache.delete(DATASET_CACHE_KEY);
    return this.deps.cache.getOrBuild(
      DATASET_CACHE_KEY,
      () => this.buildDataset(),
      this.deps.config.memoryCacheTtlSec * 1000,
    );
  }

  private async buildDataset(): Promise<EtfDatasetResponse> {
    const staleWindowMs = this.deps.config.staleWindowSec * 1000;
    const capturedAt = this.deps.repo.latestSpotCapturedAt();
    const hasData = this.deps.repo.latestSpotDate() !== null;
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
        if (!(error instanceof UpstreamError) && !(error instanceof ParseError)) throw error;

        const message = error instanceof Error ? error.message : String(error);
        if (!hasData) {
          throw new AppError(
            'UPSTREAM_UNAVAILABLE',
            '上游接口不可用，且本地还没有任何 ETF 行情（可稍后点「重新抓取上游」重试）',
            message,
          );
        }
        // 关键降级：宁可返回「陈旧但真实」的快照，也不返回错误页
        stale = true;
        staleReason = message;
        this.deps.logger.warn({ err: message }, '上游拉取失败，回退到本地 ETF 行情快照');
      }
    }

    const dataDate = this.deps.repo.latestSpotDate();
    const snapshotCapturedAt =
      this.deps.repo.latestSpotCapturedAt() ?? new Date(this.now()).toISOString();
    const profiles = this.profileMap();
    const records = this.deps.repo
      .loadLatestSpot()
      .map((row) => this.toRecord(row, profiles.get(row.code), dataDate, snapshotCapturedAt));

    return {
      freshness: {
        dataDate,
        fetchedAt: snapshotCapturedAt,
        stale,
        ...(staleReason === undefined ? {} : { staleReason }),
        source: this.sourceName,
      },
      total: records.length,
      stats: this.buildStats(records, profiles),
      funds: records,
      disclaimer: ETF_DISCLAIMER,
    };
  }

  private toRecord(
    spot: EtfSpotRow,
    profile: EtfProfileRow | undefined,
    dataDate: string | null,
    capturedAt: string,
  ): EtfRecord {
    const classification = classifyEtfOrFallback(spot.name, flagsOf(profile));
    const premium = describePremium(spot.premium_rate);

    return {
      code: spot.code,
      name: spot.name,
      market: spot.market === ETF_MARKETS.Sh ? ETF_MARKETS.Sh : ETF_MARKETS.Sz,
      category: classification.category,
      categorySource: classification.source,
      indexCode: profile?.index_code ?? null,
      indexName: profile?.index_name ?? null,

      price: spot.price,
      changePct: spot.change_pct,
      changeAmt: spot.change_amt,
      open: spot.open,
      high: spot.high,
      low: spot.low,
      prevClose: spot.prev_close,
      amplitude: spot.amplitude,
      turnover: spot.turnover,
      volumeRatio: spot.volume_ratio,
      volume: spot.volume,
      amount: spot.amount,

      scale: resolveScale(spot, profile),
      shares: profile?.shares ?? null,

      premiumRate: spot.premium_rate,
      premiumLevel: premium.level,
      premiumText: premium.text,
      premiumNote: premium.note,

      listingDate: spot.listing_date,

      change1w: profile?.change_1w ?? null,
      change1m: profile?.change_1m ?? null,
      change3m: profile?.change_3m ?? null,
      ytdChange: profile?.ytd_change ?? null,
      maxDrawdown1y: profile?.max_drawdown_1y ?? null,

      quoteAt: spot.quote_at,
      dataDate,
      capturedAt,
    };
  }

  private buildStats(
    records: readonly EtfRecord[],
    profiles: Map<string, EtfProfileRow>,
  ): EtfStats {
    const spotCodes = new Set(records.map((record) => record.code));
    const joined = [...profiles.keys()].filter((code) => spotCodes.has(code)).length;
    const coverage: EtfCoverage = {
      spot: records.length,
      profile: profiles.size,
      // 目录里有、没有场内行情 → 已成立未上市（或当日无行情）
      unlisted: Math.max(0, profiles.size - joined),
    };
    return aggregateEtfStats(records, coverage);
  }

  // ---------------------------------------------------------------------------
  // 单只 ETF 详情
  // ---------------------------------------------------------------------------

  async getFundDetail(code: string, fresh = false): Promise<EtfFundDetailResponse> {
    if (!isFundCode(code)) throw badRequest('基金代码必须是 6 位数字', code);

    if (fresh) this.deps.repo.clearDetail(code);
    const cached = this.deps.repo.loadDetail(
      code,
      this.deps.config.memoryCacheTtlSec * 1000,
      this.now(),
    );
    if (cached !== null) return JSON.parse(cached) as EtfFundDetailResponse;

    const dataset = await this.getDataset();
    const record = dataset.funds.find((fund) => fund.code === code);
    if (!record) {
      throw notFound(`未找到 ETF ${code}`, '可能不是 ETF 代码，或该基金尚未上市（无场内行情）');
    }

    const errors: string[] = [];

    let profile: EtfFundProfile | null = null;
    try {
      profile = toProfile(await this.deps.source.fetchFundProfile(code));
    } catch (error) {
      errors.push(
        `基金概况（费率/规模）：${error instanceof Error ? error.message : String(error)}`,
      );
      this.deps.logger.warn({ code, err: errors.at(-1) }, 'ETF 基金概况拉取失败');
    }

    // 通用区块（净值走势/收益/规模/持仓/公告）与 QDII、美元份额共用同一份聚合
    const sections = await buildFundDetailSections(this.deps.source, code);

    const detail: EtfFundDetailResponse = {
      code,
      record,
      profile,
      base: sections.base,
      navTrend: sections.navTrend,
      navSummary: sections.navSummary,
      scale: sections.scale,
      allocation: sections.allocation,
      holders: sections.holders,
      periods: sections.periods,
      holdings: sections.holdings,
      reportDate: sections.reportDate,
      notices: sections.notices,
      errors: [...errors, ...sections.errors],
      freshness: dataset.freshness,
      disclaimer: ETF_DISCLAIMER,
    };

    this.deps.repo.saveDetail(code, JSON.stringify(detail), new Date(this.now()).toISOString());
    return detail;
  }
}

function toProfile(data: FundProfileData | null): EtfFundProfile | null {
  if (data === null) return null;
  return {
    fullName: data.fullName,
    fundType: data.fundType,
    indexCode: data.indexCode,
    indexName: data.indexName,
    managementFee: data.managementFee,
    custodyFee: data.custodyFee,
    salesServiceFee: data.salesServiceFee,
    netAssets: data.netAssets,
    netAssetsDate: data.netAssetsDate,
    shareNetAssets: data.shareNetAssets,
    establishedDate: data.establishedDate,
    company: data.company,
    custodian: data.custodian,
    manager: data.manager,
    benchmark: data.benchmark,
    riskLevel: data.riskLevel,
  };
}
