/**
 * 0011 —— 热点研究的两处落库（见 docs/design/etf-hotspot.md §4）。
 *
 * 1. `etf_period_return`：接口 H 的区间涨幅（近6月/近1年/近3年 + 沪深300 同期）。
 *    每只 ETF 一行、`code` 主键 —— 重抓覆盖同一行（幂等），`captured_at` 即新鲜度依据；
 *    抓取失败的代码**不写库**，旧行原样保留，下轮自动重试。
 *
 * 2. `etf_spot_daily.shares`：快照时从目录（接口 B）写入当日总份额。
 *    行情表本来就是每日一行的时间序列，加这一列后它同时是**份额序列** ——
 *    份额申赎 = 一级市场净申购，这是「资金进出」最直接的代理（成交额只是二级市场换手）。
 *    从启用日起积累，起点之前的窗口没有历史（界面须标注，见设计文档 §9）。
 */
export const SQL = `
CREATE TABLE IF NOT EXISTS etf_period_return (
  code        TEXT PRIMARY KEY,
  data_date   TEXT,
  captured_at TEXT NOT NULL,
  ret_6m      REAL,
  ret_1y      REAL,
  ret_3y      REAL,
  bench_1y    REAL,
  bench_3y    REAL
);

ALTER TABLE etf_spot_daily ADD COLUMN shares REAL;
`;
