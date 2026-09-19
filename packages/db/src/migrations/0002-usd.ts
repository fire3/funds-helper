/**
 * 0002 —— 美元份额工具（`usd`）的 schema。
 *
 * 约定同 0001：工具专属表按 `<tool>_<entity>` 命名。
 * 已发布的迁移不可修改，只能像这样追加新文件。
 */
export const SQL = `
-- 美元份额主数据（随快照更新）
CREATE TABLE IF NOT EXISTS usd_fund (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  fund_type     TEXT NOT NULL,
  currency      TEXT NOT NULL,
  usd_kind      TEXT NOT NULL,          -- 现汇 | 现钞 | 未标注
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

-- 美元份额额度快照（时间序列；唯一键 (code, data_date)，同一天重复抓取只保留最新）
CREATE TABLE IF NOT EXISTS usd_snapshot (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL REFERENCES usd_fund(code),
  data_date      TEXT NOT NULL,
  captured_at    TEXT NOT NULL,
  status         TEXT NOT NULL,
  redeem_status  TEXT NOT NULL,
  daily_limit    REAL,
  min_purchase   REAL,
  next_open_date TEXT,
  nav            REAL,
  nav_date       TEXT,
  fee            TEXT,
  UNIQUE (code, data_date)
);
CREATE INDEX IF NOT EXISTS idx_usd_snapshot_code_date ON usd_snapshot(code, data_date DESC);
CREATE INDEX IF NOT EXISTS idx_usd_snapshot_date ON usd_snapshot(data_date DESC);

-- 同基金其它份额（人民币对照用）：抓取时从同一份全市场快照里按份额家族算好
CREATE TABLE IF NOT EXISTS usd_sibling (
  usd_code            TEXT NOT NULL,
  sibling_code        TEXT NOT NULL,
  sibling_name        TEXT NOT NULL,
  sibling_currency    TEXT NOT NULL,
  sibling_status      TEXT NOT NULL,
  sibling_daily_limit REAL,
  PRIMARY KEY (usd_code, sibling_code)
);
CREATE INDEX IF NOT EXISTS idx_usd_sibling_usd_code ON usd_sibling(usd_code);

-- 单只基金详情缓存（接口 B/G/H/I 的聚合结果）
CREATE TABLE IF NOT EXISTS usd_detail_cache (
  code       TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  payload    TEXT NOT NULL
);
`;
