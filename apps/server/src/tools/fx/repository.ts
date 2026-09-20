import type { Db } from '@funds-helper/db';

export interface FxBarRow {
  data_date: string;
  open: number | null;
  low: number | null;
  high: number | null;
  close: number;
}

export interface FxBarInput {
  date: string;
  open: number | null;
  low: number | null;
  high: number | null;
  close: number;
}

/** 汇率工具的全部 SQL（留在工具切片内，不下沉到 packages/db） */
export class FxRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * 整段 upsert 全量历史。
   *
   * 上游本就一次返回全量，整段写入是**幂等且自愈**的：上游修订历史值时能自动纠正，
   * 而「只写增量」需要额外判断增量边界，漏一次就永久缺一段。实测 8000 行在单事务内
   * 是百毫秒级，代价可以忽略。重复抓取时 `inserted` 为 0（唯一键 `(pair, data_date)`）。
   */
  upsertBars(pair: string, bars: readonly FxBarInput[], capturedAt: string): void {
    for (const bar of bars) {
      this.db.run(
        `INSERT INTO fx_rate_daily (pair, data_date, captured_at, open, low, high, close)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pair, data_date) DO UPDATE SET
           captured_at = excluded.captured_at,
           open = excluded.open,
           low = excluded.low,
           high = excluded.high,
           close = excluded.close`,
        [pair, bar.date, capturedAt, bar.open, bar.low, bar.high, bar.close],
      );
    }
  }

  countBars(pair: string): number {
    return (
      this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM fx_rate_daily WHERE pair = ?', [pair])
        ?.n ?? 0
    );
  }

  latestBarDate(pair: string): string | null {
    return (
      this.db.get<{ d: string | null }>(
        'SELECT MAX(data_date) AS d FROM fx_rate_daily WHERE pair = ?',
        [pair],
      )?.d ?? null
    );
  }

  latestCapturedAt(pair: string): string | null {
    return (
      this.db.get<{ c: string | null }>(
        'SELECT MAX(captured_at) AS c FROM fx_rate_daily WHERE pair = ?',
        [pair],
      )?.c ?? null
    );
  }

  /** 按日期升序取全量（上游已升序，这里仍显式排序，不依赖写入顺序） */
  loadBars(pair: string): FxBarRow[] {
    return this.db.all<FxBarRow>(
      `SELECT data_date, open, low, high, close
       FROM fx_rate_daily WHERE pair = ? ORDER BY data_date`,
      [pair],
    );
  }
}
