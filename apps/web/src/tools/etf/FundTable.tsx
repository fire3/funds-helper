import type { EtfRecord } from '@funds-helper/shared';
import { Badge, type Tone } from '../../components/ui.tsx';
import { formatNumber, formatPercent, formatYuan, trendClass } from '../../lib/format.ts';

/**
 * ETF 列表表格。
 *
 * 折溢价用中性色 + 文案（不是涨跌配色）—— 溢价高意味着「买贵了」是风险，
 * 与「今天涨了」是两件事，混用红绿会误导。
 */

const CATEGORY_TONE: Record<string, Tone> = {
  宽基: 'info',
  行业主题: 'neutral',
  风格: 'good',
  跨境: 'warn',
  债券: 'neutral',
  商品: 'warn',
  货币: 'good',
};

const PREMIUM_TONE: Record<string, string> = {
  高溢价: 'font-semibold text-rose-600 dark:text-rose-400',
  溢价: 'text-rose-500 dark:text-rose-400',
  平价: 'text-slate-500 dark:text-slate-400',
  折价: 'text-sky-600 dark:text-sky-400',
  高折价: 'text-sky-600 dark:text-sky-400',
  未知: 'text-slate-400 dark:text-slate-500',
};

export function FundTable({
  funds,
  selectedCode,
  onSelect,
}: {
  funds: readonly EtfRecord[];
  selectedCode: string | null;
  onSelect: (code: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <table className="w-full min-w-[1080px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <th className="px-3 py-2 font-medium">代码</th>
            <th className="px-3 py-2 font-medium">简称</th>
            <th className="px-3 py-2 font-medium">分类</th>
            <th className="px-3 py-2 font-medium">跟踪指数</th>
            <th className="px-3 py-2 text-right font-medium">最新价</th>
            <th className="px-3 py-2 text-right font-medium">涨跌幅</th>
            <th className="px-3 py-2 text-right font-medium">折溢价</th>
            <th className="px-3 py-2 text-right font-medium">成交额</th>
            <th className="px-3 py-2 text-right font-medium">换手</th>
            <th className="px-3 py-2 text-right font-medium">规模</th>
            <th className="px-3 py-2 text-right font-medium">上市日</th>
          </tr>
        </thead>
        <tbody>
          {funds.map((fund) => (
            <tr
              key={fund.code}
              onClick={() => onSelect(fund.code)}
              className={
                'cursor-pointer border-b border-slate-100 transition-colors last:border-0 dark:border-slate-800/60 ' +
                (fund.code === selectedCode
                  ? 'bg-sky-50 dark:bg-sky-950/40'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/50')
              }
            >
              <td className="tabular px-3 py-2 text-slate-500 dark:text-slate-400">{fund.code}</td>
              <td className="max-w-[240px] px-3 py-2">
                <span className="line-clamp-1" title={fund.name}>
                  {fund.name}
                </span>
              </td>
              <td className="px-3 py-2">
                <Badge tone={CATEGORY_TONE[fund.category] ?? 'neutral'}>{fund.category}</Badge>
              </td>
              <td
                className="max-w-[160px] truncate px-3 py-2 text-slate-600 dark:text-slate-300"
                title={fund.indexName ?? ''}
              >
                {fund.indexName ?? '--'}
              </td>
              <td className="tabular px-3 py-2 text-right">{formatNumber(fund.price, 3)}</td>
              <td className={`tabular px-3 py-2 text-right ${trendClass(fund.changePct)}`}>
                {formatPercent(fund.changePct)}
              </td>
              <td
                className={`tabular px-3 py-2 text-right ${PREMIUM_TONE[fund.premiumLevel] ?? ''}`}
                {...(fund.premiumNote ? { title: fund.premiumNote } : {})}
              >
                {fund.premiumText}
              </td>
              <td className="tabular px-3 py-2 text-right text-slate-600 dark:text-slate-300">
                {formatYuan(fund.amount)}
              </td>
              <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                {formatPercent(fund.turnover)}
              </td>
              <td className="tabular px-3 py-2 text-right text-slate-600 dark:text-slate-300">
                {formatYuan(fund.scale)}
              </td>
              <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                {fund.listingDate ?? '--'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
