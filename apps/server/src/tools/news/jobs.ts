import type { JobDefinition } from '../types.ts';
import type { NewsService } from './service.ts';

/**
 * `news` 工具的两个定时任务（design §9）。
 *
 * **`news.fetch` 每 10 分钟一跳 + 每个信源自己的 `next_fetch_at`**，
 * 而不是 4 个分组 cron：分组 cron 会让「调整某个信源的频率」变成改代码 + 重启；
 * 单任务 + 到期判断是幂等的，重启后 `runOnBoot` 补跑也不会重复打全部信源。
 *
 * 请求量（14 个信源）：media 5×48 + 其余 9×24 ≈ 456 请求/天 ≈ 0.32 请求/分钟，
 * 叠加 ETag 条件请求后绝大多数是 304。
 *
 * **`news.summary` 不 runOnBoot**：简报有历史记录可展示，重启后补跑纯属烧配额
 * （对比 `etf.snapshot` 那类「不补跑页面就空白」的任务）。
 * 每天 08:30 Asia/Shanghai 生成 `yesterday` —— 美股已收盘、亚太开盘前。
 *
 * **`news.fetch` 抓完一轮就顺手生成「今日」简报**（`generateTodayAfterFetch`）：
 * 这是本工具的主路径 —— 信息流一有更新，中文简报就跟着更新，不必等次日 08:30。
 * 生成失败只记日志、不改抓取任务的成功状态；未配置模型 / 额度用尽 / 仍在陈旧窗口内
 * 都会显式跳过，因此不会每 10 分钟烧一次配额。
 */
export function newsJobs(service: NewsService): JobDefinition[] {
  return [
    {
      name: 'news.fetch',
      cron: '*/10 * * * *',
      runOnBoot: true,
      handler: async () => {
        const stats = await service.fetchFeeds();
        // 抓取完成后自动生成今日简报：失败不影响抓取统计（信息流与简报是两条读路径）
        const summary = await service.generateTodayAfterFetch(stats);
        return { stats: { ...stats, summary } };
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
