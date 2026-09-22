import {
  aggregateEtfStats,
  classifyEtfOrFallback,
  describePremium,
  EMPTY_ETF_FLAGS,
  ETF_MARKETS,
  type EtfCoverage,
  type EtfFlags,
  type EtfMarket,
  isFeederFundName,
  isFundCode,
  premiumRateFromDiscount,
} from '@funds-helper/core';
import type { Db, SettingRepository } from '@funds-helper/db';
import {
  ETF_DISCLAIMER,
  ETF_SPOT_SOURCE_ORDER,
  ETF_SPOT_SOURCES,
  type EtfConfigResponse,
  type EtfDataSourceInfo,
  type EtfDatasetResponse,
  type EtfFeederFund,
  type EtfFeederInfo,
  type EtfFeederRefreshResponse,
  type EtfFundDetailResponse,
  type EtfFundProfile,
  type EtfRecord,
  type EtfStats,
} from '@funds-helper/shared';
import {
  ETF_SPOT_SOURCE_IDS,
  type EtfSpotItem,
  type EtfSpotSourceId,
  type FeederScanResult,
  type FundProfileData,
  ParseError,
  type RawEtfProfile,
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
  EtfFeederInput,
  EtfProfileInput,
  EtfProfileRow,
  EtfRepository,
  EtfSpotInput,
  EtfSpotRow,
} from './repository.ts';

/**
 * ETF 工具的服务层：唯一编排 IO 的地方（缓存 → 数据库 → 上游）。
 *
 * 上游角色不同：
 * - **接口 A（行情）是主源** —— 没有行情就没有这个工具；东财整族不可用时
 *   降级到备用源（新浪列表，见 `fetchSpot`），代价是**没有折溢价/上市日期**；
 * - **接口 B（目录/跟踪指数）是增强源** —— 失败只降级：分类回退名称判定、跟踪指数留空，
 *   数据集照常返回并记一条 warn。
 */

/** 行情数量的回归护栏：实测 1623 只。跌破说明板块 `fs` 或分页行为变了 */
export const ETF_MIN_EXPECTED = 800;

/**
 * 全量反查的**落库**护栏：本轮映射到的只数至少要达到「库里已有行数」的这个比例，
 * 才允许整表替换（见 `ETF_FEEDER_REPLACE_RATIO` 的用法）。
 *
 * 挡的是破坏性操作：全量会删掉本轮没扫到的行，而上游「抽风只回一小部分」
 * 与「联接基金真的批量清盘」在数据上无法区分 —— 因此宁可保留旧数据并告警。
 * 用**相对**比例而不是绝对条数：绝对下限在「库本来就是空的」或小规模场景下
 * 会把正常路径也挡掉（实测全量映射 2306 只、占候选池 99.4%，0.5 有充足余量）。
 */
export const ETF_FEEDER_REPLACE_MIN_RATIO = 0.5;

/** 上次反查时刻的运行时配置键（`app_setting`） */
export const ETF_FEEDER_SCANNED_AT_KEY = 'etf.feederScannedAt';

/**
 * 距上次反查多久算「该重跑了」。
 *
 * 定时任务是每周一 03:00（`0 3 * * 1`），因此阈值取 **6 天**而不是 7 天：
 * 恰好等于 7 天时，cron 与启动补跑的时间抖动可能让本周这次被判定为「还不用跑」，
 * 白等一周。反过来 6 天也足够挡住「进程频繁重启导致反复全量扫描」。
 */
export const ETF_FEEDER_REFRESH_AFTER_MS = 6 * 24 * 3_600_000;

const DATASET_CACHE_KEY = 'etf.dataset';

export interface EtfCaptureStats {
  spot: number;
  profile: number;
  inserted: number;
  dataDate: string;
  durationMs: number;
  /** 本次行情实际来自哪个渠道（主源失败时会降级到备用源） */
  source: EtfSpotSourceId;
  /** 接口 B 失败时的原因（数据集仍可用，只是分类走了名称回退） */
  profileError?: string;
}

