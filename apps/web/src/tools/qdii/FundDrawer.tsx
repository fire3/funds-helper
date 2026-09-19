import type { FundRecord, QdiiFundDetailResponse } from '@funds-helper/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Chart } from '../../components/Chart.tsx';
import { Drawer } from '../../components/Drawer.tsx';
import { Badge, ErrorState, type Tone } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { formatNumber, formatPercent } from '../../lib/format.ts';

const NAV_RANGES = [
  { label: '近1月', days: 30 },
  { label: '近3月', days: 91 },
  { label: '近6月', days: 182 },
  { label: '近1年', days: 365 },
  { label: '近3年', days: 1095 },
  { label: '全部', days: null },
] as const;

const ADVICE_TONE: Record<string, Tone> = { info: 'info', warn: 'warn', good: 'good' };

function shiftDate(date: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - days * 86_400_000).toISOString().slice(0, 10);
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-1.5 text-sm last:border-0 dark:border-slate-800/60">
      <span className="shrink-0 text-slate-500 dark:text-slate-400">{label}</span>
      <span className="min-w-0 text-right">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

export function FundDrawer({
  record,
  onClose,
}: {
  /** 来自数据集的记录，保证抽屉与列表口径一致；打开时再拉详情 */
  record: FundRecord;
  onClose: () => void;
}) {
  const [rangeIndex, setRangeIndex] = useState(3); // 默认近1年
  const detailQuery = useQuery({
    queryKey: ['qdii', 'fund', record.code],
    queryFn: () => api.getQdiiFund(record.code),
    staleTime: 10 * 60_000,
  });

  const detail: QdiiFundDetailResponse | undefined = detailQuery.data;

  const navSeries = useMemo(() => {
    const points = detail?.navTrend ?? [];
    const range = NAV_RANGES[rangeIndex];
    if (!range || range.days === null || points.length === 0) return points;
    const last = points.at(-1);
    if (!last) return points;
    const cutoff = shiftDate(last.date, range.days);
    return points.filter((point) => point.date >= cutoff);
  }, [detail?.navTrend, rangeIndex]);

  return (
    <Drawer
      open
      onClose={onClose}
      title={record.name}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <span className="tabular">{record.code}</span>
          <span>{record.fundType}</span>
          <Badge tone={record.buyable ? 'warn' : 'neutral'}>
            {record.status === '' ? '数据缺失' : record.status}
          </Badge>
          <span>{record.currency}</span>
        </span>
      }
    >
      <div className="space-y-6">
        {/* 1) 购买建议置顶 */}
        <Section title="购买建议">
          {detailQuery.isPending ? (
            <p className="text-sm text-slate-400">加载中…</p>
          ) : detail && detail.advice.length > 0 ? (
            <ul className="space-y-2">
              {detail.advice.map((item) => (
                <li
                  key={item.title}
                  className="rounded-md border border-slate-200 px-3 py-2 dark:border-slate-800"
                >
                  <div className="flex items-center gap-2">
                    <Badge tone={ADVICE_TONE[item.tone] ?? 'neutral'}>{item.title}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{item.text}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-400">暂无建议</p>
          )}
        </Section>

        {detailQuery.isError ? (
          <ErrorState
            message="详情加载失败"
            detail={detailQuery.error instanceof Error ? detailQuery.error.message : undefined}
          />
        ) : null}

        {/* 2) 当前额度 */}
        <Section title="当前额度">
          <div>
            <InfoRow
              label="日累计限额"
              value={<span className="tabular">{record.limitText}</span>}
            />
            <InfoRow
              label="申购起点"
              value={<span className="tabular">{record.minPurchaseText}</span>}
            />
            <InfoRow label="赎回状态" value={record.redeemStatus || '--'} />
            <InfoRow label="下一开放日" value={record.nextOpenDate ?? '--'} />
            <InfoRow
              label="单位净值"
              value={`${formatNumber(record.nav)}（${record.navDate ?? '--'}）`}
            />
            <InfoRow label="费率" value={record.fee || '--'} />
            {detail?.base?.company ? (
              <InfoRow label="基金公司" value={detail.base.company} />
            ) : null}
            {detail?.base?.manager ? (
              <InfoRow label="基金经理" value={detail.base.manager} />
            ) : null}
            {detail?.base?.rate ? (
              <InfoRow
                label="费率（实时）"
                value={`${detail.base.sourceRate ?? '--'} → ${detail.base.rate}`}
              />
            ) : null}
            <InfoRow
              label="额度采集于"
              value={<span className="text-xs text-slate-500">{record.capturedAt}</span>}
            />
          </div>
        </Section>

        {/* 3) 同基金其它份额类别 */}
        {detail && detail.shareClasses.length > 0 ? (
          <Section title="同基金其它份额类别">
            <ul className="space-y-1.5">
              {detail.shareClasses.map((item) => (
                <li
                  key={item.code}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
                >
                  <span className="tabular text-slate-500 dark:text-slate-400">{item.code}</span>
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <Badge tone="neutral">{item.status || '未知'}</Badge>
                  <span className="tabular">
                    {item.dailyLimit === null ? '无限额' : `${item.dailyLimit} 元`}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {/* 4) 净值走势 */}
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
              {detail?.navSummary.map((row) => (
                <div
                  key={row.label}
                  className="rounded-md bg-slate-50 p-2 text-center dark:bg-slate-800/50"
                >
                  <p className="text-xs text-slate-500 dark:text-slate-400">{row.label}</p>
                  <p className="tabular text-sm font-medium">{formatPercent(row.returnPct)}</p>
                  <p className="tabular text-xs text-rose-500">
                    {formatPercent(row.maxDrawdownPct)}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-400">上排为区间涨幅，下排为最大回撤</p>
          </Section>
        ) : null}

        {/* 5) 收益表现 */}
        {detail && detail.periods.length > 0 ? (
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
                      <td className="tabular px-3 py-1.5 text-right font-medium">
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

        {/* 6) 规模变动 */}
        {detail && detail.scale.length > 0 ? (
          <Section title="规模变动（季度，亿元）">
            <Chart
              categories={detail.scale.map((point) => point.date)}
              series={[
                {
                  name: '净资产规模',
                  type: 'bar',
                  data: detail.scale.map((point) => point.scale),
                },
              ]}
              height={200}
              yFormatter={(value) => `${value}`}
            />
          </Section>
        ) : null}

        {/* 7) 资产配置 / 持有人结构 */}
        {detail && (detail.allocation.length > 0 || detail.holders.length > 0) ? (
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

        {/* 8) 主要成分 */}
        {detail ? (
          <Section title={`主要成分${detail.reportDate ? `（报告期 ${detail.reportDate}）` : ''}`}>
            {detail.holdings.stocks.length > 0 ? (
              <ul className="space-y-1">
                {detail.holdings.stocks.map((stock) => (
                  <li
                    key={`${stock.code}-${stock.name}`}
                    className="flex items-center justify-between gap-3 border-b border-slate-100 py-1 text-sm last:border-0 dark:border-slate-800/60"
                  >
                    <span className="tabular w-16 shrink-0 text-slate-500">
                      {stock.code ?? '--'}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{stock.name ?? '--'}</span>
                    {stock.action ? (
                      <span className="text-xs text-slate-400">
                        {stock.action}
                        {stock.delta !== null ? ` ${stock.delta}%` : ''}
                      </span>
                    ) : null}
                    <span className="tabular w-16 text-right">
                      {formatPercent(stock.weight, 2)}
                    </span>
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
                <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                  债券持仓
                </p>
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
        ) : null}

        {/* 9) 最近限购公告 */}
        {detail && detail.notices.length > 0 ? (
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

        {/* 部分区块失败时的说明 */}
        {detail && detail.errors.length > 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <p className="font-medium">部分数据暂不可用</p>
            <ul className="mt-1 list-inside list-disc">
              {detail.errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="pb-2 text-xs text-slate-400">{detail?.disclaimer ?? ''}</p>
      </div>
    </Drawer>
  );
}
