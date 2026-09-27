import type { IndexBar } from '@funds-helper/core';
import type { Db } from '@funds-helper/db';

export interface IndexBarRow {
  data_date: string;
  open: number | null;
  low: number | null;
  high: number | null;
  close: number;
  source?: string;
}

export interface IndexBarInput {
  date: string;
  open: number | null;
  low: number | null;
  high: number | null;
  close: number;
}

/** 概览用的「最新 + 次新」收盘（算日涨跌；最新一根的 OHLC 一并给卡片展示） */
export interface IndexRecentClose {
  code: string;
  data_date: string;
  close: number;
  source: string;
  open: number | null;
  high: number | null;
  low: number | null;
}

/** 国际行情工具的全部 SQL（留在工具切片内，不下沉到 packages/db） */
export class IndicesRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * 整段 upsert。
   * 与 fx 同决策：上游一次给一段历史，整段写入**幂等且自愈**
   * （上游修订历史值时自动纠正）；重复抓取 inserted 为 0（唯一键 (code, data_date)）。
   */
  upsertBars(
    code: string,
    bars: readonly IndexBarInput[],
    capturedAt: string,
    source: string,
  ): void {
    for (const bar of bars) {
      this.db.run(
        `INSERT INTO index_quote_daily (code, data_date, captured_at, source, open, low, high, close)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code, data_date) DO UPDATE SET
           captured_at = excluded.captured_at,
           source = excluded.source,
           open = excluded.open,
           low = excluded.low,
           high = excluded.high,
           close = excluded.close`,
        [code, bar.date, capturedAt, source, bar.open, bar.low, bar.high, bar.close],
      );
    }
  }

  countBars(code: string): number {
    return (
      this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM index_quote_daily WHERE code = ?', [
        code,
      ])?.n ?? 0
    );
  }

  totalBars(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM index_quote_daily')?.n ?? 0;
  }

  latestBarDate(code: string): string | null {
    return (
      this.db.get<{ d: string | null }>(
        'SELECT MAX(data_date) AS d FROM index_quote_daily WHERE code = ?',
        [code],
      )?.d ?? null
    );
  }

  latestCapturedAt(code: string): string | null {
    return (
      this.db.get<{ c: string | null }>(
        'SELECT MAX(captured_at) AS c FROM index_quote_daily WHERE code = ?',
        [code],
      )?.c ?? null
    );
  }

  /** 全库最近一次抓取时刻（overview 的整体新鲜度用它判定是否需要刷新） */
  latestCapturedAtAny(): string | null {
    return (
      this.db.get<{ c: string | null }>('SELECT MAX(captured_at) AS c FROM index_quote_daily')?.c ??
      null
    );
  }

  /** 指定指数的最新一根（跨源漂移检查：抓之前先看库里同日那行是谁写的） */
  latestBar(code: string): IndexBarRow | null {
    return (
      this.db.get<IndexBarRow>(
        `SELECT data_date, open, low, high, close, source
         FROM index_quote_daily WHERE code = ? ORDER BY data_date DESC LIMIT 1`,
        [code],
      ) ?? null
    );
  }

  /** 按日期升序取全量（不依赖写入顺序） */
  loadBars(code: string): IndexBarRow[] {
    return this.db.all<IndexBarRow>(
      `SELECT data_date, open, low, high, close
       FROM index_quote_daily WHERE code = ? ORDER BY data_date`,
      [code],
    );
  }

  /**
   * 每个指数的最新两根收盘（概览的日涨跌）。
   * 窗口函数一次扫全表，比 N 次 `LIMIT 2` 查询省心；
   * 各市场休市节奏不同，所以必须逐指数取自己的最新日期。
   */
  loadRecentCloses(): IndexRecentClose[] {
    return this.db.all<IndexRecentClose>(
      `SELECT code, data_date, close, source, open, high, low FROM (
         SELECT code, data_date, close, source, open, high, low,
                ROW_NUMBER() OVER (PARTITION BY code ORDER BY data_date DESC) AS rn
         FROM index_quote_daily
       ) WHERE rn <= 2
       ORDER BY code, data_date DESC`,
    );
  }

  /** 各指数最新一行的上游集合（freshness.source：'yahoo' 或 'yahoo+eastmoney'） */
  latestSources(): string[] {
    return this.db
      .all<{ source: string }>(
        `SELECT DISTINCT source FROM (
           SELECT source, ROW_NUMBER() OVER (PARTITION BY code ORDER BY data_date DESC) AS rn
           FROM index_quote_daily
         ) WHERE rn = 1 ORDER BY source`,
      )
      .map((row) => row.source);
  }
}

export function rowToBar(row: IndexBarRow): IndexBar {
  return {
    date: row.data_date,
    open: row.open,
    low: row.low,
    high: row.high,
    close: row.close,
  };
}
