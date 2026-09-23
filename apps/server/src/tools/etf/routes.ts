import {
  ETF_SPOT_SOURCES,
  type EtfConfigUpdateResponse,
  EtfConfigUpdateSchema,
  type EtfRefreshResponse,
} from '@funds-helper/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { badRequest } from '../../errors.ts';
import type { ToolContext } from '../types.ts';
import type { EtfCaptureStats, EtfService } from './service.ts';

function queryOf(request: FastifyRequest): Record<string, unknown> {
  const query: unknown = request.query ?? {};
  return typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
}

function flag(value: unknown): boolean {
  return value === '1' || value === 'true';
}

/** 抓取结果 → 对外响应（手动刷新与「切换渠道后自动重抓」共用一套文案） */
function refreshResponse(stats: Partial<EtfCaptureStats>): EtfRefreshResponse {
  // stats 理论上一定带 source；缺失时按默认渠道兜底（不要让响应少一个必填字段）
  const source = stats.source ?? 'sina';
  const channel = ETF_SPOT_SOURCES[source];

  return {
    ok: true,
    source,
    spot: stats.spot ?? 0,
    profile: stats.profile ?? 0,
    inserted: stats.inserted ?? 0,
    dataDate: stats.dataDate ?? null,
    durationMs: stats.durationMs ?? 0,
    message:
      `已通过「${channel.name}」拉取 ${stats.spot ?? 0} 只 ETF 行情` +
      `（数据日期 ${stats.dataDate ?? '未知'}）` +
      (channel.missing.length > 0 ? `，该渠道不含${channel.missing.join('、')}` : '') +
      `、${stats.profile ?? 0} 条目录` +
      (stats.profileError === undefined ? '' : `（目录失败：${stats.profileError}）`),
  };
}

export function registerEtfRoutes(
  app: FastifyInstance,
  ctx: ToolContext,
  service: EtfService,
): void {
  /** 全量数据集（行情 + 目录 + 统计）：一次返回，筛选/排序全部在前端完成 */
  app.get('/dataset', async (request) => service.getDataset(flag(queryOf(request).refresh)));

  /** 单只 ETF 详情：接口 C + 通用区块，按 code 缓存 */
  app.get('/funds/:code', async (request) => {
    const params: unknown = request.params ?? {};
    const code = (params as { code?: string }).code ?? '';
    return service.getFundDetail(code, flag(queryOf(request).refresh));
  });

  /** 行情渠道配置：当前偏好、实际渠道、各渠道的能力差异（只读本地） */
  app.get('/config', async () => service.getConfig());

  /**
   * 切换行情渠道（东财 ↔ 新浪）。
   *
   * 写完偏好后**立刻重抓一次**：否则界面拿到的还是旧渠道的数据，
   * 出现「偏好新浪、数据里却有折溢价」这种自相矛盾的画面。
   * 抓取失败不吞掉：偏好已保存，错误照常上报（前端会提示）。
   */
  app.put('/config', async (request): Promise<EtfConfigUpdateResponse> => {
    const parsed = EtfConfigUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('行情渠道只能是 eastmoney 或 sina', JSON.stringify(request.body));
    }
    service.setSpotSourcePreference(parsed.data.spotSource);

    const result = await ctx.jobs.execute('etf.snapshot', 'manual');
    const stats = (result?.stats ?? {}) as Partial<EtfCaptureStats>;
    return { config: service.getConfig(), refresh: refreshResponse(stats) };
  });

  /**
   * 手动触发一次快照抓取。
   * 走调度器而不是直接调 service：这样手动刷新同样留下 job_run 记录。
   */
  app.post('/refresh', async () => {
    const result = await ctx.jobs.execute('etf.snapshot', 'manual');
    return refreshResponse((result?.stats ?? {}) as Partial<EtfCaptureStats>);
  });

  /**
   * 手动触发一次「场外联接基金」反查。
   *
   * 默认只补候选池里的新增（几十个请求）；`?full=1` 是全量重建（**约 2300 个请求 / 4 分钟**），
   * 用于首次建库或清理已清盘的联接基金 —— 界面上的按钮只在「还没查过」时才带这个参数。
   * 不走调度器：这个链路是独立任务，且比行情快照慢得多，混在一起会让 job_run 很难读。
   */
  app.post('/feeders/refresh', async (request) =>
    service.refreshFeederFundsResponse({ full: flag(queryOf(request).full) }),
  );

  /**
   * 手动触发一次「区间涨幅」抓取（接口 H 的 6月/1年/3年，热点研究的长窗口）。
   *
   * 默认只抓「缺失或超过 7 天」的行；`?full=1` 忽略新鲜度强制全抓。
   * 与 feeders 一样是**慢链路**（约 1500 个请求 / 3 分钟，首次建库时），
   * 界面上要有等待提示；不走调度器 —— 手动触发没有 cron 语义，留 job_run 反而难读。
   */
  app.post('/periods/refresh', async (request) =>
    service.refreshPeriodReturnsResponse({ full: flag(queryOf(request).full) }),
  );
}
