import type { JobDefinition } from '../types.ts';
import type { FxService } from './service.ts';

/**
 * 汇率工具的定时任务。
 *
 * 频率依据：上游是**日频**日线，每 3 小时一次（约 8 次/天 × 320 KB）已是克制下限。
 * 比 QDII / 美元份额的 30 分钟宽松 —— 汇率不需要盘中变化，
 * 而 qdii/usd 的 30 分钟是「额度与限购公告随时可能调整」换来的。
 */
export function fxJobs(service: FxService): JobDefinition[] {
  return [
    {
      name: 'fx.daily',
      cron: '0 */3 * * *',
      runOnBoot: true,
      handler: async () => {
        const stats = await service.captureSnapshot();
        return { stats: { ...stats } };
      },
    },
  ];
}
