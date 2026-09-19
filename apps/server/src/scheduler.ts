import type { JobRunRepository } from '@funds-helper/db';
import { Cron } from 'croner';
import type { FastifyBaseLogger } from 'fastify';
import type {
  JobDefinition,
  JobResult,
  JobRunner,
  JobTrigger,
  ToolContext,
} from './tools/types.ts';

interface RegisteredJob {
  definition: JobDefinition;
  context: ToolContext;
  timer: Cron;
}

export interface SchedulerDeps {
  timezone: string;
  jobRuns: JobRunRepository;
  logger: FastifyBaseLogger;
}

/**
 * 定时任务调度器。
 *
 * 设计要点：
 * - **注册与启用分离**：`register` 总是执行（手动触发因此可用），
 *   只有 `start()` 会真正挂上 cron（由 config.jobsEnabled 控制）。
 *   本地开发默认关闭任务，避免与服务器重复打上游。
 * - **单实例互斥**：同一任务重入时直接跳过，而不是排队。
 * - **执行留痕**：每次执行写 `job_run`，失败在 `/api/health` 可见。
 */
export class Scheduler implements JobRunner {
  private readonly jobs = new Map<string, RegisteredJob>();
  private readonly running = new Set<string>();
  private readonly deps: SchedulerDeps;
  private started = false;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  register(definition: JobDefinition, context: ToolContext): void {
    const timer = new Cron(
      definition.cron,
      {
        timezone: this.deps.timezone,
        paused: true,
        unref: true,
        name: definition.name,
        protect: true,
      },
      () => {
        void this.execute(definition.name, 'cron').catch(() => undefined);
      },
    );
    this.jobs.set(definition.name, { definition, context, timer });
  }

  /** 挂上 cron 定时器，并触发 runOnBoot 的任务 */
  start(): void {
    if (this.started) return;
    this.started = true;

    for (const job of this.jobs.values()) {
      job.timer.resume();
      const next = job.timer.nextRun();
      this.deps.logger.info(
        {
          job: job.definition.name,
          cron: job.definition.cron,
          nextRun: next?.toISOString() ?? null,
        },
        '定时任务已启用',
      );
      if (job.definition.runOnBoot) {
        void this.execute(job.definition.name, 'boot').catch(() => undefined);
      }
    }
  }

  stop(): void {
    for (const job of this.jobs.values()) job.timer.stop();
    this.started = false;
  }

  /** 下一次触发时间（供 /api/health 展示） */
  nextRuns(): { job: string; nextRun: string | null }[] {
    return [...this.jobs.values()].map((job) => ({
      job: job.definition.name,
      nextRun: job.timer.nextRun()?.toISOString() ?? null,
    }));
  }

  isRunning(name: string): boolean {
    return this.running.has(name);
  }

  async execute(name: string, trigger: JobTrigger = 'manual'): Promise<JobResult | undefined> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`未注册的任务：${name}`);

    if (this.running.has(name)) {
      this.deps.logger.warn({ job: name, trigger }, '任务仍在运行中，跳过本次触发');
      return undefined;
    }

    this.running.add(name);
    const runId = this.deps.jobRuns.start(name);
    const startedAt = Date.now();

    try {
      const result = await job.definition.handler(job.context);
      this.deps.jobRuns.finish(runId, {
        status: 'success',
        stats: { ...result?.stats, trigger, durationMs: Date.now() - startedAt },
      });
      this.deps.logger.info(
        { job: name, trigger, durationMs: Date.now() - startedAt, ...result?.stats },
        '任务执行成功',
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.jobRuns.finish(runId, { status: 'failed', error: message });
      this.deps.logger.error({ job: name, trigger, err: message }, '任务执行失败');
      throw error;
    } finally {
      this.running.delete(name);
    }
  }
}
