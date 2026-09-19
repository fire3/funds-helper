import type { JobDefinition } from '../types.ts';
import type { QdiiService } from './service.ts';

/**
 * QDII 工具的定时任务。
 *
 * 频率依据：上游是**日频**数据（接口 A 的 showday 只到日），
 * 30 分钟一次已经远超数据变化频率，是对非官方接口保持克制的下限。
 */
export function qdiiJobs(service: QdiiService): JobDefinition[] {
  return [
    {
      name: 'qdii.snapshot',
      cron: '*/30 * * * *',
      runOnBoot: true,
      handler: async () => {
        const stats = await service.captureSnapshot();
        return { stats: { ...stats } };
      },
    },
    {
      name: 'qdii.premium',
      // 交易时段（9:00-15:59）每 30 分钟，工作日
      cron: '*/30 9-15 * * 1-5',
      handler: async () => {
        const premium = await service.getPremium(true);
        return { stats: { total: premium.items.length, stale: premium.freshness.stale } };
      },
    },
  ];
}
