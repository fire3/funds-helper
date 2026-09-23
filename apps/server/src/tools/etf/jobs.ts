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
 *
 * 第二个任务 `etf.feeders` 是**场外联接基金反查**：上游没有「按 ETF 查联接基金」的接口，
 * 只能扫全市场含「联接」的基金（实测 2319 只）再逐只反查，所以：
 * - 频率降到**每周一次**（周一 03:00，非交易时段、不与行情快照抢通道）；
 * - 首次建库是全量（约 2300 个请求 / 4 分钟），之后都是**增量**（只查新增候选，几十个请求）；
 * - 启动补跑带「距上次 ≥6 天」的门槛，避免开发时反复重启把上游打穿。
 * 详见 docs/design/etf-tool.md §11。
 *
 * 第三个任务 `etf.periods`（区间涨幅，接口 H）见下方注释与 docs/design/etf-hotspot.md §7。
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
    {
      name: 'etf.feeders',
      cron: '0 3 * * 1',
      runOnBoot: true,
      handler: async () => {
        const plan = service.feederScanPlan();
        if (!plan.due) return { stats: { skipped: true, reason: '距上次反查不足 6 天' } };
        const stats = await service.refreshFeederFunds({ full: plan.full });
        return { stats: { ...stats } };
      },
    },
    {
      // 第三个任务 `etf.periods`：**区间涨幅**（接口 H 的 6月/1年/3年，热点研究的长窗口）。
      // 每周一次（周一 04:00，错开 03:00 的联接反查），约 1500 个请求 / 3 分钟 ——
      // 长窗口本身一周才变一点，没有理由天天打；行级 7 天新鲜度由服务层判定，
      // 启动补跑带「距上次 ≥6 天」门槛（理由同 etf.feeders）。
      name: 'etf.periods',
      cron: '0 4 * * 1',
      runOnBoot: true,
      handler: async () => {
        const plan = service.periodsScanPlan();
        if (!plan.due) return { stats: { skipped: true, reason: '距上次抓取不足 6 天' } };
        const stats = await service.refreshPeriodReturns();
        return { stats: { ...stats } };
      },
    },
  ];
}
