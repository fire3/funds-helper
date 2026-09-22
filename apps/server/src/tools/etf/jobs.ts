import type { JobDefinition } from '../types.ts';
import type { EtfService } from './service.ts';

/**
 * ETF 工具的定时任务。
 *
 * 频率依据：场内行情只在**交易时段**变化，收盘后价格不再变动 ——
 * 因此把 cron 限制在周一~周五 9:00–15:30（每 30 分钟），每天 14 次，
 * 比 QDII/美元份额的全天候 30 分钟更克制（那两者的额度与限购公告随时可能调整）。
 *
 * 每次快照 19 个请求（行情 17 页 + 目录 2 页，见 docs/design/etf-data-sources.md §5），
 * 约 266 请求/天。
 */
export function etfJobs(service: EtfService): JobDefinition[] {
  return [
    {
      name: 'etf.snapshot',
      cron: '*/30 9-15 * * 1-5',
      runOnBoot: true,
      handler: async () => {
        const stats = await service.captureSnapshot();
        return { stats: { ...stats } };
      },
    },
  ];
}