/** 反查结果（落库后的真实口径，用于手动刷新的响应与日志） */
export interface EtfFeederStats {
  /** 是否全量重建 */
  full: boolean;
  /** 本次实际反查的基金只数 */
  scanned: number;
  /** 拿到目标 ETF 的只数 */
  mapped: number;
  /** 上游没给目标 ETF 的只数 */
  empty: number;
  /** 请求失败的只数 */
  failed: number;
  /** 落库后：有联接基金的 ETF 只数 / 联接基金只数 */
  etfCount: number;
  fundCount: number;
  durationMs: number;
  /** 增量模式下没有新候选（没打任何上游请求） */
  skipped: boolean;
}

export interface EtfFeederScanPlan {
  /** 是否该跑（距上次成功反查超过阈值，或从来没跑过） */
  due: boolean;
  /** 是否全量重建（从来没跑过时才需要） */
  full: boolean;
}

export interface EtfServiceDeps {
  db: Db;
  repo: EtfRepository;
  /** 运行时配置（当前只放行情渠道偏好） */
  settings: SettingRepository;
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

/** 渠道标识 → 可下发的能力描述；未知值（历史数据源列为 NULL）按主源处理 */
function dataSourceInfo(id: string | null): EtfDataSourceInfo {
  return ETF_SPOT_SOURCES[id === 'sina' ? 'sina' : 'eastmoney'];
}

/** 运行时配置里行情渠道偏好的键名 */
export const ETF_SPOT_SOURCE_SETTING_KEY = 'etf.spotSource';

/** 环境变量给的默认偏好（没有运行时配置时使用） */
function envDefaultSource(config: AppConfig): EtfSpotSourceId {
  return config.etfEastmoneyEnabled ? 'eastmoney' : 'sina';
}

/** 运行时配置里的值可能是脏的（人工改库/旧版本写入），读出来必须校验 */
function parseSpotSource(value: string | null): EtfSpotSourceId | null {
  return value !== null && (ETF_SPOT_SOURCE_IDS as readonly string[]).includes(value)
    ? (value as EtfSpotSourceId)
    : null;
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
export function spotDataDate(items: readonly EtfSpotItem[], now: number): string {
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

  private profileMap(): Map<string, EtfProfileRow> {
    return new Map(this.deps.repo.loadProfiles().map((row) => [row.code, row]));
  }

  // ---------------------------------------------------------------------------
  // 运行时配置（行情渠道）
  // ---------------------------------------------------------------------------

  /** 当前行情渠道偏好：运行时配置优先，其次环境变量默认值 */
  spotSourcePreference(): EtfSpotSourceId {
    return (
      parseSpotSource(this.deps.settings.get(ETF_SPOT_SOURCE_SETTING_KEY)) ??
      envDefaultSource(this.deps.config)
    );
  }

  /**
   * 切换行情渠道。只写配置，**不**在这里抓取 —— 由调用方决定什么时候重新采数
   * （路由层在切换后立刻抓一次，见 `routes.ts`），这样抓取的失败处理只有一套。
   */
  setSpotSourcePreference(source: EtfSpotSourceId): void {
    this.deps.settings.set(ETF_SPOT_SOURCE_SETTING_KEY, source);
    // 数据集缓存的响应里带 `dataSource`：切换后必须让它重新构建
    this.deps.cache.delete(DATASET_CACHE_KEY);
  }

  /** 渠道配置（界面上的下拉框 + 能力说明）；只读本地，不打上游 */
  getConfig(): EtfConfigResponse {
    const dataDate = this.deps.repo.latestSpotDate();
    return {
      spotSource: this.spotSourcePreference(),
      envDefault: envDefaultSource(this.deps.config),
      activeSource: dataSourceInfo(this.deps.repo.dominantSpotSource(dataDate)).id,
      sources: ETF_SPOT_SOURCE_ORDER.map((id) => ETF_SPOT_SOURCES[id]),
    };
  }

  /**
   * 取全市场行情。
   *
   * 渠道由**运行时配置**决定（界面上可切，见 `spotSourcePreference`）：
   * - `sina`：只走新浪列表（自带全市场代码 + UTF-8 JSON，17 页拿完 1676 只）；
   * - `eastmoney`（默认）：优先东财（只有它给折溢价率/上市日期）——
   *   有代码池（目录接口 B）就用 `ulist.np` 批量报价，没有代码池才退回自带代码池的 `clist`；
   *   任一步失败都自动降级到新浪。
   *
   * 无论哪条链路，都**不会**因为单一渠道失败而让数据集挂掉；真正用了哪个渠道
   * 会写进 `etf_spot_daily.source`，并在数据集响应里回给前端。
   *
   * @param codes 目录（接口 B）里的代码池；为空时东财只能走 `clist`
   */
  private async fetchSpot(
    codes: readonly string[],
  ): Promise<{ items: EtfSpotItem[]; source: EtfSpotSourceId }> {
    if (this.spotSourcePreference() === 'sina') {
      return { items: await this.deps.source.fetchSinaEtfSpot(), source: 'sina' };
    }

    // 两个东财行情接口互补：`ulist.np` 快但要先有代码池，`clist` 自带代码池但按板块翻页
    const useCodes = codes.length > 0;
    try {
      const items = useCodes
        ? await this.deps.source.fetchEtfSpotByCodes(codes)
        : await this.deps.source.fetchEtfSpot();
      return { items, source: 'eastmoney' };
    } catch (error) {
      // 只有上游故障才降级；编程/数据库错误必须原样抛出，不能被伪装成「上游不可用」
      if (!(error instanceof UpstreamError) && !(error instanceof ParseError)) throw error;
      const primaryError = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn(
        { err: primaryError, via: useCodes ? 'ulist.np' : 'clist' },
        '东财 ETF 行情不可用，降级到新浪列表',
      );

      try {
        const items = await this.deps.source.fetchSinaEtfSpot();
        this.deps.logger.warn(
          { count: items.length },
          '已降级到新浪行情：本次快照不含折溢价/上市日期',
        );
        return { items, source: 'sina' };
      } catch (backupError) {
        if (!(backupError instanceof UpstreamError) && !(backupError instanceof ParseError)) {
          throw backupError;
        }
        this.deps.logger.error(
          { primary: primaryError, backup: backupError.message },
          '主源与备用源的 ETF 行情都不可用',
        );
        throw error;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 抓取与落库
  // ---------------------------------------------------------------------------

  async captureSnapshot(): Promise<EtfCaptureStats> {
    const startedAt = this.now();

    // 目录（接口 B）先跑：它既是分类/跟踪指数的来源，**也是备用行情源的代码池**
    // （新浪列表自带全市场代码，所以降级不依赖本地是否有历史快照）
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

    const { items, source } = await this.fetchSpot(profiles.map((row) => row.code));

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
      source,
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
      source,
      ...(profileError === undefined ? {} : { profileError }),
    };
    this.deps.logger.info({ ...stats }, 'ETF 行情快照已更新');
    return stats;
  }

  // ---------------------------------------------------------------------------
  // 场外联接基金（反查接口 I）
  // ---------------------------------------------------------------------------

  /** 距上次成功反查是否已经超过阈值；`full` = 从来没跑过，需要全量建库 */
  feederScanPlan(): EtfFeederScanPlan {
    const raw = this.deps.settings.get(ETF_FEEDER_SCANNED_AT_KEY);
    const at = raw === null ? Number.NaN : Date.parse(raw);
    if (!Number.isFinite(at)) return { due: true, full: true };
    return { due: this.now() - at >= ETF_FEEDER_REFRESH_AFTER_MS, full: false };
  }

  /**
   * 反查「ETF → 场外联接基金」并落库。
   *
   * 两段式（见 `docs/design/etf-tool.md` §11.3）：
   * 候选池（1 请求）→ 逐只反查接口 I（每只 1 请求）。
   *
   * **增量是默认路径**：落库表里已有的联接基金不再重复查（`knownFeederCodes`），
   * 因此稳态每周只有几十个请求。反过来，「查询失败」与「上游还没建仓」的代码
   * 因为不在表里，下次会被自动重试 —— 不需要额外的重试状态机。
   *
   * `full` 只做两件增量做不到的事：重查**全部**候选、以及清掉已清盘的联接基金
   * （整表替换）。它要打约 2300 个请求（≈4 分钟），因此只在首次建库或手动触发时用。
   */
  async refreshFeederFunds(options: { full?: boolean } = {}): Promise<EtfFeederStats> {
    const startedAt = this.now();
    const full = options.full ?? false;

    const entries = await this.deps.source.fetchFundCatalog();
    const candidates = entries.filter((entry) => isFeederFundName(entry.name));
    if (candidates.length === 0) {
      throw new ParseError('全市场基金表里没有匹配到任何联接基金，疑似上游格式变更');
    }

    const known = full ? new Set<string>() : this.deps.repo.knownFeederCodes();
    const todo = candidates.filter((entry) => !known.has(entry.code));
    const nameOfFeeder = new Map(candidates.map((entry) => [entry.code, entry.name]));

    if (todo.length === 0) {
      // 候选池没有新增：不打上游，但仍然刷新「上次扫描时刻」，否则启动补跑会每次都走一遍候选池
      const capturedAt = new Date(this.now()).toISOString();
      this.deps.settings.set(ETF_FEEDER_SCANNED_AT_KEY, capturedAt);
      this.deps.logger.info(
        { candidates: candidates.length, known: known.size },
        '联接基金候选池没有新增，跳过反查',
      );
      return this.feederStats({
        full,
        scanned: 0,
        skipped: true,
        durationMs: this.now() - startedAt,
      });
    }

    this.deps.logger.info(
      { candidates: candidates.length, todo: todo.length, full, known: known.size },
      '开始反查场外联接基金（接口 I）',
    );

    const startedFetchAt = this.now();
    const result: FeederScanResult = await this.deps.source.fetchFeederTargets(
      todo.map((entry) => entry.code),
      {
        onProgress: (done, total) => {
          // 全量要跑 4 分钟：每 500 只留一行进度，否则日志里看不出它是在跑还是卡住了
          if (done % 500 === 0 || done === total) {
            this.deps.logger.info(
              { done, total, elapsedMs: this.now() - startedFetchAt },
              '联接基金反查进度',
            );
          }
        },
      },
    );

    const capturedAt = new Date(this.now()).toISOString();
    const rows: EtfFeederInput[] = [];
    for (const [feederCode, target] of result.targets) {
      const name = nameOfFeeder.get(feederCode);
      if (name === undefined) continue;
      rows.push({
        etfCode: target.etfCode,
        feederCode,
        feederName: name,
        reportDate: target.reportDate,
      });
    }

    if (full) {
      // 整表替换会删掉本轮没扫到的行（清盘的联接基金），因此只在「没有失败」且
      // 映射量没有塌方式缩水时才做 —— 否则上游抽风会清空整张表
      const existing = this.deps.repo.countFeederFunds();
      const floor = existing * ETF_FEEDER_REPLACE_MIN_RATIO;
      if (result.failed.length === 0 && rows.length >= floor) {
        this.deps.repo.replaceFeederFunds(rows, capturedAt);
      } else {
        this.deps.logger.warn(
          { failed: result.failed.length, mapped: rows.length, existing, floor },
          '全量反查结果不完整，退化为增量写入（保留已有映射）',
        );
        this.deps.repo.upsertFeederFunds(rows, capturedAt);
      }
    } else {
      this.deps.repo.upsertFeederFunds(rows, capturedAt);
    }
    this.deps.settings.set(ETF_FEEDER_SCANNED_AT_KEY, capturedAt);
    this.deps.cache.delete(DATASET_CACHE_KEY);

    const stats = this.feederStats({
      full,
      scanned: todo.length,
      mapped: rows.length,
      empty: result.empty.length,
      failed: result.failed.length,
      durationMs: this.now() - startedAt,
    });
    if (result.failed.length > 0) {
      this.deps.logger.warn(
        { ...stats, failedCodes: result.failed.slice(0, 10) },
        '部分联接基金反查失败',
      );
    }
    this.deps.logger.info({ ...stats }, '场外联接基金已更新');
    return stats;
  }

  /** 反查刷新响应（手动路由用；把内部统计翻译成下发给前端的契约） */
  async refreshFeederFundsResponse(
    options: { full?: boolean } = {},
  ): Promise<EtfFeederRefreshResponse> {
    const stats = await this.refreshFeederFunds(options);
    return {
      ok: true,
      full: stats.full,
      scanned: stats.scanned,
      mapped: stats.mapped,
      empty: stats.empty,
      failed: stats.failed,
      etfCount: stats.etfCount,
      fundCount: stats.fundCount,
      durationMs: stats.durationMs,
      message: stats.skipped
        ? '候选池没有新增联接基金，未反查上游'
        : `${stats.full ? '全量' : '增量'}反查 ${stats.scanned} 只联接基金，` +
          `命中 ${stats.mapped} 只（覆盖 ${stats.etfCount} 只 ETF）` +
          (stats.empty > 0 ? `，${stats.empty} 只上游暂无目标 ETF` : '') +
          (stats.failed > 0 ? `，${stats.failed} 只请求失败（下次自动重试）` : ''),
    };
  }

  /** 反查的覆盖度与新鲜度（数据集响应里下发给前端） */
  feederInfo(): EtfFeederInfo {
    return {
      updatedAt: this.deps.settings.get(ETF_FEEDER_SCANNED_AT_KEY),
      etfCount: this.deps.repo.countFeederEtfs(),
      fundCount: this.deps.repo.countFeederFunds(),
    };
  }

  private feederStats(partial: Partial<EtfFeederStats> & { full: boolean }): EtfFeederStats {
    return {
      scanned: 0,
      mapped: 0,
      empty: 0,
      failed: 0,
      durationMs: 0,
      skipped: false,
      ...partial,
      etfCount: this.deps.repo.countFeederEtfs(),
      fundCount: this.deps.repo.countFeederFunds(),
    };
  }

  /** ETF 代码 → 它的场外联接基金（行已按 (etf_code, feeder_code) 排序，份额顺序天然稳定） */
  private feederMap(): Map<string, EtfFeederFund[]> {
    const map = new Map<string, EtfFeederFund[]>();
    for (const row of this.deps.repo.loadFeederFunds()) {
      const list = map.get(row.etf_code);
      const fund = { code: row.feeder_code, name: row.feeder_name };
      if (list === undefined) map.set(row.etf_code, [fund]);
      else list.push(fund);
    }
    return map;
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
    const feeders = this.feederMap();
    const records = this.deps.repo
      .loadLatestSpot()
      .map((row) =>
        this.toRecord(
          row,
          profiles.get(row.code),
          feeders.get(row.code) ?? [],
          dataDate,
          snapshotCapturedAt,
        ),
      );

    // 渠道来自**数据本身**（0006 的 source 列）而不是配置：进程重启、缓存过期之后
    // 「这批行情是不是备用渠道来的」依然可判（否则一排 null 折溢价无从解释）
    const dataSource = dataSourceInfo(this.deps.repo.dominantSpotSource(dataDate));

    return {
      freshness: {
        dataDate,
        fetchedAt: snapshotCapturedAt,
        stale,
        ...(staleReason === undefined ? {} : { staleReason }),
        source: dataSource.id,
      },
      dataSource,
      total: records.length,
      stats: this.buildStats(records, profiles),
      funds: records,
      feeder: this.feederInfo(),
      disclaimer: ETF_DISCLAIMER,
    };
  }

  private toRecord(
    spot: EtfSpotRow,
    profile: EtfProfileRow | undefined,
    feederFunds: readonly EtfFeederFund[],
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

      feederFunds: [...feederFunds],

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
