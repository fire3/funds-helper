import {
  aggregateThemes,
  ETF_REVERSE_METRIC_LABELS,
  ETF_REVERSE_METRICS,
  ETF_WINDOW_LABELS,
  ETF_WINDOWS,
  type EtfReverseMetric,
  type EtfThemeSignal,
  type EtfWindow,
  reverseHotspots,
  themeSignal,
  windowReturn,
} from '@funds-helper/core';
import type { EtfPeriodInfo, EtfRecord } from '@funds-helper/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Fragment, useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Chip, EmptyState, ErrorState, type Tone } from '../../components/ui.tsx';
import { api, apiErrorDetail } from '../../lib/api.ts';
import { formatPercent, formatYuan, trendClass } from '../../lib/format.ts';

/**
 * 热点研究面板 —— ETF 工具的第二个视图（见 docs/design/etf-hotspot.md §6）。
 *
 * 两条互补路径：
 * - **聚合**（自上而下）：主题内等权平均涨幅 + 资金体量 + 轮动信号；
 * - **反查**（自下而上）：涨幅/资金流入榜 Top-30 → 主题命中数（多点开花）。
 *
 * 全部计算在客户端（core 纯函数），数据就是服务端下发的 dataset —— 与本工具
 * 「一次全量下发、前端筛选聚合」的既有约定一致。
 */

const SIGNAL_TONE: Record<EtfThemeSignal, Tone> = {
  持续强势: 'good',
  新热点: 'info',
  退潮: 'warn',
  震荡: 'neutral',
};

const REVERSE_K = 30;

type Mode = 'aggregate' | 'reverse';

const MODES: { value: Mode; label: string }[] = [
  { value: 'aggregate', label: '聚合视图' },
  { value: 'reverse', label: '反查视图' },
];

function useHotspotParams() {
  const [searchParams, setSearchParams] = useSearchParams();

  const window: EtfWindow = (ETF_WINDOWS as readonly string[]).includes(searchParams.get('w') ?? '')
    ? (searchParams.get('w') as EtfWindow)
    : '1m';
  const dir: 'desc' | 'asc' = searchParams.get('d') === 'asc' ? 'asc' : 'desc';
  const metric: EtfReverseMetric = (ETF_REVERSE_METRICS as readonly string[]).includes(
    searchParams.get('m') ?? '',
  )
    ? (searchParams.get('m') as EtfReverseMetric)
    : 'ret';
  const mode: Mode = searchParams.get('mode') === 'reverse' ? 'reverse' : 'aggregate';

  // 只改自己关心的键，其余参数（含 tab、列表筛选）原样保留 → 整页 URL 可分享
  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  return { window, dir, metric, mode, setParams };
}

