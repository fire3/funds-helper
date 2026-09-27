import { INDEX_RANGE_KEYS, INDEX_RANGE_LABELS, type IndexRangeKey } from '@funds-helper/core';
import type { IndexQuote } from '@funds-helper/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Chart } from '../../components/Chart.tsx';
import { FreshnessBadge } from '../../components/FreshnessBadge.tsx';
import { Chip, ErrorState, SectionCard, Spinner } from '../../components/ui.tsx';
import { api, apiErrorDetail } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { formatNumber, formatPercent, trendClass } from '../../lib/format.ts';
import { fromSearchParams, type IndicesView, toSearchParams } from './filters.ts';

/**
 * 国际行情页。
 *
 * 结构：上半部分是**全部指数的概览**（按地区分组，回答「现在多少」），
 * 下半部分是**选中指数的走势与统计**（回答「这段时间怎么走」）。
 * 选中的指数与区间都写进 URL —— 「近 3 年的恒生科技走势」应该能直接发给别人。
 *
 * 与 fx 页共用 Chart / FreshnessBadge / SectionCard 等通用组件；
 * 概览卡片是本工具特有的（多标的 vs fx 的单序列）。
 */

/** 涨跌额需要带符号（formatNumber 只做无符号格式化） */
function signedNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

/** 波动率不是涨跌，不带符号 */
function plainPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return `${value.toFixed(digits)}%`;
}

/** 上游来源的中文标签（卡片角标）；Yahoo 是主源不标，其余展示中文 */
const SOURCE_LABELS: Record<string, string> = {
  eastmoney: '东财',
  tencent: '腾讯',
  sina: '新浪',
};

function sourceLabel(source: string): string {
  if (source === 'yahoo') return '';
  return SOURCE_LABELS[source] ?? source;
}

/** 涨跌幅排序的比较值：缺失值垫底；有限哨兵避免 Infinity - Infinity = NaN */
function changeSortValue(quote: IndexQuote): number {
  return quote.changePct ?? Number.MIN_SAFE_INTEGER;
}

