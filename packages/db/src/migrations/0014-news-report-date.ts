/**
 * 0014 —— 简报的「报告日」（`report_date`）。
 *
 * `news_summary` 原来只有 `window`（today / yesterday / last7d）与 UTC 的
 * `window_start` / `window_end`：同一份「今日简报」在库里无法直接按
 * **Asia/Shanghai 日历日**检索 —— 上海 00:00 对应 UTC 前一天 16:00，
 * `substr(window_start,1,10)` 会得到错误的那一天。
 *
 * 这里补一列显式的 `report_date`（`window` 为单日窗口时 = 覆盖的上海日历日，
 * 跨日窗口如 last7d 为 NULL），并回填历史行。信息流与中文简报的「按日期查看」
 * 都以它为准，历史简报因此可以直接从库里按日期取用。
 */
export const SQL = `
ALTER TABLE news_summary ADD COLUMN report_date TEXT;

UPDATE news_summary
   SET report_date = date(window_start, '+8 hours')
 WHERE window IN ('today', 'yesterday');

CREATE INDEX IF NOT EXISTS idx_news_summary_report_date
  ON news_summary(report_date, generated_at DESC);
`;
