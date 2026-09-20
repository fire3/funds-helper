/**
 * 0004 —— 汇率工具（`fx`）的 schema。
 *
 * 与前两个工具不同，这里只需要**一张表**：汇率是单一时序，
 * 没有主数据、没有变更事件、没有详情缓存 —— 上游一次就给全量历史。
 *
 * 约定同 0001/0002：工具专属表按 `<tool>_<entity>` 命名。
 */
export const SQL = `
-- 汇率日线时间序列
-- 唯一键 (pair, data_date)：上游按日期给点，同一天重复抓取只保留最新一次（幂等）
CREATE TABLE IF NOT EXISTS fx_rate_daily (
  pair        TEXT NOT NULL,           -- 'USD/CNY'，与 core 的 FX_DIRECTIONS 同源
  data_date   TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  open        REAL,
  low         REAL,
  high        REAL,
  close       REAL NOT NULL,
  UNIQUE (pair, data_date)
);
CREATE INDEX IF NOT EXISTS idx_fx_rate_daily_pair_date ON fx_rate_daily(pair, data_date DESC);
`;
