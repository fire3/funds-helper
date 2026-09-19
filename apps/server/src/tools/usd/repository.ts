import type { Db } from '@funds-helper/db';

/** 美元份额主数据行（含 snapshot 表 join 出来的字段） */
export interface UsdSnapshotRow {
  code: string;
  name: string;
  fund_type: string;
  currency: string;
  usd_kind: string;
  data_date: string;
  captured_at: string;
  status: string;
  redeem_status: string;
  daily_limit: number | null;
  channel_not_sold: number;
  min_purchase: number | null;
  next_open_date: string | null;
  nav: number | null;
  nav_date: string | null;
  fee: string | null;
}

export interface UsdSiblingRow {
  sibling_code: string;
  sibling_name: string;
  sibling_currency: string;
  sibling_status: string;
  sibling_daily_limit: number | null;
}

/** 写入快照所需的最小字段集 */
export interface UsdSnapshotInput {
  code: string;
  status: string;
  redeemStatus: string;
  dailyLimit: number | null;
  channelNotSold: boolean;
  minPurchase: number | null;
  nextOpenDate: string | null;
  nav: number | null;
  navDate: string | null;
  fee: string;
}

export interface UsdFundInput {
  code: string;
  name: string;
  fundType: string;
  currency: string;
  usdKind: string;
}

export interface UsdSiblingInput {
  code: string;
  name: string;
  currency: string;
  status: string;
  dailyLimit: number | null;
}

const SNAPSHOT_SELECT = `
  SELECT f.code, f.name, f.fund_type, f.currency, f.usd_kind,
         s.data_date, s.captured_at, s.status, s.redeem_status,
         s.daily_limit, s.channel_not_sold, s.min_purchase, s.next_open_date,
         s.nav, s.nav_date, s.fee
  FROM usd_snapshot s
  JOIN usd_fund f ON f.code = s.code`;

/** 美元份额工具的全部 SQL（留在工具切片内，不下沉到 packages/db） */
export class UsdRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ---- 快照写入 ----

  upsertFunds(funds: readonly UsdFundInput[], now: string): void {
    for (const fund of funds) {
      this.db.run(
        `INSERT INTO usd_fund (code, name, fund_type, currency, usd_kind, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           name = excluded.name,
           fund_type = excluded.fund_type,
           currency = excluded.currency,
           usd_kind = excluded.usd_kind,
           last_seen_at = excluded.last_seen_at`,
        [fund.code, fund.name, fund.fundType, fund.currency, fund.usdKind, now, now],
      );
    }
  }

  upsertSnapshots(funds: readonly UsdSnapshotInput[], dataDate: string, capturedAt: string): void {
    for (const fund of funds) {
      this.db.run(
        `INSERT INTO usd_snapshot
           (code, data_date, captured_at, status, redeem_status, daily_limit,
            channel_not_sold, min_purchase, next_open_date, nav, nav_date, fee)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code, data_date) DO UPDATE SET
           captured_at = excluded.captured_at,
           status = excluded.status,
           redeem_status = excluded.redeem_status,
           daily_limit = excluded.daily_limit,
           channel_not_sold = excluded.channel_not_sold,
           min_purchase = excluded.min_purchase,
           next_open_date = excluded.next_open_date,
           nav = excluded.nav,
           nav_date = excluded.nav_date,
           fee = excluded.fee`,
        [
          fund.code,
          dataDate,
          capturedAt,
          fund.status,
          fund.redeemStatus,
          fund.dailyLimit,
          fund.channelNotSold ? 1 : 0,
          fund.minPurchase,
          fund.nextOpenDate,
          fund.nav,
          fund.navDate,
          fund.fee,
        ],
      );
    }
  }

  countSnapshot(dataDate: string): number {
    return (
      this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM usd_snapshot WHERE data_date = ?', [
        dataDate,
      ])?.n ?? 0
    );
  }

  latestDataDate(): string | null {
    return (
      this.db.get<{ d: string | null }>('SELECT MAX(data_date) AS d FROM usd_snapshot')?.d ?? null
    );
  }

  latestCapturedAt(): string | null {
    return (
      this.db.get<{ c: string | null }>('SELECT MAX(captured_at) AS c FROM usd_snapshot')?.c ?? null
    );
  }

  previousDataDate(before: string): string | null {
    return (
      this.db.get<{ d: string | null }>(
        'SELECT MAX(data_date) AS d FROM usd_snapshot WHERE data_date < ?',
        [before],
      )?.d ?? null
    );
  }

  loadSnapshot(dataDate: string): UsdSnapshotRow[] {
    return this.db.all<UsdSnapshotRow>(`${SNAPSHOT_SELECT} WHERE s.data_date = ? ORDER BY s.code`, [
      dataDate,
    ]);
  }

  loadLatestSnapshot(): UsdSnapshotRow[] {
    const latest = this.latestDataDate();
    return latest === null ? [] : this.loadSnapshot(latest);
  }

  // ---- 同基金份额对照 ----

  replaceSiblings(usdCode: string, siblings: readonly UsdSiblingInput[]): void {
    this.db.run('DELETE FROM usd_sibling WHERE usd_code = ?', [usdCode]);
    for (const sibling of siblings) {
      this.db.run(
        `INSERT INTO usd_sibling
           (usd_code, sibling_code, sibling_name, sibling_currency, sibling_status, sibling_daily_limit)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [usdCode, sibling.code, sibling.name, sibling.currency, sibling.status, sibling.dailyLimit],
      );
    }
  }

  loadSiblings(usdCode: string): UsdSiblingRow[] {
    return this.db.all<UsdSiblingRow>(
      `SELECT sibling_code, sibling_name, sibling_currency, sibling_status, sibling_daily_limit
       FROM usd_sibling WHERE usd_code = ? ORDER BY sibling_currency, sibling_code`,
      [usdCode],
    );
  }

  // ---- 详情缓存 ----

  saveDetail(code: string, payload: string, fetchedAt: string): void {
    this.db.run(
      `INSERT INTO usd_detail_cache (code, fetched_at, payload)
       VALUES (?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload`,
      [code, fetchedAt, payload],
    );
  }

  loadDetail(code: string, maxAgeMs: number, now: number): string | null {
    const row = this.db.get<{ fetched_at: string; payload: string }>(
      'SELECT fetched_at, payload FROM usd_detail_cache WHERE code = ?',
      [code],
    );
    if (!row) return null;
    if (now - Date.parse(row.fetched_at) > maxAgeMs) return null;
    return row.payload;
  }

  clearDetail(code: string): void {
    this.db.run('DELETE FROM usd_detail_cache WHERE code = ?', [code]);
  }
}
