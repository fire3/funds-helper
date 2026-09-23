/**
 * 0010 —— 修正 `etf_feeder_fund` 的主键：`feeder_code` 单列主键。
 *
 * 0009 在某些已建库的环境里落地的是**联合主键 `(etf_code, feeder_code)`** 的旧结构
 * （0009 定稿前建的表）。迁移状态记在库里、DDL 又是 `CREATE TABLE IF NOT EXISTS`，
 * 所以 0009 不会重跑，旧结构就一直留着 —— 于是 `repository.upsertFeederFunds` 的
 * `ON CONFLICT(feeder_code)` 找不到唯一约束，**每次反查都在写入时抛
 * `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`**：
 * 事务回滚 → 一行都没落库 → `ETF_FEEDER_SCANNED_AT_KEY` 也写不进去，
 * 界面永远停在「（尚未反查）」。
 *
 * 已发布的迁移不可修改，只能追加这条来收敛：
 * - 旧结构下同一只联接基金可能挂在多只 ETF 下（联合主键允许），新主键只留一条 ——
 *   按 `captured_at` 最新、同批次取最后一行，语义是「保留最近一次反查到的目标 ETF」；
 * - 表重建后索引随表被删，按 0009 的读取路径（按 `etf_code` 取全部联接份额）重建。
 */
export const SQL = `
CREATE TABLE etf_feeder_fund_v2 (
  feeder_code TEXT PRIMARY KEY,
  etf_code    TEXT NOT NULL,
  feeder_name TEXT NOT NULL,
  report_date TEXT,
  captured_at TEXT NOT NULL
);

INSERT INTO etf_feeder_fund_v2 (feeder_code, etf_code, feeder_name, report_date, captured_at)
SELECT feeder_code, etf_code, feeder_name, report_date, captured_at
FROM (
  SELECT feeder_code, etf_code, feeder_name, report_date, captured_at,
         ROW_NUMBER() OVER (
           PARTITION BY feeder_code ORDER BY captured_at DESC, rowid DESC
         ) AS rn
  FROM etf_feeder_fund
)
WHERE rn = 1;

DROP TABLE etf_feeder_fund;
ALTER TABLE etf_feeder_fund_v2 RENAME TO etf_feeder_fund;

CREATE INDEX IF NOT EXISTS idx_etf_feeder_fund_etf ON etf_feeder_fund(etf_code);
`;
