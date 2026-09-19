import type { FundDetailSections as FundDetailSectionsData } from '@funds-helper/shared';
import { useMemo, useState } from 'react';
import { formatPercent, trendClass } from '../lib/format.ts';
import { Chart } from './Chart.tsx';

/**
 * 基金详情的**通用区块**渲染：净值走势 / 收益表现 / 规模 / 配置 / 持仓 / 公告 / 局部错误。
 *
 * QDII 与美元份额两个工具的详情抽屉完全一样，因此抽到这里共用；
 * 各工具只需在此之前渲染自己特有的区块（购买建议、额度、份额对照等）。
 */

const NAV_RANGES = [
  { label: '近1月', days: 30 },
  { label: '近3月', days: 91 },
  { label: '近6月', days: 182 },
  { label: '近1年', days: 365 },
  { label: '近3年', days: 1095 },
  { label: '全部', days: null },
] as const;

function shiftDate(date: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - days * 86_400_000).toISOString().slice(0, 10);
}

export function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-1.5 text-sm last:border-0 dark:border-slate-800/60">
      <span className="shrink-0 text-slate-500 dark:text-slate-400">{label}</span>
      <span className="min-w-0 text-right">{value}</span>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

export function FundDetailSections({ detail }: { detail: FundDetailSectionsData | undefined }) {
  const [rangeIndex, setRangeIndex] = useState(3); // 默认近1年

  const navSeries = useMemo(() => {
    const points = detail?.navTrend ?? [];
    const range = NAV_RANGES[rangeIndex];
    if (!range || range.days === null || points.length === 0) return points;
    const last = points.at(-1);
    if (!last) return points;
    const cutoff = shiftDate(last.date, range.days);
    return points.filter((point) => point.date >= cutoff);
  }, [detail?.navTrend, rangeIndex]);

  if (!detail) return null;

  return (
    <>
      {navSeries.length > 0 ? (
        <Section title="净值走势">
          <div className="flex flex-wrap gap-1">
            {NAV_RANGES.map((range, index) => (
              <button
                key={range.label}
                type="button"
                onClick={() => setRangeIndex(index)}
                className={
                  'rounded px-2 py-0.5 text-xs ' +
                  (index === rangeIndex
                    ? 'bg-sky-600 text-white'
                    : 'border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800')
                }
              >
                {range.label}
              </button>
            ))}
          </div>
          <Chart
            categories={navSeries.map((point) => point.date)}
            series={[{ name: '单位净值', data: navSeries.map((point) => point.nav), area: true }]}
            yFormatter={(value) => value.toFixed(2)}
          />
          <div className="grid grid-cols-5 gap-2 pt-1">
            {detail.navSummary.map((row) => (
              <div
                key={row.label}
                className="rounded-md bg-slate-50 p-2 text-center dark:bg-slate-800/50"
              >
                <p className="text-xs text-slate-500 dark:text-slate-400">{row.label}</p>
                <p className={`tabular text-sm font-medium ${trendClass(row.returnPct)}`}>
                  {formatPercent(row.returnPct)}
                </p>
                <p className="tabular text-xs text-emerald-600 dark:text-emerald-400">
                  {formatPercent(row.maxDrawdownPct)}
                </p>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-400">上排为区间涨幅，下排为最大回撤</p>
        </Section>
      ) : null}

      {detail.periods.length > 0 ? (
        <Section title="收益表现">
          <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
            <table className="w-full min-w-[520px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="px-3 py-1.5 font-medium">周期</th>
                  <th className="px-3 py-1.5 text-right font-medium">本基金</th>
                  <th className="px-3 py-1.5 text-right font-medium">同类平均</th>
                  <th className="px-3 py-1.5 text-right font-medium">沪深300</th>
                  <th className="px-3 py-1.5 text-right font-medium">同类排名</th>
                </tr>
              </thead>
              <tbody>
                {detail.periods.map((period) => (
                  <tr
                    key={period.key}
                    className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
                  >
                    <td className="px-3 py-1.5">{period.label}</td>
                    <td
                      className={`tabular px-3 py-1.5 text-right font-medium ${trendClass(period.ret)}`}
                    >
                      {formatPercent(period.ret)}
                    </td>
                    <td className="tabular px-3 py-1.5 text-right text-slate-500 dark:text-slate-400">
                      {formatPercent(period.avg)}
                    </td>
                    <td className="tabular px-3 py-1.5 text-right text-slate-500 dark:text-slate-400">
                      {formatPercent(period.bench)}
                    </td>
                    <td className="tabular px-3 py-1.5 text-right text-slate-500 dark:text-slate-400">
                      {period.rank === null || period.total === null
                        ? '--'
                        : `${period.rank}/${period.total}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {detail.scale.length > 0 ? (
        <Section title="规模变动（季度，亿元）">
          <Chart
            categories={detail.scale.map((point) => point.date)}
            series={[
              { name: '净资产规模', type: 'bar', data: detail.scale.map((point) => point.scale) },
            ]}
            height={200}
            yFormatter={(value) => `${value}`}
          />
        </Section>
      ) : null}

      {detail.allocation.length > 0 || detail.holders.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {detail.allocation.length > 0 ? (
            <Section title="资产配置">
              {detail.allocation.map((item) => (
                <InfoRow
                  key={item.name}
                  label={item.name}
                  value={<span className="tabular">{formatPercent(item.value)}</span>}
                />
              ))}
            </Section>
          ) : null}
          {detail.holders.length > 0 ? (
            <Section title="持有人结构">
              {detail.holders.map((item) => (
                <InfoRow
                  key={item.name}
                  label={item.name}
                  value={<span className="tabular">{formatPercent(item.value)}</span>}
                />
              ))}
            </Section>
          ) : null}
        </div>
      ) : null}

      <Section title={`主要成分${detail.reportDate ? `（报告期 ${detail.reportDate}）` : ''}`}>
        {detail.holdings.stocks.length > 0 ? (
          <ul className="space-y-1">
            {detail.holdings.stocks.map((stock) => (
              <li
                key={`${stock.code}-${stock.name}`}
                className="flex items-center justify-between gap-3 border-b border-slate-100 py-1 text-sm last:border-0 dark:border-slate-800/60"
              >
                <span className="tabular w-16 shrink-0 text-slate-500">{stock.code ?? '--'}</span>
                <span className="min-w-0 flex-1 truncate">{stock.name ?? '--'}</span>
                {stock.action ? (
                  <span className="text-xs text-slate-400">
                    {stock.action}
                    {stock.delta !== null ? ` ${stock.delta}%` : ''}
                  </span>
                ) : null}
                <span className="tabular w-16 text-right">{formatPercent(stock.weight, 2)}</span>
              </li>
            ))}
          </ul>
        ) : detail.holdings.etf ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            本基金为联接基金，主要持有底层 ETF：
            <span className="tabular ml-1 font-medium">{detail.holdings.etf.code}</span>
            {detail.holdings.etf.name ? ` ${detail.holdings.etf.name}` : ''}
          </p>
        ) : (
          <p className="text-sm text-slate-400">暂无持仓数据</p>
        )}

        {detail.holdings.bonds.length > 0 ? (
          <div className="pt-2">
            <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">债券持仓</p>
            {detail.holdings.bonds.map((bond) => (
              <InfoRow
                key={`${bond.code}-${bond.name}`}
                label={`${bond.code ?? '--'} ${bond.name ?? ''}`}
                value={<span className="tabular">{formatPercent(bond.weight)}</span>}
              />
            ))}
          </div>
        ) : null}
      </Section>

      {detail.notices.length > 0 ? (
        <Section title="最近申购相关公告">
          <ul className="space-y-1.5">
            {detail.notices.map((notice) => (
              <li key={notice.id} className="flex gap-3 text-sm">
                <span className="tabular shrink-0 text-slate-400">{notice.publishDate}</span>
                {notice.url ? (
                  <a
                    href={notice.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 text-sky-600 hover:underline dark:text-sky-400"
                  >
                    {notice.title}
                  </a>
                ) : (
                  <span className="min-w-0 flex-1">{notice.title}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {detail.errors.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <p className="font-medium">部分数据暂不可用</p>
          <ul className="mt-1 list-inside list-disc">
            {detail.errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

/** 详情里用到的净值走势区间（供自定义渲染复用） */
export { NAV_RANGES };
