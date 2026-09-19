import type { JobDefinition } from '../types.ts';
import type { UsdService } from './service.ts';

/**
 * 美元份额工具的定时任务。
 *
 * 与 QDII 同源同频：接口 A 是**日频**数据，30 分钟一次已远超数据变化频率，
 * 是对非官方接口保持克制的下限。
 */
export function usdJobs(service: UsdService): JobDefinition[] {
  return [
    {
      name: 'usd.snapshot',
      cron: '*/30 * * * *',
      runOnBoot: true,
      handler: async () => {
        const stats = await service.captureSnapshot();
        return { stats: { ...stats } };
      },
    },
  ];
}
