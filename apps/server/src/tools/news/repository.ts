import type { Db } from '@funds-helper/db';
import type { NewsWindow } from '@funds-helper/shared';
import { FEEDS } from '@funds-helper/sources';

/**
 * `news` 工具的全部 SQL（留在工具切片内，不下沉到 packages/db）。
 *
 * 关键取舍：
 * - `news_item` 的**去重靠两个可空唯一索引**（url / dedup_key），插入用 `INSERT OR IGNORE`：
 *   重抓同一批条目天然幂等，不需要先查后插的竞态窗口；
 * - `category` **不落条目表**（派生字段来自注册表，读时 JOIN 一次就够，architecture §5.2）；
 * - 信息流是**服务端分页 + 服务端筛选**：条目几个月就是几万行，全量返回不可行。
 */

export interface NewsSourceRow {
  id: string;
  name: string;
  url: string;
  category: string;
  weight: number;
  cadence_sec: number;
  enabled: number;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: string | null;
  next_fetch_at: string;
  last_status: number | null;
  last_error: string | null;
  consec_failures: number;
}

export interface NewsItemInput {
  sourceId: string;
  guid: string | null;
  url: string | null;
  /** 只在 `url` 为空时才有值（三段式去重的退化键） */
  dedupKey: string | null;
  title: string;
  summary: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  discovery: boolean;
}

/** 条目行 + JOIN 出来的信源元数据（分组来自注册表，读时查一次） */
export interface NewsItemRow {
  id: number;
  source_id: string;
  guid: string | null;
  url: string | null;
  dedup_key: string | null;
  title: string;
  summary: string | null;
  published_at: string | null;
  fetched_at: string;
  discovery: number;
  source_name: string;
  category: string;
}

export interface NewsFetchRunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  ok_feeds: number;
  fail_feeds: number;
  new_items: number;
  error: string | null;
}

export interface NewsSummaryInput {
  window: NewsWindow;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  kind: string;
  status: 'success' | 'failed';
  model: string | null;
  promptKey: string | null;
  promptHash: string | null;
  payload: string | null;
  itemCount: number | null;
  droppedCount: number | null;
  invalidRefs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number | null;
  error: string | null;
}

export interface NewsSummaryRow {
  id: number;
  window: NewsWindow;
  window_start: string;
  window_end: string;
  generated_at: string;
  kind: string;
  status: 'success' | 'failed';
  model: string | null;
  prompt_key: string | null;
  prompt_hash: string | null;
  payload: string | null;
  item_count: number | null;
  dropped_count: number | null;
  invalid_refs: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number | null;
  error: string | null;
}

/** 信息流的筛选条件（时间边界由 service 按 Asia/Shanghai 算好后传进来） */
export interface NewsFeedFilters {
  startIso: string | null;
  endIso: string | null;
  categories: readonly string[];
  sources: readonly string[];
  q: string;
}

export interface NewsFeedPageQuery extends NewsFeedFilters {
  cursor: { key: string; id: number } | null;
  limit: number;
}

const ITEM_COLUMNS = `i.id, i.source_id, i.guid, i.url, i.dedup_key, i.title, i.summary,
       i.published_at, i.fetched_at, i.discovery, s.name AS source_name, s.category AS category`;

/** 排序键：缺发布时间的条目按抓取时刻兜底（**绝不伪造 published_at**） */
const SORT_KEY = 'COALESCE(i.published_at, i.fetched_at)';

function placeholders(values: readonly string[]): string {
  return values.map(() => '?').join(', ');
}

