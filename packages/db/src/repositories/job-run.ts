import type { Db } from '../client.ts';

export type JobStatus = 'running' | 'success' | 'failed';

export interface JobRunRow {
  id: number;
  job_name: string;
  started_at: string;
  finished_at: string | null;
  status: JobStatus;
  duration_ms: number | null;
  stats: string | null;
  error: string | null;
}

export interface JobFinishResult {
  status: Exclude<JobStatus, 'running'>;
  stats?: Record<string, unknown> | undefined;
  error?: string | undefined;
}

/**
 * 任务执行留痕。
 * 目的：任务失败时能在 `/api/health` 里被看到，而不是只躺在日志文件里。
 */
export class JobRunRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  start(jobName: string): number {
    const result = this.db.run(
      'INSERT INTO job_run (job_name, started_at, status) VALUES (?, ?, ?)',
      [jobName, new Date().toISOString(), 'running'],
    );
    return result.lastInsertRowid;
  }

  finish(id: number, result: JobFinishResult): void {
    const finishedAt = new Date().toISOString();
    const started = this.db.get<{ started_at: string }>(
      'SELECT started_at FROM job_run WHERE id = ?',
      [id],
    );
    const durationMs = started ? Date.parse(finishedAt) - Date.parse(started.started_at) : null;

    this.db.run(
      'UPDATE job_run SET finished_at = ?, status = ?, duration_ms = ?, stats = ?, error = ? WHERE id = ?',
      [
        finishedAt,
        result.status,
        durationMs,
        result.stats === undefined ? null : JSON.stringify(result.stats),
        result.error ?? null,
        id,
      ],
    );
  }

  latest(jobName: string): JobRunRow | undefined {
    return this.db.get<JobRunRow>(
      'SELECT * FROM job_run WHERE job_name = ? ORDER BY started_at DESC, id DESC LIMIT 1',
      [jobName],
    );
  }

  recent(limit = 20): JobRunRow[] {
    return this.db.all<JobRunRow>(
      'SELECT * FROM job_run ORDER BY started_at DESC, id DESC LIMIT ?',
      [limit],
    );
  }

  /** 每个任务最近一次执行的概要（供 /api/health 使用） */
  latestPerJob(): {
    jobName: string;
    status: JobStatus;
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
  }[] {
    return this.db
      .all<JobRunRow>(
        `SELECT * FROM job_run j
         WHERE id = (SELECT id FROM job_run WHERE job_name = j.job_name ORDER BY started_at DESC, id DESC LIMIT 1)
         ORDER BY job_name`,
      )
      .map((row) => ({
        jobName: row.job_name,
        status: row.status,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        error: row.error,
      }));
  }

  /** 清理历史（保留最近 N 条），避免日志表无限增长 */
  prune(keepPerJob = 100): number {
    const result = this.db.run(
      `DELETE FROM job_run
       WHERE id NOT IN (
         SELECT id FROM job_run j
         WHERE id IN (SELECT id FROM job_run WHERE job_name = j.job_name ORDER BY id DESC LIMIT ?)
       )`,
      [keepPerJob],
    );
    return result.changes;
  }
}
