import {
  FX_DIRECTION_LABELS,
  FX_DIRECTIONS,
  FX_RANGE_KEYS,
  FX_RANGE_LABELS,
  type FxDirection,
  type FxRangeKey,
} from '@funds-helper/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Chart } from '../../components/Chart.tsx';
import { FreshnessBadge } from '../../components/FreshnessBadge.tsx';
import { Chip, ErrorState, SectionCard, Spinner } from '../../components/ui.tsx';
import { api, apiErrorDetail } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { formatNumber, formatPercent, trendClass } from '../../lib/format.ts';
import { type FxView, fromSearchParams, toSearchParams } from './filters.ts';

/**
 * `CNY/USD` 的数值量级只有 0.14（小数第二位才见到有效变化），
 * 用 4 位小数会把「日涨跌 0.0001」显示成 0.0001 —— 看不出方向，因此按方向给精度。
 */
function rateDigits(direction: FxDirection): number {
  return direction === FX_DIRECTIONS.CnyUsd ? 6 : 4;
}

/** 涨跌额需要带符号（`formatNumber` 只做无符号格式化） */
function signedNumber(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

/** 波动率不是涨跌，不带符号 */
function plainPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return `${value.toFixed(digits)}%`;
}

export default function FxPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const view = useMemo(() => fromSearchParams(searchParams), [searchParams]);

  const apply = useCallback(
    (next: FxView) => setSearchParams(toSearchParams(next)),
    [setSearchParams],
  );

  const datasetQuery = useQuery({
    queryKey: ['fx', 'dataset', view.range, view.direction],
    queryFn: () => api.getFxDataset({ range: view.range, direction: view.direction }),
    staleTime: 10 * 60_000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.refreshFx(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fx'] }),
  });

  const data = datasetQuery.data;
  const summary = data?.summary;
  const digits = rateDigits(view.direction);
  const directionLabel = `${FX_DIRECTION_LABELS[view.direction]}（${view.direction}）`;

  const chartCategories = useMemo(() => data?.points.map((point) => point.date) ?? [], [data]);
  const chartSeries = useMemo(
    () => [
      {
        name: view.direction,
        data: data?.points.map((point) => point.close) ?? [],
        area: true,
      },
    ],
    [data, view.direction],
  );
  const yFormatter = useCallback((value: number) => value.toFixed(digits), [digits]);
  const tooltipFormatter = useCallback(
    (params: unknown[]) => {
      const [first] = params as { axisValue?: string; value?: number | null }[];
      if (first === undefined) return '';
      const value = typeof first.value === 'number' ? first.value.toFixed(digits) : '--';
      return `${first.axisValue ?? ''}<br/>${view.direction} ${value}`;
    },
    [digits, view.direction],
  );

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">人民币汇率</h1>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            美元兑人民币现在多少？过去这些年是怎么波动的？
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FreshnessBadge freshness={data?.freshness} />
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
        数据是新浪财经的<strong>在岸美元兑人民币即期汇率</strong>日线（不是央行中间价）， 可回溯到
        1994 年。区间统计以<strong>最新交易日</strong>为锚点（非当前时刻），
        因此周末与节假日看到的链接结果是稳定的。实际换汇成交价以银行挂牌牌价为准。
      </p>

      {refreshMutation.data ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          {refreshMutation.data.message}
        </p>
      ) : null}
      {refreshMutation.isError ? (
        <ErrorState message="重新抓取失败" detail={apiErrorDetail(refreshMutation.error)} />
      ) : null}

      {/* 方向与区间都写进 URL：可分享、可刷新复现 */}
      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-start gap-2">
          <span className="w-20 shrink-0 pt-1 text-xs text-slate-500 dark:text-slate-400">
            报价方向
          </span>
          <div className="flex flex-1 flex-wrap gap-1.5">
            {Object.values(FX_DIRECTIONS).map((direction) => (
              <Chip
                key={direction}
                active={view.direction === direction}
                onClick={() => apply({ ...view, direction })}
                title={
                  direction === FX_DIRECTIONS.CnyUsd ? '1 人民币兑多少美元' : '1 美元兑多少人民币'
                }
              >
                {FX_DIRECTION_LABELS[direction]}
              </Chip>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-2">
          <span className="w-20 shrink-0 pt-1 text-xs text-slate-500 dark:text-slate-400">
            展示区间
          </span>
          <div className="flex flex-1 flex-wrap gap-1.5">
            {FX_RANGE_KEYS.map((range: FxRangeKey) => (
              <Chip
                key={range}
                active={view.range === range}
                onClick={() => apply({ ...view, range })}
              >
                {FX_RANGE_LABELS[range]}
              </Chip>
            ))}
          </div>
        </div>
      </section>

      {datasetQuery.isPending ? <Spinner label="加载汇率数据…" /> : null}
      {datasetQuery.isError ? (
        <ErrorState
          message="汇率数据加载失败（上游可能临时不可用，可点右上角「重新抓取上游」重试）"
          detail={apiErrorDetail(datasetQuery.error)}
        />
      ) : null}

      {data && summary ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="最新汇率"
              value={formatNumber(summary.latest.rate, digits)}
              hint={`${summary.latest.date}（最新交易日）`}
            />
            <Stat
              label="较上一交易日"
              value={
                <span className={trendClass(summary.dayChange)}>
                  {signedNumber(summary.dayChange, digits)}（{formatPercent(summary.dayChangePct)}）
                </span>
              }
              hint={summary.previous ? `上一交易日 ${summary.previous.date}` : '--'}
            />
            <Stat
              label={`${FX_RANGE_LABELS[view.range]}区间最高`}
              value={formatNumber(summary.rangeHigh?.rate, digits)}
              hint={summary.rangeHigh?.date ?? '--'}
            />
            <Stat
              label={`${FX_RANGE_LABELS[view.range]}区间最低`}
              value={formatNumber(summary.rangeLow?.rate, digits)}
              hint={summary.rangeLow?.date ?? '--'}
            />
            <Stat
              label="全历史最高"
              value={formatNumber(summary.allTimeHigh?.rate, digits)}
              hint={summary.allTimeHigh?.date ?? '--'}
            />
            <Stat
              label="全历史最低"
              value={formatNumber(summary.allTimeLow?.rate, digits)}
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
            title={`${directionLabel} 走势`}
            subtitle={
              `${FX_RANGE_LABELS[view.range]} · ${summary.totalBars} 个交易日中抽样 ${data.points.length} 点` +
              '（极值与统计始终基于全量序列）'
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
                    <th className="px-3 py-2 text-right font-medium">起始汇率</th>
                    <th className="px-3 py-2 text-right font-medium">最新汇率</th>
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
                        {formatNumber(item.startRate, digits)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-slate-600 dark:text-slate-300">
                        {formatNumber(item.endRate, digits)}
                      </td>
                      <td className={cn('tabular px-3 py-2 text-right', trendClass(item.change))}>
                        {signedNumber(item.change, digits)}
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
            subtitle="按自然年统计；年初/年末取收盘价，最高/最低取日内价"
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
                        {formatNumber(item.open, digits)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-slate-600 dark:text-slate-300">
                        {formatNumber(item.close, digits)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                        {formatNumber(item.high, digits)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                        {formatNumber(item.low, digits)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                        {formatNumber(item.avg, digits)}
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

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className="tabular mt-1 text-lg font-semibold">{value}</p>
      <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{hint}</p>
    </div>
  );
}
