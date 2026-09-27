import type { JobDefinition } from '../types.ts';
import type { IndicesService } from './service.ts';

/**
 * 国际行情工具的定时任务。
 *
 * 频率依据：数据是**日频收盘价**，且各市场收盘时刻（北京时间）不同 ——
 * 港股 16:00、日股 15:00、欧洲约 23:00、美股次日 04:00/05:00。
 * 每 3 小时增量抓一次（增量只有每指数约两周数据，请求量很小），
 * 既能在各市场收盘后尽快拿到当日数据，也不会像 30 分钟那样打扰上游 ——
 * 与 fx 的「每 3 小时」同理由，分钟位错开到 20 分避免与其它任务整点撞车。
 * （cron：`20 <星>/3 * * *`，星号为避免提前终止本注释而写作汉字替换。）
 */
export function indicesJobs(service: IndicesService): JobDefinition[] {
  return [
    {
      name: 'indices.daily',
      cron: '20 */3 * * *',
      runOnBoot: true,
      handler: async () => {
        const stats = await service.captureAll();
        return { stats: { ...stats } };
      },
    },
  ];
}
