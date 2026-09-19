/**
 * 0003 —— 给 `usd_snapshot` 增加 `channel_not_sold` 标志。
 *
 * 背景：上游把美元份额的「渠道不售」写成日限额 `0`，归一化后会与「真无限额」都变成 `NULL`，
 * 因此需要单独记一个标志，读取时才能还原「渠道不适用」的文案。
 *
 * 为什么单独成一条迁移而不是并进 0002：0002 已经发布（在已有数据库里被记录为已应用），
 * 按「已发布的迁移不可修改」的约定，只能像这样**追加**一条 ALTER 来补齐列。
 * 这样既有数据库与全新数据库都会收敛到同一 schema。
 */
export const SQL = `
ALTER TABLE usd_snapshot ADD COLUMN channel_not_sold INTEGER NOT NULL DEFAULT 0;
`;
