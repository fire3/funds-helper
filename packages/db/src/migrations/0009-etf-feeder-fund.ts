/**
 * 0009 —— ETF 的**场外联接基金**映射（`etf_feeder_fund`）。
 *
 * 这张表与另外三张 `etf_*` 表的性质不同：它不是行情快照，而是**关系映射**，
 * 而且采集成本高出两个数量级（全量 ≈ 2300 个上游请求，见 docs/design/etf-tool.md §11.4）。
 * 因此：
 *
 * - **不按交易日分区**：联接关系以年为单位变化，主键取 `feeder_code`（**联接基金 → 目标 ETF 是唯一方向**：
 *   一只联接基金只持有一只 ETF，而一只 ETF 可以有 A/C/E/I 多个联接份额，
 *   所以「以联接基金为主键」既能表达一对多，又能靠 upsert 自动收敛「换了目标 ETF」）；
 * - `report_date` 是接口 I 的持仓报告期 —— 它解释了「为什么有的联接基金查不到目标 ETF」
 *   （新成立、首份定期报告还没出），比只存一个抓取时刻信息量更大；
 * - 退市/清盘的联接基金不会被自动删除（增量刷新只做新增），要靠手动全量重建收敛，
 *   这一点写进了设计文档的口径边界。
 *
 * 约定同 0001~0008：工具专属表按 `<tool>_<entity>` 命名；已发布的迁移不可修改。
 */
export const SQL = `
-- 场外联接基金（主键 feeder_code：一只联接基金只持有一只 ETF，一只 ETF 可以有多个联接份额）
CREATE TABLE IF NOT EXISTS etf_feeder_fund (
  feeder_code TEXT PRIMARY KEY,
  etf_code    TEXT NOT NULL,
  feeder_name TEXT NOT NULL,
  report_date TEXT,                    -- 接口 I 的 Expansion（持仓报告期）
  captured_at TEXT NOT NULL
);
-- 读取路径是「按 ETF 取全部联接份额」（数据集 join），因此索引建在 etf_code 上
CREATE INDEX IF NOT EXISTS idx_etf_feeder_fund_etf ON etf_feeder_fund(etf_code);
`;
