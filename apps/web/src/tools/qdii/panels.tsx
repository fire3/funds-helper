import type { ChangeItem, FundRecord, QdiiPremiumResponse } from '@funds-helper/shared';
import { Badge, EmptyState, ErrorState, Spinner } from '../../components/ui.tsx';
import { apiErrorDetail } from '../../lib/api.ts';
import { formatPremium } from '../../lib/format.ts';

/**
 * 场内折溢价排行。
 *
 * 上游 f402 负值代表溢价，这里统一展示成「溢价 X%」——
 * 场外限购时转战场内的代价全在这个数字里（QDII ETF 溢价 8%~10% 是常态）。
 */
export function PremiumPanel({
  data,
  isPending,
  error,
}: {
  data: QdiiPremiumResponse | undefined;
  isPending: boolean;
  error: unknown;
}) {
  if (isPending) return <Spinner label="加载场内行情…" />;

  if (error) {
    return <ErrorState message="行情加载失败" detail={apiErrorDetail(error)} />;
  }

  if (!data || data.items.length === 0) {
    return <EmptyState message="当前没有可用的场内 QDII 行情。" />;
  }

  return (
    <div className="space-y-3">
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
        溢价意味着场内价格高于基金净值，转战场内等于多付这部分成本。买入前务必先看这一列。
      </p>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <th className="px-3 py-2 font-medium">代码</th>
              <th className="px-3 py-2 font-medium">名称</th>
              <th className="px-3 py-2 text-right font-medium">最新价</th>
              <th className="px-3 py-2 text-right font-medium">单位净值</th>
              <th className="px-3 py-2 text-right font-medium">溢价/折价</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => {
              const premium = formatPremium(item.premiumRate);
              return (
                <tr
                  key={item.code}
                  className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
                >
                  <td className="tabular px-3 py-2 text-slate-500 dark:text-slate-400">
                    {item.code}
                  </td>
                  <td className="px-3 py-2">{item.name}</td>
                  <td className="tabular px-3 py-2 text-right">{item.price?.toFixed(3) ?? '--'}</td>
                  <td className="tabular px-3 py-2 text-right">{item.nav?.toFixed(4) ?? '--'}</td>
                  <td className="px-3 py-2 text-right">
                    <Badge tone={premium.tone === 'premium' ? 'danger' : 'good'}>
                      {premium.text}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400">
        共 {data.items.length} 只场内 QDII · {data.disclaimer}
      </p>
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = {
  daily_limit: '日累计限额',
  status: '申购状态',
  redeem_status: '赎回状态',
  min_purchase: '申购起点',
};

/** 额度变更记录 —— 上游没有历史接口，这些是工具自己累积出来的 */
export function ChangesPanel({
  items,
  isPending,
  error,
  nameOf,
}: {
  items: readonly ChangeItem[];
  isPending: boolean;
  error: unknown;
  nameOf: (code: string) => string | undefined;
}) {
  if (isPending) return <Spinner label="加载变更记录…" />;
  if (error) {
    return <ErrorState message="变更记录加载失败" detail={apiErrorDetail(error)} />;
  }
  if (items.length === 0) {
    return (
      <EmptyState message="还没有检测到额度变更。工具会在每次抓取后与上一交易日对比，累积出变更历史。" />
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li
          key={`${item.code}-${item.field}-${item.dataDate}-${item.detectedAt}`}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900"
        >
          <Badge tone={item.direction === 'tightened' ? 'danger' : 'good'}>
            {item.direction === 'tightened' ? '收紧' : '放宽'}
          </Badge>
          <span className="tabular text-slate-500 dark:text-slate-400">{item.code}</span>
          <span className="min-w-0 flex-1 truncate" title={nameOf(item.code)}>
            {nameOf(item.code) ?? '（已不在当前列表中）'}
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {FIELD_LABELS[item.field] ?? item.field}
          </span>
          <span className="tabular text-xs">
            <span className="text-slate-400 line-through">{item.oldValue ?? '无限额'}</span>
            <span className="mx-1 text-slate-400">→</span>
            <span className="font-medium">{item.newValue ?? '无限额'}</span>
          </span>
          <span className="tabular text-xs text-slate-400">{item.dataDate}</span>
        </li>
      ))}
    </ul>
  );
}

export function fundNameLookup(funds: readonly FundRecord[]): (code: string) => string | undefined {
  const names = new Map(funds.map((fund) => [fund.code, fund.name]));
  return (code) => names.get(code);
}