export default function IndicesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const view = useMemo(() => fromSearchParams(searchParams), [searchParams]);

  const apply = useCallback(
    (next: IndicesView) => setSearchParams(toSearchParams(next)),
    [setSearchParams],
  );

  const overviewQuery = useQuery({
    queryKey: ['indices', 'overview'],
    queryFn: () => api.getIndicesOverview(),
    staleTime: 10 * 60_000,
  });

  const datasetQuery = useQuery({
    queryKey: ['indices', 'dataset', view.code, view.range],
    queryFn: () => api.getIndicesDataset({ code: view.code, range: view.range }),
    staleTime: 10 * 60_000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.refreshIndices(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['indices'] }),
  });

  const overview = overviewQuery.data;
  const data = datasetQuery.data;
  const summary = data?.summary;
  // 服务端对未知 code 回落 SPX —— 高亮以**响应里的实际 code**为准，避免 URL 与界面错位
  const activeCode = data?.code ?? view.code;

  const chartCategories = useMemo(() => data?.points.map((point) => point.date) ?? [], [data]);
  const chartSeries = useMemo(
    () => [
      {
        name: data?.name ?? '',
        data: data?.points.map((point) => point.close) ?? [],
        area: true,
      },
    ],
    [data],
  );
  const yFormatter = useCallback((value: number) => value.toFixed(2), []);
  const tooltipFormatter = useCallback((params: unknown[]) => {
    const [first] = params as { axisValue?: string; value?: number | null }[];
    if (first === undefined) return '';
    const value = typeof first.value === 'number' ? first.value.toFixed(2) : '--';
    return `${first.axisValue ?? ''}<br/>${value}`;
  }, []);

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">国际行情</h1>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            美股、港股、海外主要指数现在多少？这段时间是怎么走的？
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FreshnessBadge freshness={overview?.freshness ?? data?.freshness} />
          <button
            type="button"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            className="rounded-md border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {refreshMutation.isPending ? '拉取中…' : '重新抓取上游'}
          </button>
        </div>
      </header>

      <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300">
        数据来自 <strong>Yahoo Finance</strong>（主源）与<strong>东方财富、腾讯、新浪财经</strong>
        （备源）的公开接口，全部缺失时还有<strong>东方财富批量实时</strong>兑底； 为
        <strong>免费延迟行情</strong>，按各交易所当地日期记录；价格是
        <strong>原生币种点位</strong>
        （美元/港币/日元…），不做汇率换算 —— 换算请用「人民币汇率」工具。各市场休市节奏不同，
        每条行情下方标注的是它自己的数据日期。
      </p>

      {refreshMutation.data ? (
        <p
          className={cn(
            'rounded-md border px-3 py-2 text-xs',
            refreshMutation.data.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
          )}
        >
          {refreshMutation.data.message}
        </p>
      ) : null}
      {refreshMutation.isError ? (
        <ErrorState message="重新抓取失败" detail={apiErrorDetail(refreshMutation.error)} />
      ) : null}

      {/* ---- 概览：全部指数按地区分组（点卡片切换下方走势） ---- */}
      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">最新收盘</h2>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-slate-400 dark:text-slate-500">
              点击指数查看走势 · 涨跌为较上一交易日
            </span>
            <button
              type="button"
              onClick={() => apply({ ...view, sort: view.sort === 'chg' ? 'default' : 'chg' })}
              className="rounded-md border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {view.sort === 'chg' ? '恢复注册表顺序' : '按涨跌幅排序'}
            </button>
          </div>
        </div>

        {overviewQuery.isPending ? <Spinner label="加载指数概览…" /> : null}
        {overviewQuery.isError ? (
          <ErrorState
            message="指数概览加载失败（上游可能临时不可用，可点右上角「重新抓取上游」重试）"
            detail={apiErrorDetail(overviewQuery.error)}
          />
        ) : null}

        {overview?.regions.map((region) => {
          const items =
            view.sort === 'chg'
              ? [...region.items].sort((a, b) => changeSortValue(b) - changeSortValue(a))
              : region.items;
          return (
            <div key={region.key} className="space-y-1.5">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {region.label}
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {items.map((item) => (
                  <OverviewCard
                    key={item.code}
                    quote={item}
                    active={item.code === activeCode}
                    onClick={() => apply({ ...view, code: item.code })}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </section>

      {datasetQuery.isPending ? <Spinner label="加载指数走势…" /> : null}
      {datasetQuery.isError ? (
        <ErrorState
          message="指数走势加载失败（上游可能临时不可用，可点右上角「重新抓取上游」重试）"
          detail={apiErrorDetail(datasetQuery.error)}
        />
      ) : null}

      {data && summary ? (
        <>
          <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-start gap-2">
              <span className="w-20 shrink-0 pt-1 text-xs text-slate-500 dark:text-slate-400">
                展示区间
              </span>
              <div className="flex flex-1 flex-wrap gap-1.5">
                {INDEX_RANGE_KEYS.map((range: IndexRangeKey) => (
                  <Chip
                    key={range}
                    active={view.range === range}
                    onClick={() => apply({ ...view, range })}
                  >
                    {INDEX_RANGE_LABELS[range]}
                  </Chip>
                ))}
              </div>
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label={`${data.name} 最新收盘`}
              value={formatNumber(summary.latest.value, 2)}
              hint={`${summary.latest.date}（交易所当地日期）· ${data.currency}`}
            />
            <Stat
              label="较上一交易日"
              value={
                <span className={trendClass(summary.dayChange)}>
                  {signedNumber(summary.dayChange)}（{formatPercent(summary.dayChangePct)}）
                </span>
              }
              hint={summary.previous ? `上一交易日 ${summary.previous.date}` : '--'}
            />
            <Stat
              label={`${INDEX_RANGE_LABELS[view.range]}区间最高`}
              value={formatNumber(summary.rangeHigh?.value, 2)}
              hint={summary.rangeHigh?.date ?? '--'}
            />
            <Stat
              label={`${INDEX_RANGE_LABELS[view.range]}区间最低`}
              value={formatNumber(summary.rangeLow?.value, 2)}
              hint={summary.rangeLow?.date ?? '--'}
            />
            <Stat
              label="全历史最高"
              value={formatNumber(summary.allTimeHigh?.value, 2)}
              hint={summary.allTimeHigh?.date ?? '--'}
            />
            <Stat
              label="全历史最低"
              value={formatNumber(summary.allTimeLow?.value, 2)}
              hint={summary.allTimeLow?.date ?? '--'}
            />
            <Stat
              label="近一年年化波动率"
              value={plainPercent(summary.annualizedVolatility)}
              hint="日收益标准差 × √252"
            />
            <Stat
              label="交易日数"
              value={`${summary.totalBars} 天`}
              hint={`${summary.firstDate} ~ ${summary.lastDate}`}
            />
          </section>

          <SectionCard
            title={`${data.name} 走势（${data.currency}）`}
            subtitle={
              `${INDEX_RANGE_LABELS[view.range]} · 收盘时间基准 ${data.timeZone} · ` +
              `${summary.totalBars} 个交易日中抽样 ${data.points.length} 点（极值与统计始终基于全量序列）`
            }
          >
            <Chart
              categories={chartCategories}
              series={chartSeries}
              height={320}
              yFormatter={yFormatter}
              tooltipFormatter={tooltipFormatter}
            />
          </SectionCard>

          <SectionCard title="区间涨跌" subtitle="起止点均取该区间首个与最后一个交易日收盘价">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <th className="px-3 py-2 font-medium">区间</th>
                    <th className="px-3 py-2 font-medium">起始日</th>
                    <th className="px-3 py-2 text-right font-medium">起始点位</th>
                    <th className="px-3 py-2 text-right font-medium">最新点位</th>
                    <th className="px-3 py-2 text-right font-medium">涨跌</th>
                    <th className="px-3 py-2 text-right font-medium">涨跌幅</th>
                  </tr>
                </thead>
                <tbody>
                  {data.intervals.map((item) => (
                    <tr
                      key={item.key}
                      className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
                    >
                      <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{item.label}</td>
                      <td className="tabular px-3 py-2 text-slate-500 dark:text-slate-400">
                        {item.from ?? '数据不足'}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                        {formatNumber(item.start, 2)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-slate-600 dark:text-slate-300">
                        {formatNumber(item.end, 2)}
                      </td>
                      <td className={cn('tabular px-3 py-2 text-right', trendClass(item.change))}>
                        {signedNumber(item.change)}
                      </td>
                      <td
                        className={cn(
                          'tabular px-3 py-2 text-right font-medium',
                          trendClass(item.changePct),
                        )}
                      >
                        {formatPercent(item.changePct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          <SectionCard
            title="年度表现"
            subtitle="按自然年统计（交易所当地日期）；年初/年末取收盘价，最高/最低取日内价"
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <th className="px-3 py-2 font-medium">年份</th>
                    <th className="px-3 py-2 text-right font-medium">年初</th>
                    <th className="px-3 py-2 text-right font-medium">年末</th>
                    <th className="px-3 py-2 text-right font-medium">最高</th>
                    <th className="px-3 py-2 text-right font-medium">最低</th>
                    <th className="px-3 py-2 text-right font-medium">年均</th>
                    <th className="px-3 py-2 text-right font-medium">年度涨跌</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.yearly].reverse().map((item) => (
                    <tr
                      key={item.year}
                      className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
                    >
                      <td className="tabular px-3 py-2 text-slate-600 dark:text-slate-300">
                        {item.year}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                        {formatNumber(item.open, 2)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-slate-600 dark:text-slate-300">
                        {formatNumber(item.close, 2)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                        {formatNumber(item.high, 2)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                        {formatNumber(item.low, 2)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                        {formatNumber(item.avg, 2)}
                      </td>
                      <td
                        className={cn(
                          'tabular px-3 py-2 text-right font-medium',
                          trendClass(item.changePct),
                        )}
                      >
                        {formatPercent(item.changePct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          <p className="text-xs text-slate-400 dark:text-slate-500">{data.disclaimer}</p>
        </>
      ) : null}
    </div>
  );
}

function OverviewCard({
  quote,
  active,
  onClick,
}: {
  quote: IndexQuote;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md border px-3 py-2 text-left transition-colors',
        active
          ? 'border-sky-400 bg-sky-50 dark:border-sky-600 dark:bg-sky-950/50'
          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700 dark:hover:bg-slate-800/60',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={cn(
            'truncate text-sm font-medium',
            active ? 'text-sky-700 dark:text-sky-300' : 'text-slate-700 dark:text-slate-200',
          )}
        >
          {quote.name}
        </span>
        <span className="shrink-0 text-[10px] text-slate-400 dark:text-slate-500">
          {quote.currency}
        </span>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="tabular text-lg font-semibold text-slate-800 dark:text-slate-100">
          {formatNumber(quote.price, 2)}
        </span>
        <span className={cn('tabular text-xs font-medium', trendClass(quote.change))}>
          {signedNumber(quote.change)}（{formatPercent(quote.changePct)}）
        </span>
      </div>
      <p className="tabular mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
        今开 {formatNumber(quote.open, 2)} · 最高 {formatNumber(quote.high, 2)} · 最低{' '}
        {formatNumber(quote.low, 2)}
      </p>
      <p className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
        {quote.date} 收盘{sourceLabel(quote.source) !== '' ? ` · ${sourceLabel(quote.source)}` : ''}
      </p>
    </button>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className="tabular mt-1 text-lg font-semibold">{value}</p>
      <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{hint}</p>
    </div>
  );
}
