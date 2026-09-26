/**
 * 0012 —— 信息流与 AI 每日简报（`news` 工具，见 docs/design/news-tool.md §7）。
 *
 * 四张表：
 * 1. `news_source`    —— 信源运行状态（一个信源一行）：轮询节奏、ETag、失败退避都在这里；
 * 2. `news_item`      —— 信息流条目，**永久累积 + 180 天保留期清理**（由 `news.fetch` 顺带删）；
 * 3. `news_fetch_run` —— 一次抓取任务里「16 个信源可能 12 成 4 败」的**信源维度**健康留痕
 *                        （`job_run` 记的是任务维度，两者互补）；
 * 4. `news_summary`   —— AI 生成记录，**历史多份永久保留**（换模型/改提示词后可对比）。
 *
 * AI 配置与提示词**不建表**：走框架级 `app_setting` KV（0007 已有的理由逐条成立）。
 *
 * `news_item` 用**两个可空唯一索引**而不是一个 `canonical_url NOT NULL` 列：
 * Nikkei / Google News 经常给不出稳定 canonical，硬塞 NOT NULL 只会逼出伪造值。
 */
export const SQL = `
CREATE TABLE IF NOT EXISTS news_source (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  category        TEXT NOT NULL,
  weight          INTEGER NOT NULL,
  cadence_sec     INTEGER NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  etag            TEXT,
  last_modified   TEXT,
  last_fetched_at TEXT,
  next_fetch_at   TEXT NOT NULL,
  last_status     INTEGER,
  last_error      TEXT,
  consec_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS news_item (
  id           INTEGER PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES news_source(id),
  guid         TEXT,
  url          TEXT,
  dedup_key    TEXT,
  title        TEXT NOT NULL,
  summary      TEXT,
  published_at TEXT,
  fetched_at   TEXT NOT NULL,
  discovery    INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_news_item_url
  ON news_item(url) WHERE url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_item_dedup
  ON news_item(dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_news_item_pub    ON news_item(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_item_source ON news_item(source_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_item_fetch  ON news_item(fetched_at DESC);
-- 游标分页的排序键就是这个表达式（缺发布时间的条目按抓取时刻兜底）
CREATE INDEX IF NOT EXISTS idx_news_item_sort
  ON news_item(COALESCE(published_at, fetched_at) DESC, id DESC);

CREATE TABLE IF NOT EXISTS news_fetch_run (
  id          INTEGER PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok_feeds    INTEGER NOT NULL DEFAULT 0,
  fail_feeds  INTEGER NOT NULL DEFAULT 0,
  new_items   INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS news_summary (
  id                INTEGER PRIMARY KEY,
  window            TEXT NOT NULL,
  window_start      TEXT NOT NULL,
  window_end        TEXT NOT NULL,
  generated_at      TEXT NOT NULL,
  kind              TEXT NOT NULL,
  status            TEXT NOT NULL,
  model             TEXT,
  prompt_key        TEXT,
  prompt_hash       TEXT,
  payload           TEXT,
  item_count        INTEGER,
  dropped_count     INTEGER,
  invalid_refs      INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  duration_ms       INTEGER,
  error             TEXT
);

CREATE INDEX IF NOT EXISTS idx_news_summary_win ON news_summary(window, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_summary_gen ON news_summary(generated_at DESC);
`;
