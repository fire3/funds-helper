import { describe, expect, it } from 'vitest';
import { openDb } from '../client.ts';
import { runMigrations } from '../migrate.ts';
import { JobRunRepository } from './job-run.ts';

function setup(): { repo: JobRunRepository; db: ReturnType<typeof openDb> } {
  const db = openDb(':memory:');
  runMigrations(db);
  return { repo: new JobRunRepository(db), db };
}

describe('JobRunRepository', () => {
  it('记录任务开始与成功结束（含耗时与统计）', () => {
    const { repo } = setup();
    const id = repo.start('qdii.snapshot');
    repo.finish(id, { status: 'success', stats: { rows: 735 } });

    const latest = repo.latest('qdii.snapshot');
    expect(latest?.status).toBe('success');
    expect(latest?.finished_at).not.toBeNull();
    expect(latest?.duration_ms).toBeTypeOf('number');
    expect(JSON.parse(latest?.stats ?? '{}')).toEqual({ rows: 735 });
    expect(latest?.error).toBeNull();
  });

  it('记录失败与错误信息（任务失败必须可见，而不是只躺在日志里）', () => {
    const { repo } = setup();
    const id = repo.start('qdii.snapshot');
    repo.finish(id, { status: 'failed', error: '上游不可达' });

    const latest = repo.latest('qdii.snapshot');
    expect(latest?.status).toBe('failed');
    expect(latest?.error).toBe('上游不可达');
  });

  it('latest 取该任务最近一次执行', () => {
    const { repo } = setup();
    repo.finish(repo.start('qdii.snapshot'), { status: 'failed', error: '第一次' });
    repo.finish(repo.start('qdii.snapshot'), { status: 'success' });
    expect(repo.latest('qdii.snapshot')?.status).toBe('success');
  });

  it('latestPerJob 每个任务返回一条，供 /api/health 使用', () => {
    const { repo } = setup();
    repo.finish(repo.start('qdii.snapshot'), { status: 'success' });
    repo.finish(repo.start('qdii.premium'), { status: 'failed', error: 'x' });
    repo.finish(repo.start('qdii.snapshot'), { status: 'failed', error: 'y' });

    const summary = repo.latestPerJob();
    expect(summary).toHaveLength(2);
    const snapshot = summary.find((item) => item.jobName === 'qdii.snapshot');
    expect(snapshot?.status).toBe('failed');
    expect(snapshot?.error).toBe('y');
  });

  it('未知任务返回 undefined', () => {
    const { repo } = setup();
    expect(repo.latest('nope')).toBeUndefined();
  });

  it('prune 只保留每个任务最近 N 条', () => {
    const { repo } = setup();
    for (let i = 0; i < 10; i += 1) {
      repo.finish(repo.start('qdii.snapshot'), { status: 'success' });
    }
    repo.prune(3);
    expect(repo.recent(100)).toHaveLength(3);
  });
});
