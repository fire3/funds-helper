/**
 * 0001 —— 初始 schema。
 *
 * 框架级表无前缀（`job_run`），工具专属表按 `<tool>_<entity>` 命名。
 * 新增工具时的 schema 变更在这里追加新的迁移文件，不要修改已发布的迁移。
 */
export const SQL = `
-- 任务执行日志：任何任务失败都能被看到，而不是只留在日志文件里
CREATE TABLE IF NOT EXISTS job_run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name    TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,
  duration_ms INTEGER,
  stats       TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_run_name_time ON job_run(job_name, started_at DESC);

-- 基金主数据
CREATE TABLE IF NOT EXISTS qdii_fund (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  fund_type     TEXT NOT NULL,
  currency      TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

-- 额度快照（时间序列核心表）
-- 唯一键 (code, data_date)：上游是日频数据，同一天多次抓取只保留最新一次
CREATE TABLE IF NOT EXISTS qdii_limit_snapshot (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL REFERENCES qdii_fund(code),
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
CREATE INDEX IF NOT EXISTS idx_qdii_snapshot_code_date ON qdii_limit_snapshot(code, data_date DESC);
CREATE INDEX IF NOT EXISTS idx_qdii_snapshot_date ON qdii_limit_snapshot(data_date DESC);
CREATE INDEX IF NOT EXISTS idx_qdii_snapshot_limit ON qdii_limit_snapshot(daily_limit);

-- 额度变更事件（由相邻两次快照 diff 推导，是趋势图与告警的数据基础）
CREATE TABLE IF NOT EXISTS qdii_limit_change (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL,
  data_date   TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  direction   TEXT NOT NULL,
  ratio       REAL
);
CREATE INDEX IF NOT EXISTS idx_qdii_change_code_date ON qdii_limit_change(code, data_date DESC);
CREATE INDEX IF NOT EXISTS idx_qdii_change_date ON qdii_limit_change(data_date DESC);

-- 申购类公告（接口 D，type=5）
CREATE TABLE IF NOT EXISTS qdii_notice (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL,
  title        TEXT NOT NULL,
  publish_date TEXT NOT NULL,
  category     TEXT
);
CREATE INDEX IF NOT EXISTS idx_qdii_notice_code_date ON qdii_notice(code, publish_date DESC);

-- 场内折溢价时间序列（接口 F）
CREATE TABLE IF NOT EXISTS qdii_premium (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL,
  captured_at   TEXT NOT NULL,
  price         REAL,
  discount_rate REAL,
  UNIQUE (code, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_qdii_premium_date ON qdii_premium(captured_at DESC);

-- 单只基金详情缓存（接口 B/G/H/I 的聚合结果）
CREATE TABLE IF NOT EXISTS qdii_detail_cache (
  code       TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  payload    TEXT NOT NULL
);
`;
