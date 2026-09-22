/**
 * 0005 —— ETF 工具（`etf`）的 schema。
 *
 * 与前三个工具的差异：行情是**盘中快照**，同一交易日会被刷新多次。
 * 因此唯一键取 `(code, data_date)` 而不是 `(code, captured_at)`：
 * 同一天重复抓取覆盖同一行（幂等、自愈），同时天然留下「每日一行」的历史，
 * 未来要做「规模变化 / 成交额异动」时不需要再补一张表。
 *
 * 约定同 0001~0004：工具专属表按 `<tool>_<entity>` 命名；已发布的迁移不可修改。
 */
export const SQL = `
-- ETF 场内行情（唯一键 (code, data_date)）
CREATE TABLE IF NOT EXISTS etf_spot_daily (
  code         TEXT NOT NULL,
  data_date    TEXT NOT NULL,
  captured_at  TEXT NOT NULL,
  name         TEXT NOT NULL,
  market       TEXT NOT NULL,           -- 沪市 | 深市
  price        REAL,
  change_pct   REAL,
  change_amt   REAL,
  open         REAL,
  high         REAL,
  low          REAL,
  prev_close   REAL,
  amplitude    REAL,
  turnover     REAL,
  volume_ratio REAL,
  volume       REAL,
  amount       REAL,
  scale        REAL,                    -- 场内规模（元）
  float_scale  REAL,
  premium_rate REAL,                    -- 已取反：正 = 溢价
  listing_date TEXT,
  main_inflow  REAL,
  quote_at     TEXT,
  UNIQUE (code, data_date)
);
CREATE INDEX IF NOT EXISTS idx_etf_spot_daily_date ON etf_spot_daily(data_date DESC);
CREATE INDEX IF NOT EXISTS idx_etf_spot_daily_code ON etf_spot_daily(code, data_date DESC);

-- ETF 目录（接口 B）：跟踪指数 + 分类标志位 + 区间涨跌 + 份额
-- 分类结果不落库：只存标志位，读取时由 @funds-helper/core 判定（口径升级自动生效）
CREATE TABLE IF NOT EXISTS etf_profile (
  code             TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  index_code       TEXT,
  index_name       TEXT,
  is_money         INTEGER NOT NULL DEFAULT 0,
  is_cross_border  INTEGER NOT NULL DEFAULT 0,
  is_bond          INTEGER NOT NULL DEFAULT 0,
  is_commodity     INTEGER NOT NULL DEFAULT 0,
  is_broad         INTEGER NOT NULL DEFAULT 0,
  is_industry      INTEGER NOT NULL DEFAULT 0,
  is_style         INTEGER NOT NULL DEFAULT 0,
  change_1w        REAL,
  change_1m        REAL,
  change_3m        REAL,
  ytd_change       REAL,
  max_drawdown_1y  REAL,
  net_assets_yi    REAL,
  shares           REAL,
  captured_at      TEXT NOT NULL
);

-- 单只 ETF 详情缓存（接口 C + 通用区块的聚合结果）
CREATE TABLE IF NOT EXISTS etf_detail_cache (
  code       TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  payload    TEXT NOT NULL
);
`;
