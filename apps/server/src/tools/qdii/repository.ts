import type { FundLimit, LimitChange } from '@funds-helper/core';
import type { Db } from '@funds-helper/db';
import type { RawNotice } from '@funds-helper/sources';

/** 快照表的一行（含 join 出来的基金主数据） */
export interface SnapshotRow {
  code: string;
  name: string;
  fund_type: string;
  currency: string;
  data_date: string;
  captured_at: string;
  status: string;
  redeem_status: string;
  daily_limit: number | null;
  min_purchase: number | null;
  next_open_date: string | null;
  nav: number | null;
  nav_date: string | null;
  fee: string | null;
}

export interface ChangeRow {
  code: string;
  data_date: string;
  detected_at: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  direction: string;
  ratio: number | null;
}

const SNAPSHOT_SELECT = `
  SELECT s.code, f.name, f.fund_type, f.currency,
         s.data_date, s.captured_at, s.status, s.redeem_status,
         s.daily_limit, s.min_purchase, s.next_open_date,
         s.nav, s.nav_date, s.fee
  FROM qdii_limit_snapshot s
  JOIN qdii_fund f ON f.code = s.code`;

/** QDII 工具的全部 SQL。工具专属 SQL 留在工具切片内，不下沉到 packages/db。 */
export class QdiiRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ---- 快照写入 ----

  upsertFunds(funds: readonly FundLimit[], now: string): void {
    for (const fund of funds) {
      this.db.run(
        `INSERT INTO qdii_fund (code, name, fund_type, currency, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           name = excluded.name,
           fund_type = excluded.fund_type,
           currency = excluded.currency,
           last_seen_at = excluded.last_seen_at`,
        [fund.code, fund.name, fund.fundType, fund.currency, now, now],
      );
    }
  }

  upsertSnapshots(funds: readonly FundLimit[], dataDate: string, capturedAt: string): void {
    for (const fund of funds) {
      this.db.run(
        `INSERT INTO qdii_limit_snapshot
           (code, data_date, captured_at, status, redeem_status, daily_limit,
            min_purchase, next_open_date, nav, nav_date, fee)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code, data_date) DO UPDATE SET
           captured_at = excluded.captured_at,
           status = excluded.status,
           redeem_status = excluded.redeem_status,
           daily_limit = excluded.daily_limit,
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
      this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM qdii_limit_snapshot WHERE data_date = ?',
        [dataDate],
      )?.n ?? 0
    );
  }

  latestDataDate(): string | null {
    return (
      this.db.get<{ d: string | null }>('SELECT MAX(data_date) AS d FROM qdii_limit_snapshot')?.d ??
      null
    );
  }

  latestCapturedAt(): string | null {
    return (
      this.db.get<{ c: string | null }>('SELECT MAX(captured_at) AS c FROM qdii_limit_snapshot')
        ?.c ?? null
    );
  }

  /** 早于给定数据日期的最近一个数据日期（用于 diff 找基线） */
  previousDataDate(before: string): string | null {
    return (
      this.db.get<{ d: string | null }>(
        'SELECT MAX(data_date) AS d FROM qdii_limit_snapshot WHERE data_date < ?',
        [before],
      )?.d ?? null
    );
  }

  loadSnapshot(dataDate: string): SnapshotRow[] {
    return this.db.all<SnapshotRow>(`${SNAPSHOT_SELECT} WHERE s.data_date = ? ORDER BY s.code`, [
      dataDate,
    ]);
  }

  loadLatestSnapshot(): SnapshotRow[] {
    const latest = this.latestDataDate();
    return latest === null ? [] : this.loadSnapshot(latest);
  }

  // ---- 变更事件 ----

  insertChanges(changes: readonly LimitChange[], dataDate: string, detectedAt: string): void {
    for (const change of changes) {
      this.db.run(
        `INSERT INTO qdii_limit_change
           (code, data_date, detected_at, field, old_value, new_value, direction, ratio)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          change.code,
          dataDate,
          detectedAt,
          change.field,
          change.oldValue,
          change.newValue,
          change.direction,
          change.ratio,
        ],
      );
    }
  }

  loadChanges(sinceIso: string, limit: number): ChangeRow[] {
    return this.db.all<ChangeRow>(
      `SELECT code, data_date, detected_at, field, old_value, new_value, direction, ratio
       FROM qdii_limit_change
       WHERE detected_at >= ?
       ORDER BY detected_at DESC, id DESC
       LIMIT ?`,
      [sinceIso, limit],
    );
  }

  countChanges(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM qdii_limit_change')?.n ?? 0;
  }

  // ---- 公告 ----

  upsertNotices(code: string, notices: readonly RawNotice[]): void {
    for (const notice of notices) {
      // 公告不可变，重复抓到直接忽略
      this.db.run(
        `INSERT INTO qdii_notice (id, code, title, publish_date, category)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        [notice.id, code, notice.title, notice.publishDate, notice.category],
      );
    }
  }

  loadNotices(
    code: string,
    limit: number,
  ): {
    id: string;
    title: string;
    publish_date: string;
  }[] {
    return this.db.all(
      `SELECT id, title, publish_date FROM qdii_notice
       WHERE code = ? ORDER BY publish_date DESC LIMIT ?`,
      [code, limit],
    );
  }

  // ---- 场内折溢价 ----

  upsertPremiums(
    items: readonly { code: string; price: number | null; discountRate: number | null }[],
    capturedAt: string,
  ): void {
    for (const item of items) {
      this.db.run(
        `INSERT INTO qdii_premium (code, captured_at, price, discount_rate)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(code, captured_at) DO UPDATE SET
           price = excluded.price, discount_rate = excluded.discount_rate`,
        [item.code, capturedAt, item.price, item.discountRate],
      );
    }
  }

  latestPremiumAt(): string | null {
    return (
      this.db.get<{ c: string | null }>('SELECT MAX(captured_at) AS c FROM qdii_premium')?.c ?? null
    );
  }

  loadPremiums(capturedAt: string): {
    code: string;
    price: number | null;
    discount_rate: number | null;
  }[] {
    return this.db.all(
      'SELECT code, price, discount_rate FROM qdii_premium WHERE captured_at = ?',
      [capturedAt],
    );
  }

  // ---- 详情缓存 ----

  saveDetail(code: string, payload: string, fetchedAt: string): void {
    this.db.run(
      `INSERT INTO qdii_detail_cache (code, fetched_at, payload)
       VALUES (?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload`,
      [code, fetchedAt, payload],
    );
  }

  loadDetail(code: string, maxAgeMs: number, now: number): string | null {
    const row = this.db.get<{ fetched_at: string; payload: string }>(
      'SELECT fetched_at, payload FROM qdii_detail_cache WHERE code = ?',
      [code],
    );
    if (!row) return null;
    if (now - Date.parse(row.fetched_at) > maxAgeMs) return null;
    return row.payload;
  }

  clearDetail(code: string): void {
    this.db.run('DELETE FROM qdii_detail_cache WHERE code = ?', [code]);
  }
}
