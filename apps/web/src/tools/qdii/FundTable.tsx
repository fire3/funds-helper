import type { FundRecord } from '@funds-helper/shared';
import { Badge, type Tone } from '../../components/ui.tsx';
import { formatNumber } from '../../lib/format.ts';

const STATUS_TONE: Record<string, Tone> = {
  开放申购: 'good',
  限大额: 'warn',
  暂停申购: 'danger',
  场内交易: 'info',
  封闭期: 'neutral',
  认购期: 'neutral',
  '': 'neutral',
};

/** 额度数字的视觉强调：越紧越醒目 */
function limitTone(fund: FundRecord): string {
  if (fund.dailyLimit === null) return 'text-slate-500 dark:text-slate-400';
  if (fund.dailyLimit <= 10) return 'font-semibold text-rose-600 dark:text-rose-400';
  if (fund.dailyLimit <= 1000) return 'font-medium text-amber-600 dark:text-amber-400';
  return 'font-medium text-slate-700 dark:text-slate-200';
}

export function FundTable({
  funds,
  selectedCode,
  onSelect,
}: {
  funds: readonly FundRecord[];
  selectedCode: string | null;
  onSelect: (code: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <table className="w-full min-w-[900px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <th className="px-3 py-2 font-medium">代码</th>
            <th className="px-3 py-2 font-medium">基金简称</th>
            <th className="px-3 py-2 font-medium">区域</th>
            <th className="px-3 py-2 font-medium">主题</th>
            <th className="px-3 py-2 font-medium">状态</th>
            <th className="px-3 py-2 text-right font-medium">日限额</th>
            <th className="px-3 py-2 text-right font-medium">起点</th>
            <th className="px-3 py-2 text-right font-medium">净值</th>
            <th className="px-3 py-2 text-right font-medium">费率</th>
          </tr>
        </thead>
        <tbody>
          {funds.map((fund) => (
            <tr
              key={`${fund.code}-${fund.currency}`}
              onClick={() => onSelect(fund.code)}
              className={
                `cursor-pointer border-b border-slate-100 transition-colors last:border-0 dark:border-slate-800/60 ` +
                (fund.code === selectedCode
                  ? 'bg-sky-50 dark:bg-sky-950/40'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/50')
              }
            >
              <td className="tabular px-3 py-2 text-slate-500 dark:text-slate-400">{fund.code}</td>
              <td className="max-w-[280px] px-3 py-2">
                <span className="line-clamp-1" title={fund.name}>
                  {fund.name}
                </span>
              </td>
              <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{fund.region}</td>
              <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{fund.theme}</td>
              <td className="px-3 py-2">
                <Badge tone={STATUS_TONE[fund.status] ?? 'neutral'}>
                  {fund.status === '' ? '数据缺失' : fund.status}
                </Badge>
                {fund.currency !== 'CNY' ? (
                  <span className="ml-1 text-xs text-slate-400">{fund.currency}</span>
                ) : null}
              </td>
              <td className={`tabular px-3 py-2 text-right ${limitTone(fund)}`}>
                {fund.limitText}
              </td>
              <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                {fund.minPurchaseText}
              </td>
              <td className="tabular px-3 py-2 text-right text-slate-600 dark:text-slate-300">
                {formatNumber(fund.nav)}
                <span className="ml-1 text-xs text-slate-400">{fund.navDate}</span>
              </td>
              <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                {fund.fee || '--'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