/** 三块主题榜之一：按某个窗口取 Top-5 主题 */
function ThemeRankBoard({
  title,
  window,
  rows,
}: {
  title: string;
  window: EtfWindow;
  rows: ReturnType<typeof aggregateThemes>;
}) {
  const top = rows
    .filter((row) => row.meanRet[window] !== null)
    .sort((a, b) => (b.meanRet[window] ?? 0) - (a.meanRet[window] ?? 0))
    .slice(0, 5);

  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium text-slate-500 dark:text-slate-400">{title}</h4>
      {top.length === 0 ? (
        <p className="text-xs text-slate-400">暂无数据（先抓取区间涨幅）</p>
      ) : (
        <ol className="space-y-1">
          {top.map((row, index) => (
            <li key={row.theme} className="flex items-center gap-2 text-xs">
              <span className="tabular w-4 shrink-0 text-slate-400">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate" title={row.theme}>
                {row.theme}
                <span className="ml-1 text-slate-400">{row.count} 只</span>
              </span>
              <span className={`tabular shrink-0 ${trendClass(row.meanRet[window])}`}>
                {formatPercent(row.meanRet[window])}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function HotspotPanel({
  records,
  periodReturns,
  onSelect,
}: {
  records: readonly EtfRecord[];
  periodReturns: EtfPeriodInfo;
  onSelect: (code: string) => void;
}) {
  const { window: focus, dir, metric, mode, setParams } = useHotspotParams();
  const [expanded, setExpanded] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const rows = useMemo(() => aggregateThemes(records), [records]);

  const sorted = useMemo(() => {
    const list = [...rows];
    list.sort((a, b) => {
      const left = a.meanRet[focus];
      const right = b.meanRet[focus];
      if (left === null && right === null) return a.theme.localeCompare(b.theme, 'zh-CN');
      if (left === null) return 1;
      if (right === null) return -1;
      return dir === 'asc'
        ? left - right || a.theme.localeCompare(b.theme, 'zh-CN')
        : right - left || a.theme.localeCompare(b.theme, 'zh-CN');
    });
    return list;
  }, [rows, focus, dir]);

  // 同期沪深300（任一记录的非空值即可：它对所有基金是同一条指数序列）
  const bench1y = records.find((fund) => fund.bench1y !== null)?.bench1y ?? null;
  const bench3y = records.find((fund) => fund.bench3y !== null)?.bench3y ?? null;
  const sharesSince = records.find((fund) => fund.sharesSince !== null)?.sharesSince ?? null;
  const hasMainInflow = records.some((fund) => fund.mainInflow !== null);

  const reverseGroups = useMemo(
    () =>
      mode === 'reverse'
        ? reverseHotspots(records, { metric, window: focus, dir, k: REVERSE_K })
        : [],
    [mode, records, metric, focus, dir],
  );
  const rankOf = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows)
      if (row.ranks[focus] !== null) map.set(row.theme, row.ranks[focus] as number);
    return map;
  }, [rows, focus]);

  // 抓取区间涨幅：首次（还没抓过）带 full，之后只补过期行
  const refreshMutation = useMutation({
    mutationFn: (full: boolean) => api.refreshEtfPeriods(full),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['etf'] }),
  });

  return (
    <div className="space-y-4">
      {/* --- 区间涨幅的状态条：没抓过 → 空态引导；已抓 → 覆盖率与新鲜度 --- */}
      {periodReturns.updatedAt === null ? (
        <EmptyState
          message="还没抓取区间涨幅（近6月/近1年/近3年）—— 这三个长窗口需要逐只请求上游，首次约 1500 个请求 / 3 分钟。近1周/1月/3月/今年来与资金维度现在就能看。"
          action={
            <button
              type="button"
              onClick={() => refreshMutation.mutate(true)}
              disabled={refreshMutation.isPending}
              className="rounded-md bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {refreshMutation.isPending ? '抓取中（约 3 分钟）…' : '抓取区间涨幅'}
            </button>
          }
        />
      ) : (
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>
            区间涨幅：1 年覆盖{' '}
            <strong className="tabular text-slate-700 dark:text-slate-200">
              {periodReturns.covered1y}/{periodReturns.total}
            </strong>
            ，3 年覆盖{' '}
            <strong className="tabular text-slate-700 dark:text-slate-200">
              {periodReturns.covered3y}/{periodReturns.total}
            </strong>
            （次新 ETF 缺 3 年数据属正常）
            {periodReturns.dataDate ? ` · 收益数据 ${periodReturns.dataDate}` : ''}
          </span>
          <button
            type="button"
            onClick={() => refreshMutation.mutate(false)}
            disabled={refreshMutation.isPending}
            className="rounded-md border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {refreshMutation.isPending ? '抓取中…' : '刷新区间涨幅'}
          </button>
          {sharesSince ? (
            <span title="份额 = 一级市场申赎的直接痕迹（净申购代理）；从启用日起按日积累">
              份额变化自 <strong className="tabular">{sharesSince}</strong> 起积累
            </span>
          ) : null}
        </div>
      )}
      {refreshMutation.data ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          {refreshMutation.data.message}（用时 {(refreshMutation.data.durationMs / 1000).toFixed(1)}{' '}
          秒）
        </p>
      ) : null}
      {refreshMutation.isError ? (
        <ErrorState message="抓取区间涨幅失败" detail={apiErrorDetail(refreshMutation.error)} />
      ) : null}

      {/* --- 视图切换 --- */}
      <nav className="flex flex-wrap items-center gap-3 border-b border-slate-200 pb-2 dark:border-slate-800">
        {MODES.map((item) => (
          <Chip
            key={item.value}
            active={mode === item.value}
            onClick={() => setParams({ mode: item.value === 'aggregate' ? null : item.value })}
          >
            {item.label}
          </Chip>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-500 dark:text-slate-400">窗口</span>
          {ETF_WINDOWS.map((window) => (
            <Chip
              key={window}
              active={focus === window}
              onClick={() => setParams({ w: window === '1m' ? null : window })}
            >
              {ETF_WINDOW_LABELS[window]}
            </Chip>
          ))}
          <button
            type="button"
            onClick={() => setParams({ d: dir === 'desc' ? 'asc' : null })}
            title="切换升/降序（升序看领跌方向）"
            className="rounded-full border border-slate-300 px-3 py-1 text-sm text-slate-600 hover:border-sky-400 hover:text-sky-700 dark:border-slate-700 dark:text-slate-300"
          >
            {dir === 'desc' ? '从高到低 ↓' : '从低到高 ↑'}
          </button>
        </span>
      </nav>

      {mode === 'aggregate' ? (
        <>
          <div className="grid gap-4 rounded-lg border border-slate-200 bg-slate-50/60 p-4 sm:grid-cols-3 dark:border-slate-800 dark:bg-slate-900/40">
            <ThemeRankBoard title="近期热点（近1月 Top5）" window="1m" rows={rows} />
            <ThemeRankBoard title="近1年强势" window="1y" rows={rows} />
            <ThemeRankBoard title="近3年长牛" window="3y" rows={rows} />
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full min-w-[1180px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="px-3 py-2 font-medium">主题（点击展开成员）</th>
                  <th className="px-3 py-2 text-right font-medium">只数</th>
                  {ETF_WINDOWS.map((window) => (
                    <th
                      key={window}
                      className={
                        'px-3 py-2 text-right font-medium ' +
                        (window === focus
                          ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400'
                          : '')
                      }
                    >
                      {ETF_WINDOW_LABELS[window]}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium">成交额（占比）</th>
                  <th className="px-3 py-2 text-right font-medium">规模</th>
                  <th className="px-3 py-2 text-right font-medium" title="净申购代理，自积累起点">
                    份额变化
                  </th>
                  <th className="px-3 py-2 font-medium">信号</th>
                  <th className="px-3 py-2 font-medium">领涨（焦点窗口）</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => {
                  const isOpen = expanded === row.theme;
                  const signal = themeSignal(row, focus);
                  const leader = isOpen
                    ? row.members.reduce<{ member: EtfRecord; value: number } | null>(
                        (best, member) => {
                          const value = windowReturn(member, focus);
                          if (value === null) return best;
                          if (best === null || value > best.value) return { member, value };
                          return best;
                        },
                        null,
                      )
                    : null;
                  return (
                    <Fragment key={row.theme}>
                      <tr
                        onClick={() => setExpanded(isOpen ? null : row.theme)}
                        className={
                          'cursor-pointer border-b border-slate-100 dark:border-slate-800/60 ' +
                          (isOpen
                            ? 'bg-sky-50 dark:bg-sky-950/40'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/50')
                        }
                      >
                        <td className="px-3 py-2 font-medium">
                          <span className="mr-1 text-slate-400">{isOpen ? '▾' : '▸'}</span>
                          {row.theme}
                          {row.covered['3y'] < row.count && row.covered['3y'] > 0 ? (
                            <span
                              className="ml-1 text-xs text-slate-400"
                              title="部分成员还没有 3 年数据"
                            >
                              （3年 {row.covered['3y']}/{row.count}）
                            </span>
                          ) : null}
                        </td>
                        <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                          {row.count}
                        </td>
                        {ETF_WINDOWS.map((window) => (
                          <td
                            key={window}
                            className={
                              'tabular px-3 py-2 text-right ' +
                              (window === focus ? 'bg-sky-50 dark:bg-sky-950/40 ' : '') +
                              trendClass(row.meanRet[window])
                            }
                          >
                            {row.covered[window] < row.count && row.meanRet[window] !== null ? (
                              <span className="text-slate-400">*</span>
                            ) : null}
                            {formatPercent(row.meanRet[window])}
                          </td>
                        ))}
                        <td className="tabular px-3 py-2 text-right text-slate-600 dark:text-slate-300">
                          {formatYuan(row.amount)}
                          {row.amountSharePct !== null ? (
                            <span className="ml-1 text-xs text-slate-400">
                              {row.amountSharePct.toFixed(1)}%
                            </span>
                          ) : null}
                        </td>
                        <td className="tabular px-3 py-2 text-right text-slate-600 dark:text-slate-300">
                          {formatYuan(row.scale)}
                        </td>
                        <td
                          className={`tabular px-3 py-2 text-right ${trendClass(row.meanSharesChangePct)}`}
                        >
                          {formatPercent(row.meanSharesChangePct)}
                        </td>
                        <td className="px-3 py-2">
                          <Badge tone={SIGNAL_TONE[signal]}>{signal}</Badge>
                        </td>
                        <td
                          className="max-w-[200px] truncate px-3 py-2 text-slate-600 dark:text-slate-300"
                          title={leader ? `${leader.member.code} ${leader.member.name}` : ''}
                        >
                          {leader ? `${leader.member.name} ${formatPercent(leader.value)}` : '--'}
                        </td>
                      </tr>
                      {isOpen
                        ? row.members
                            .slice()
                            .sort((a, b) => {
                              const left = windowReturn(a, focus);
                              const right = windowReturn(b, focus);
                              if (left === null && right === null) return 0;
                              if (left === null) return 1;
                              if (right === null) return -1;
                              return dir === 'asc' ? left - right : right - left;
                            })
                            .map((member) => (
                              <tr
                                key={member.code}
                                onClick={() => onSelect(member.code)}
                                className="cursor-pointer bg-slate-50/70 text-xs hover:bg-sky-100/60 dark:bg-slate-800/40 dark:hover:bg-sky-950/60"
                              >
                                <td colSpan={2} className="px-3 py-1.5 pl-8">
                                  <span className="tabular mr-2 text-slate-400">{member.code}</span>
                                  <span title={member.name}>{member.name}</span>
                                </td>
                                {ETF_WINDOWS.map((window) => (
                                  <td
                                    key={window}
                                    className={
                                      'tabular px-3 py-1.5 text-right ' +
                                      (window === focus ? 'bg-sky-50 dark:bg-sky-950/40 ' : '') +
                                      trendClass(windowReturn(member, window))
                                    }
                                  >
                                    {formatPercent(windowReturn(member, window))}
                                  </td>
                                ))}
                                <td className="tabular px-3 py-1.5 text-right text-slate-500 dark:text-slate-400">
                                  {formatYuan(member.amount)}
                                </td>
                                <td className="tabular px-3 py-1.5 text-right text-slate-500 dark:text-slate-400">
                                  {formatYuan(member.scale)}
                                </td>
                                <td
                                  className={`tabular px-3 py-1.5 text-right ${trendClass(member.sharesChangePct)}`}
                                >
                                  {formatPercent(member.sharesChangePct)}
                                </td>
                                <td className="px-3 py-1.5 text-slate-500 dark:text-slate-400">
                                  {member.premiumText}
                                </td>
                                <td className="tabular px-3 py-1.5 text-slate-500 dark:text-slate-400">
                                  日 {formatPercent(member.changePct)}
                                </td>
                              </tr>
                            ))
                        : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400">
            主题均值为<strong>等权</strong>（不区分成员体量，资金体量看成交额/规模列）；带{' '}
            <span className="text-slate-500">*</span> 的窗口表示只有部分成员有数据。
            基准：同期沪深300 近1年 {formatPercent(bench1y)}、近3年 {formatPercent(bench3y)}
            ；信号按「焦点窗口排名分位 × 近1年排名分位」判定（≤25% 强、≥50% 分位弱）。
          </p>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-slate-500 dark:text-slate-400">榜单</span>
            {ETF_REVERSE_METRICS.map((item) => (
              <Chip
                key={item}
                active={metric === item}
                onClick={() => setParams({ m: item === 'ret' ? null : item })}
                {...(item === 'mainInflow' && !hasMainInflow
                  ? { title: '当前行情渠道不提供主力净流入（新浪渠道）' }
                  : {})}
              >
                {ETF_REVERSE_METRIC_LABELS[item]}
                {item === 'ret' ? `（${ETF_WINDOW_LABELS[focus]}）` : ''}
              </Chip>
            ))}
            <span className="text-xs text-slate-400">
              Top-{REVERSE_K} 反推主题 · 命中 ≥2 = 多点开花
            </span>
          </div>

          {metric === 'mainInflow' && !hasMainInflow ? (
            <EmptyState message="当前行情渠道不提供「主力净流入」，请在页头切换到东方财富行情后重新抓取。" />
          ) : reverseGroups.length === 0 ? (
            <EmptyState message="该榜单在当前窗口没有可用数据（可能还没抓取区间涨幅）。" />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
              <table className="w-full min-w-[760px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <th className="px-3 py-2 font-medium">主题</th>
                    <th className="px-3 py-2 text-right font-medium">上榜</th>
                    <th
                      className="px-3 py-2 text-right font-medium"
                      title="该主题在当前窗口的聚合排名"
                    >
                      聚合排名
                    </th>
                    <th className="px-3 py-2 font-medium">上榜成员（点击查看）</th>
                  </tr>
                </thead>
                <tbody>
                  {reverseGroups.map((group) => (
                    <tr
                      key={group.theme}
                      className="border-b border-slate-100 dark:border-slate-800/60"
                    >
                      <td className="px-3 py-2 font-medium">
                        {group.theme}
                        {group.hits >= 2 ? <Badge tone="info">多点开花</Badge> : null}
                      </td>
                      <td className="tabular px-3 py-2 text-right">{group.hits}</td>
                      <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                        {rankOf.has(group.theme) ? `#${rankOf.get(group.theme)}` : '--'}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                          {group.members.map((member) => (
                            <button
                              key={member.code}
                              type="button"
                              onClick={() => onSelect(member.code)}
                              className="text-left hover:text-sky-700 dark:hover:text-sky-400"
                              title={member.name}
                            >
                              <span className="tabular mr-1 text-slate-400">{member.code}</span>
                              <span className="max-w-[140px] truncate">{member.name}</span>
                              <span
                                className={`tabular ml-1 ${trendClass(
                                  metric === 'ret'
                                    ? windowReturn(member, focus)
                                    : metric === 'mainInflow'
                                      ? member.mainInflow
                                      : metric === 'sharesChange'
                                        ? member.sharesChangePct
                                        : member.amount,
                                )}`}
                              >
                                {metric === 'amount' || metric === 'mainInflow'
                                  ? formatYuan(
                                      metric === 'mainInflow' ? member.mainInflow : member.amount,
                                    )
                                  : formatPercent(
                                      metric === 'ret'
                                        ? windowReturn(member, focus)
                                        : member.sharesChangePct,
                                    )}
                              </span>
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-slate-400">
            反查与聚合互为交叉验证：榜单命中多（多点开花）且聚合排名靠前 = 热点确认；
            只有头部一两只上榜、聚合排名靠后 = 均值还没跟上（警惕单只拉动）。
            「聚合排名」按当前窗口（{ETF_WINDOW_LABELS[focus]}）的等权均值计。
          </p>
        </>
      )}
    </div>
  );
}
