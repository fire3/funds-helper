import type { Db } from '@funds-helper/db';

/**
 * ETF 工具的全部 SQL（留在工具切片内，不下沉到 packages/db）。
 *
 * 关键取舍：行情表唯一键是 `(code, data_date)` —— 同一交易日重复抓取覆盖同一行。
 * 这既保证幂等（盘中每 30 分钟刷新不会堆出垃圾行），又天然留下每日一行的时间序列。
 */

export interface EtfSpotRow {
  code: string;
  data_date: string;
  captured_at: string;
  /** 行情渠道（'eastmoney' | 'sina'，0006 追加列；更早的数据为 NULL） */
  source: string | null;
  name: string;
  market: string;
  price: number | null;
  change_pct: number | null;
  change_amt: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prev_close: number | null;
  amplitude: number | null;
  turnover: number | null;
  volume_ratio: number | null;
  volume: number | null;
  amount: number | null;
  scale: number | null;
  float_scale: number | null;
  premium_rate: number | null;
  listing_date: string | null;
  main_inflow: number | null;
  quote_at: string | null;
}

export interface EtfSpotInput {
  code: string;
  name: string;
  market: string;
  /** 行情渠道：写进快照，用于判断「当前数据集是哪个渠道采的」 */
  source: string;
  price: number | null;
  changePct: number | null;
  changeAmt: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  amplitude: number | null;
  turnover: number | null;
  volumeRatio: number | null;
  volume: number | null;
  amount: number | null;
  scale: number | null;
  floatScale: number | null;
  /** 已取反：正 = 溢价 */
  premiumRate: number | null;
  listingDate: string | null;
  mainInflow: number | null;
  /** 行情时间戳（ISO8601） */
  quoteAt: string | null;
}

export interface EtfProfileRow {
  code: string;
  name: string;
  index_code: string | null;
  index_name: string | null;
  is_money: number;
  is_cross_border: number;
  is_bond: number;
  is_commodity: number;
  is_broad: number;
  is_industry: number;
  is_style: number;
  change_1w: number | null;
  change_1m: number | null;
  change_3m: number | null;
  ytd_change: number | null;
  max_drawdown_1y: number | null;
  net_assets_yi: number | null;
  shares: number | null;
  captured_at: string;
}

export interface EtfProfileInput {
  code: string;
  name: string;
  indexCode: string | null;
  indexName: string | null;
  money: boolean;
  crossBorder: boolean;
  bond: boolean;
  commodity: boolean;
  broad: boolean;
  industry: boolean;
  style: boolean;
  change1w: number | null;
  change1m: number | null;
  change3m: number | null;
  ytdChange: number | null;
  maxDrawdown1y: number | null;
  netAssetsYi: number | null;
  shares: number | null;
}

