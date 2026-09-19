import type { JobRunRepository } from '@funds-helper/db';
import type { ToolDescriptor } from '@funds-helper/shared';
import type { FastifyInstance } from 'fastify';
import type { Scheduler } from '../scheduler.ts';

export interface HealthDeps {
  dbPath: string;
  jobRuns: JobRunRepository;
  scheduler: Scheduler;
  tools: readonly ToolDescriptor[];
  startedAt: number;
}

/** 三个问题：服务活着吗？依赖可用吗？任务最近跑成功了吗？ */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/api/health', () => {
    let dbOk = true;
    let dbError: string | null = null;
    try {
      deps.jobRuns.latestPerJob();
    } catch (error) {
      dbOk = false;
      dbError = error instanceof Error ? error.message : String(error);
    }

    return {
      status: dbOk ? 'ok' : 'degraded',
      uptimeMs: Date.now() - deps.startedAt,
      time: new Date().toISOString(),
      db: { ok: dbOk, path: deps.dbPath, error: dbError },
      tools: deps.tools.map((tool) => ({ id: tool.id, name: tool.name, status: tool.status })),
      jobs: deps.jobRuns.latestPerJob().map((job) => ({
        ...job,
        nextRun:
          deps.scheduler.nextRuns().find((item) => item.job === job.jobName)?.nextRun ?? null,
        running: deps.scheduler.isRunning(job.jobName),
      })),
    };
  });
}
