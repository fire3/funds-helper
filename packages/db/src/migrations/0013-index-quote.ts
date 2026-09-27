/**
 * 0013 —— 国际行情工具（`indices`）的 schema。
 *
 * 只有一张表：每个指数一条日线时间序列。
 * 指数元数据（名称/地区/币种/上游代码）是**静态注册表**（`core/indices/registry.ts`），
 * 不落库 —— 上游代码变了改代码即可，落库反而要写回填迁移。
 *
 * 约定同 0001–0012：工具专属表按 `<tool>_<entity>` 命名。
 */
export const SQL = `
-- 指数日线时间序列
-- 唯一键 (code, data_date)：同一指数同一天只保留最新一次抓取（整段 upsert，幂等且自愈）
-- source 记录这行数据实际来自哪个上游，用于跨源新鲜度校验与 freshness 展示
CREATE TABLE IF NOT EXISTS index_quote_daily (
  code        TEXT NOT NULL,           -- 注册表内部键，如 'SPX'
  data_date   TEXT NOT NULL,           -- 交易所当地交易日 YYYY-MM-DD
  captured_at TEXT NOT NULL,           -- 本地抓取时刻 ISO8601
  source      TEXT NOT NULL,           -- 'yahoo' | 'eastmoney'
  open        REAL,
  low         REAL,
  high        REAL,
  close       REAL NOT NULL,
  UNIQUE (code, data_date)
);
CREATE INDEX IF NOT EXISTS idx_index_quote_daily_code_date ON index_quote_daily(code, data_date DESC);
`;