export class EtfRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ---------------------------------------------------------------------------
  // 行情（接口 A）
  // ---------------------------------------------------------------------------

  upsertSpot(rows: readonly EtfSpotInput[], dataDate: string, capturedAt: string): void {
    for (const row of rows) {
      this.db.run(
        `INSERT INTO etf_spot_daily (
           code, data_date, captured_at, source, name, market, price, change_pct, change_amt,
           open, high, low, prev_close, amplitude, turnover, volume_ratio, volume, amount,
           scale, float_scale, premium_rate, listing_date, main_inflow, quote_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code, data_date) DO UPDATE SET
           captured_at = excluded.captured_at,
           source = excluded.source,
           name = excluded.name,
           market = excluded.market,
           price = excluded.price,
           change_pct = excluded.change_pct,
           change_amt = excluded.change_amt,
           open = excluded.open,
           high = excluded.high,
           low = excluded.low,
           prev_close = excluded.prev_close,
           amplitude = excluded.amplitude,
           turnover = excluded.turnover,
           volume_ratio = excluded.volume_ratio,
           volume = excluded.volume,
           amount = excluded.amount,
           scale = excluded.scale,
           float_scale = excluded.float_scale,
           premium_rate = excluded.premium_rate,
           listing_date = excluded.listing_date,
           main_inflow = excluded.main_inflow,
           quote_at = excluded.quote_at`,
        [
          row.code,
          dataDate,
          capturedAt,
          row.source,
          row.name,
          row.market,
          row.price,
          row.changePct,
          row.changeAmt,
          row.open,
          row.high,
          row.low,
          row.prevClose,
          row.amplitude,
          row.turnover,
          row.volumeRatio,
          row.volume,
          row.amount,
          row.scale,
          row.floatScale,
          row.premiumRate,
          row.listingDate,
          row.mainInflow,
          row.quoteAt,
        ],
      );
    }
  }

  countSpot(dataDate: string): number {
    return (
      this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM etf_spot_daily WHERE data_date = ?', [
        dataDate,
      ])?.n ?? 0
    );
  }

  latestSpotDate(): string | null {
    return (
      this.db.get<{ d: string | null }>('SELECT MAX(data_date) AS d FROM etf_spot_daily')?.d ?? null
    );
  }

  latestSpotCapturedAt(): string | null {
    return (
      this.db.get<{ c: string | null }>('SELECT MAX(captured_at) AS c FROM etf_spot_daily')?.c ??
      null
    );
  }

  loadLatestSpot(): EtfSpotRow[] {
    return this.db.all<EtfSpotRow>(
      `SELECT * FROM etf_spot_daily
       WHERE data_date = (SELECT MAX(data_date) FROM etf_spot_daily)
       ORDER BY code`,
    );
  }

  /**
   * 该数据日期的行情主要来自哪个渠道。
   *
   * 同一天可能先落东财、后落备用源的行（盘中降级），因此按行数取**多数派** ——
   * 只要主体是备用源，前端就该提示「本次快照不含折溢价」。
   */
  dominantSpotSource(dataDate: string | null): string | null {
    if (dataDate === null) return null;
    return (
      this.db.get<{ source: string | null }>(
        `SELECT source FROM etf_spot_daily
         WHERE data_date = ? AND source IS NOT NULL
         GROUP BY source
         ORDER BY COUNT(*) DESC
         LIMIT 1`,
        [dataDate],
      )?.source ?? null
    );
  }

  // ---------------------------------------------------------------------------
  // 目录（接口 B）
  // ---------------------------------------------------------------------------

  upsertProfiles(rows: readonly EtfProfileInput[], capturedAt: string): void {
    for (const row of rows) {
      this.db.run(
        `INSERT INTO etf_profile (
           code, name, index_code, index_name,
           is_money, is_cross_border, is_bond, is_commodity, is_broad, is_industry, is_style,
           change_1w, change_1m, change_3m, ytd_change, max_drawdown_1y,
           net_assets_yi, shares, captured_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           name = excluded.name,
           index_code = excluded.index_code,
           index_name = excluded.index_name,
           is_money = excluded.is_money,
           is_cross_border = excluded.is_cross_border,
           is_bond = excluded.is_bond,
           is_commodity = excluded.is_commodity,
           is_broad = excluded.is_broad,
           is_industry = excluded.is_industry,
           is_style = excluded.is_style,
           change_1w = excluded.change_1w,
           change_1m = excluded.change_1m,
           change_3m = excluded.change_3m,
           ytd_change = excluded.ytd_change,
           max_drawdown_1y = excluded.max_drawdown_1y,
           net_assets_yi = excluded.net_assets_yi,
           shares = excluded.shares,
           captured_at = excluded.captured_at`,
        [
          row.code,
          row.name,
          row.indexCode,
          row.indexName,
          row.money ? 1 : 0,
          row.crossBorder ? 1 : 0,
          row.bond ? 1 : 0,
          row.commodity ? 1 : 0,
          row.broad ? 1 : 0,
          row.industry ? 1 : 0,
          row.style ? 1 : 0,
          row.change1w,
          row.change1m,
          row.change3m,
          row.ytdChange,
          row.maxDrawdown1y,
          row.netAssetsYi,
          row.shares,
          capturedAt,
        ],
      );
    }
  }

  loadProfiles(): EtfProfileRow[] {
    return this.db.all<EtfProfileRow>('SELECT * FROM etf_profile ORDER BY code');
  }

  countProfiles(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM etf_profile')?.n ?? 0;
  }

  latestProfileCapturedAt(): string | null {
    return (
      this.db.get<{ c: string | null }>('SELECT MAX(captured_at) AS c FROM etf_profile')?.c ?? null
    );
  }

  // ---------------------------------------------------------------------------
  // 详情缓存（接口 C + 通用区块）
  // ---------------------------------------------------------------------------

  loadDetail(code: string, ttlMs: number, now: number): string | null {
    const row = this.db.get<{ payload: string; fetched_at: string }>(
      'SELECT payload, fetched_at FROM etf_detail_cache WHERE code = ?',
      [code],
    );
    if (!row) return null;
    return now - Date.parse(row.fetched_at) > ttlMs ? null : row.payload;
  }

  saveDetail(code: string, payload: string, fetchedAt: string): void {
    this.db.run(
      `INSERT INTO etf_detail_cache (code, fetched_at, payload) VALUES (?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload`,
      [code, fetchedAt, payload],
    );
  }

  clearDetail(code: string): void {
    this.db.run('DELETE FROM etf_detail_cache WHERE code = ?', [code]);
  }
}