export class NewsRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // -------------------------------------------------------------------------
  // 信源
  // -------------------------------------------------------------------------

  /**
   * 把注册表里的信源落到 `news_source`（只写注册表字段与首次到期时间，
   * **不碰** etag / 失败计数等运行时状态 —— 改代码不该重置退避）。
   */
  ensureSources(nowIso: string): void {
    this.db.transaction(() => {
      for (const feed of FEEDS) {
        this.db.run(
          `INSERT INTO news_source (id, name, url, category, weight, cadence_sec, enabled, next_fetch_at, consec_failures)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             url = excluded.url,
             category = excluded.category,
             weight = excluded.weight,
             cadence_sec = excluded.cadence_sec`,
          [feed.id, feed.name, feed.url, feed.category, feed.weight, feed.cadenceSec, nowIso],
        );
      }
      // 注册表里已经删掉的信源：停用而不是删行（历史条目的外键要保住）
      const keep = FEEDS.map((feed) => feed.id);
      this.db.run(`UPDATE news_source SET enabled = 0 WHERE id NOT IN (${placeholders(keep)})`, [
        ...keep,
      ]);
    });
  }

  loadSources(): NewsSourceRow[] {
    return this.db.all<NewsSourceRow>('SELECT * FROM news_source ORDER BY category, id');
  }

  loadDueSources(nowIso: string): NewsSourceRow[] {
    return this.db.all<NewsSourceRow>(
      'SELECT * FROM news_source WHERE enabled = 1 AND next_fetch_at <= ? ORDER BY category, id',
      [nowIso],
    );
  }

  sourceItemCounts(): Map<string, number> {
    const rows = this.db.all<{ source_id: string; n: number }>(
      'SELECT source_id, COUNT(*) AS n FROM news_item GROUP BY source_id',
    );
    return new Map(rows.map((row) => [row.source_id, row.n]));
  }

  markSourceSuccess(input: {
    id: string;
    etag: string | null;
    lastModified: string | null;
    fetchedAt: string;
    nextFetchAt: string;
    status: number;
  }): void {
    this.db.run(
      `UPDATE news_source
         SET etag = ?, last_modified = ?, last_fetched_at = ?, next_fetch_at = ?,
             last_status = ?, last_error = NULL, consec_failures = 0
       WHERE id = ?`,
      [input.etag, input.lastModified, input.fetchedAt, input.nextFetchAt, input.status, input.id],
    );
  }

  /**
   * 失败退避：`next_fetch_at` 按连续失败次数**逐次翻倍，上限 4 小时**。
   * 目的是避免每 10 分钟反复打一个正在挑战你的站点（403/429 会因此变成封禁）。
   */
  markSourceFailure(input: {
    id: string;
    fetchedAt: string;
    nextFetchAt: string;
    status: number | null;
    error: string;
  }): void {
    this.db.run(
      `UPDATE news_source
         SET last_fetched_at = ?, next_fetch_at = ?, last_status = ?, last_error = ?,
             consec_failures = consec_failures + 1
       WHERE id = ?`,
      [input.fetchedAt, input.nextFetchAt, input.status, input.error, input.id],
    );
  }

  // -------------------------------------------------------------------------
  // 条目
  // -------------------------------------------------------------------------

  /** 依赖 `url` / `dedup_key` 两个唯一索引去重：重复插入被忽略，返回**新增**行数 */
  insertItems(rows: readonly NewsItemInput[]): number {
    if (rows.length === 0) return 0;
    let inserted = 0;
    this.db.transaction(() => {
      for (const row of rows) {
        const result = this.db.run(
          `INSERT OR IGNORE INTO news_item
             (source_id, guid, url, dedup_key, title, summary, published_at, fetched_at, discovery)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.sourceId,
            row.guid,
            row.url,
            row.dedupKey,
            row.title,
            row.summary,
            row.publishedAt,
            row.fetchedAt,
            row.discovery ? 1 : 0,
          ],
        );
        inserted += result.changes;
      }
    });
    return inserted;
  }

  /** 保留期清理（默认 180 天），由 `news.fetch` 顺带执行 */
  deleteItemsBefore(cutoffIso: string): number {
    return this.db.run('DELETE FROM news_item WHERE fetched_at < ?', [cutoffIso]).changes;
  }

  countItemsSince(iso: string): number {
    return (
      this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_item WHERE fetched_at > ?', [iso])
        ?.n ?? 0
    );
  }

  private whereFor(filters: NewsFeedFilters): { sql: string; params: (string | number)[] } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (filters.startIso !== null) {
      clauses.push(`${SORT_KEY} >= ?`);
      params.push(filters.startIso);
    }
    if (filters.endIso !== null) {
      clauses.push(`${SORT_KEY} < ?`);
      params.push(filters.endIso);
    }
    if (filters.categories.length > 0) {
      clauses.push(`s.category IN (${placeholders(filters.categories)})`);
      params.push(...filters.categories);
    }
    if (filters.sources.length > 0) {
      clauses.push(`i.source_id IN (${placeholders(filters.sources)})`);
      params.push(...filters.sources);
    }
    if (filters.q !== '') {
      // SQLite 的 LIKE 对 ASCII 默认大小写不敏感，正合「搜英文标题」的需要
      clauses.push('(i.title LIKE ? OR i.summary LIKE ?)');
      const like = `%${filters.q}%`;
      params.push(like, like);
    }

    return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  /** 一页信息流（游标分页：keyset，持续写入时不会漏行/重行） */
  queryFeedPage(query: NewsFeedPageQuery): NewsItemRow[] {
    const base = this.whereFor(query);
    const clauses = base.sql === '' ? [] : [base.sql.slice(6)]; // 去掉 'WHERE '
    const params = [...base.params];

    if (query.cursor !== null) {
      clauses.push(`(${SORT_KEY} < ? OR (${SORT_KEY} = ? AND i.id < ?))`);
      params.push(query.cursor.key, query.cursor.key, query.cursor.id);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.all<NewsItemRow>(
      `SELECT ${ITEM_COLUMNS}
       FROM news_item i JOIN news_source s ON s.id = i.source_id
       ${where}
       ORDER BY ${SORT_KEY} DESC, i.id DESC
       LIMIT ?`,
      [...params, query.limit],
    );
  }

  countFeed(filters: NewsFeedFilters): number {
    const base = this.whereFor(filters);
    return (
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n
         FROM news_item i JOIN news_source s ON s.id = i.source_id
         ${base.sql}`,
        base.params,
      )?.n ?? 0
    );
  }

  /** 简报窗口内的条目（同一条排序口径，超大窗口截断到 `limit` 条） */
  queryWindow(filters: NewsFeedFilters, limit: number): NewsItemRow[] {
    const base = this.whereFor(filters);
    return this.db.all<NewsItemRow>(
      `SELECT ${ITEM_COLUMNS}
       FROM news_item i JOIN news_source s ON s.id = i.source_id
       ${base.sql}
       ORDER BY ${SORT_KEY} DESC, i.id DESC
       LIMIT ?`,
      [...base.params, limit],
    );
  }

  latestFetchedAt(): string | null {
    return (
      this.db.get<{ t: string | null }>('SELECT MAX(fetched_at) AS t FROM news_item')?.t ?? null
    );
  }

  latestPublishedAt(): string | null {
    return (
      this.db.get<{ t: string | null }>('SELECT MAX(published_at) AS t FROM news_item')?.t ?? null
    );
  }

  // -------------------------------------------------------------------------
  // 抓取任务留痕
  // -------------------------------------------------------------------------

  startFetchRun(startedAt: string): number {
    return this.db.run('INSERT INTO news_fetch_run (started_at) VALUES (?)', [startedAt])
      .lastInsertRowid;
  }

  finishFetchRun(
    id: number,
    input: {
      finishedAt: string;
      okFeeds: number;
      failFeeds: number;
      newItems: number;
      error: string | null;
    },
  ): void {
    this.db.run(
      'UPDATE news_fetch_run SET finished_at = ?, ok_feeds = ?, fail_feeds = ?, new_items = ?, error = ? WHERE id = ?',
      [input.finishedAt, input.okFeeds, input.failFeeds, input.newItems, input.error, id],
    );
  }

  lastFetchRun(): NewsFetchRunRow | null {
    return (
      this.db.get<NewsFetchRunRow>('SELECT * FROM news_fetch_run ORDER BY id DESC LIMIT 1') ?? null
    );
  }

  // -------------------------------------------------------------------------
  // 简报
  // -------------------------------------------------------------------------

  insertSummary(input: NewsSummaryInput): number {
    return this.db.run(
      `INSERT INTO news_summary
         (window, window_start, window_end, generated_at, kind, status, model, prompt_key,
          prompt_hash, payload, item_count, dropped_count, invalid_refs,
          prompt_tokens, completion_tokens, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.window,
        input.windowStart,
        input.windowEnd,
        input.generatedAt,
        input.kind,
        input.status,
        input.model,
        input.promptKey,
        input.promptHash,
        input.payload,
        input.itemCount,
        input.droppedCount,
        input.invalidRefs,
        input.promptTokens,
        input.completionTokens,
        input.durationMs,
        input.error,
      ],
    ).lastInsertRowid;
  }

  /** 该窗口最近一次**成功**的简报（UI 取最新，失败的那次要能在历史里看到） */
  latestSuccessSummary(window: NewsWindow): NewsSummaryRow | null {
    return (
      this.db.get<NewsSummaryRow>(
        `SELECT * FROM news_summary WHERE window = ? AND status = 'success'
         ORDER BY generated_at DESC, id DESC LIMIT 1`,
        [window],
      ) ?? null
    );
  }

  /** 该窗口最近一次记录（含失败）：`today` 的陈旧规则按它算 */
  latestSummary(window: NewsWindow): NewsSummaryRow | null {
    return (
      this.db.get<NewsSummaryRow>(
        'SELECT * FROM news_summary WHERE window = ? ORDER BY generated_at DESC, id DESC LIMIT 1',
        [window],
      ) ?? null
    );
  }

  history(window: NewsWindow, limit = 50): NewsSummaryRow[] {
    return this.db.all<NewsSummaryRow>(
      'SELECT * FROM news_summary WHERE window = ? ORDER BY generated_at DESC, id DESC LIMIT ?',
      [window, limit],
    );
  }

  /** 今日（Asia/Shanghai 的起始时刻）以来的调用次数 —— `dailyLimit` 的计数口径 */
  countSummariesSince(iso: string): number {
    return (
      this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_summary WHERE generated_at >= ?', [
        iso,
      ])?.n ?? 0
    );
  }

  /** 最近一次「非测试」调用的 token 数（设置页的用量展示） */
  lastUsage(): { promptTokens: number | null; completionTokens: number | null; at: string } | null {
    const row = this.db.get<{
      prompt_tokens: number | null;
      completion_tokens: number | null;
      generated_at: string;
    }>(
      `SELECT prompt_tokens, completion_tokens, generated_at FROM news_summary
       WHERE kind <> 'test' AND status = 'success'
       ORDER BY generated_at DESC, id DESC LIMIT 1`,
    );
    if (row === undefined) return null;
    return {
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      at: row.generated_at,
    };
  }
}
