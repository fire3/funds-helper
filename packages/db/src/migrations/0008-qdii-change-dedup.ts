/**
 * 0008 —— QDII 额度变更事件去重。
 *
 * 变更事件由「实况快照 vs `previousDataDate`（严格早于当天的最近一天）」diff 推导。
 * 抓取任务每 30 分钟跑一次，而 `data_date` 是上游的日频数据日期：
 * 周六停更、节假日停更、乃至同一天多次抓取时，只要基线日没变，
 * 同一 (code, data_date, field) 的变化就会被**反复插入**一次。
 *
 * 唯一键 (code, data_date, field) 表达的语义正是我们想要的：
 * 「某只基金在某个数据日、某个字段的**当日净变化**」——
 * 跨天的多次变化各占一行，历史完整保留；同一天的重复只留最新一条。
 *
 * 已发布的迁移不可修改，因此这条独立追加：
 * 先清理存量重复（保留最后写入的那条，它反映当日最新的净值口径），再建唯一索引。
 * 索引一建好，`repository.insertChanges` 的 `ON CONFLICT` 才有落点。
 */
export const SQL = `
DELETE FROM qdii_limit_change
WHERE id NOT IN (
  SELECT MAX(id) FROM qdii_limit_change GROUP BY code, data_date, field
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_qdii_change_code_date_field
  ON qdii_limit_change(code, data_date, field);
`;
