import type { JobDefinition } from '../types.ts';
import type { NewsService } from './service.ts';

/**
 * `news` 工具的两个定时任务（design §9）。
 *
 * **`news.fetch` 每 10 分钟一跳 + 每个信源自己的 `next_fetch_at`**，
 * 而不是 4 个分组 cron：分组 cron 会让「调整某个信源的频率」变成改代码 + 重启；
 * 单任务 + 到期判断是幂等的，重启后 `runOnBoot` 补跑也不会重复打全部信源。
 *
 * 请求量（15 个信源）：media 6×48 + 其余 9×24 ≈ 504 请求/天 ≈ 0.35 请求/分钟，
 * 叠加 ETag 条件请求后绝大多数是 304。
 *
 * **`news.summary` 不 runOnBoot**：简报有历史记录可展示，重启后补跑纯属烧配额
 * （对比 `etf.snapshot` 那类「不补跑页面就空白」的任务）。
 * 每天 08:30 Asia/Shanghai 生成 `yesterday` —— 美股已收盘、亚太开盘前。
 */
export function newsJobs(service: NewsService): JobDefinition[] {
  return [
    {
      name: 'news.fetch',
      cron: '*/10 * * * *',
      runOnBoot: true,
      handler: async () => {
        const stats = await service.fetchFeeds();
        return { stats: { ...stats } };
      },
    },
    {
      name: 'news.summary',
      cron: '30 8 * * *',
      runOnBoot: false,
      handler: async () => {
        const result = await service.generate({ window: 'yesterday' }, 'scheduled');
        return {
          stats: {
            window: 'yesterday',
            summaryId: result.summary.id,
            itemCount: result.summary.itemCount,
            dropped: result.summary.droppedCount,
            promptTokens: result.summary.promptTokens,
            completionTokens: result.summary.completionTokens,
          },
        };
      },
    },
  ];
}
