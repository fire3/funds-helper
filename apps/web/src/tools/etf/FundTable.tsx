import type { EtfSortDir, EtfSortKey } from '@funds-helper/core';
import type { EtfRecord } from '@funds-helper/shared';
import { Badge, type Tone } from '../../components/ui.tsx';
import { formatNumber, formatPercent, formatYuan, trendClass } from '../../lib/format.ts';

/**
 * ETF 列表表格。
 *
 * 折溢价用中性色 + 文案（不是涨跌配色）—— 溢价高意味着「买贵了」是风险，
 * 与「今天涨了」是两件事，混用红绿会误导。
 *
 * **每个表头都可点击排序**（再点一次反转方向，方向由箭头表达）；排序状态由外部
 * 持有并写进 URL，因此列的显隐（渠道能力不同）不会重置排序。
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

/** 可点击排序的表头：箭头常驻占位（`opacity-0`），避免列宽随状态跳动 */
function SortableTh({
  label,
  sortKey,
  sort,
  dir,
  onSort,
  align = 'left',
  title,
}: {
  label: string;
  sortKey: EtfSortKey;
  sort: EtfSortKey;
  dir: EtfSortDir;
  onSort: (key: EtfSortKey) => void;
  align?: 'left' | 'right';
  title?: string;
}) {
  const active = sort === sortKey;
  return (
    <th
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`px-3 py-2 font-medium ${align === 'right' ? 'text-right' : ''}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={title ?? '点击按此列排序，再点一次反转方向'}
        className={`inline-flex cursor-pointer items-center gap-1 rounded transition-colors hover:text-sky-700 dark:hover:text-sky-300 ${
          active ? 'text-sky-700 dark:text-sky-400' : ''
        }`}
      >
        {label}
        <span className={active ? 'opacity-70' : 'opacity-0'} aria-hidden>
          {dir === 'asc' ? '↑' : '↓'}
        </span>
      </button>
    </th>
  );
}

export function FundTable({
  funds,
  selectedCode,
  onSelect,
  sort,
  dir,
  onSort,
}: {
  funds: readonly EtfRecord[];
  selectedCode: string | null;
  onSelect: (code: string) => void;
  /** 当前排序列（与排序下拉、URL 的 `?sort=` 同源） */
  sort: EtfSortKey;
  /** 当前排序方向（`?dir=`） */
  dir: EtfSortDir;
  onSort: (key: EtfSortKey) => void;
}) {
  // 渠道能力不同（新浪列表没有 IOPV 与上市日期）：整列都是空的时候直接隐藏，
  // 否则一屏 1600 行 '--' 只会让人以为「数据坏了」
  const hasPremium = funds.some((fund) => fund.premiumRate !== null);
  const hasListingDate = funds.some((fund) => fund.listingDate !== null);
  // 场外联接基金是**独立的反查快照**：没反查过时整个表都是空数组，此时不该多出一列 '--'
  const hasFeeder = funds.some((fund) => fund.feederFunds.length > 0);
  // 区间涨幅（接口 H）同样是独立慢链路：没抓过时不显示列（排序下拉里也应被忽略，null 恒排最后）
  const hasRet1y = funds.some((fund) => fund.ret1y !== null);
  const hasRet3y = funds.some((fund) => fund.ret3y !== null);

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <table className="w-full min-w-[1080px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <SortableTh label="代码" sortKey="code" sort={sort} dir={dir} onSort={onSort} />
            <SortableTh label="简称" sortKey="name" sort={sort} dir={dir} onSort={onSort} />
            <SortableTh
              label="分类"
              sortKey="category"
              sort={sort}
              dir={dir}
              onSort={onSort}
              title="按分类顺序排（宽基 → 行业主题 → …），再点一次反转"
            />
            <SortableTh label="跟踪指数" sortKey="index" sort={sort} dir={dir} onSort={onSort} />
            {hasFeeder ? (
              <SortableTh
                label="场外联接"
                sortKey="feeder"
                sort={sort}
                dir={dir}
                onSort={onSort}
                align="right"
                title="场外可申赎的联接基金份额数（点开详情看代码）"
              />
            ) : null}
            <SortableTh
              label="最新价"
              sortKey="price"
              sort={sort}
              dir={dir}
              onSort={onSort}
              align="right"
            />
            <SortableTh
              label="涨跌幅"
              sortKey="changePct"
              sort={sort}
              dir={dir}
              onSort={onSort}
              align="right"
            />
            {hasPremium ? (
              <SortableTh
                label="折溢价"
                sortKey="premium"
                sort={sort}
                dir={dir}
                onSort={onSort}
                align="right"
                title="按折溢价率排序（正数 = 场内价高于净值），再点一次反转方向"
              />
            ) : null}
            <SortableTh
              label="成交额"
              sortKey="amount"
              sort={sort}
              dir={dir}
              onSort={onSort}
              align="right"
            />
            <SortableTh
              label="换手"
              sortKey="turnover"
              sort={sort}
              dir={dir}
              onSort={onSort}
              align="right"
            />
            <SortableTh
              label="规模"
              sortKey="scale"
              sort={sort}
              dir={dir}
              onSort={onSort}
              align="right"
            />
            {hasRet1y ? (
              <SortableTh
                label="近1年"
                sortKey="ret1y"
                sort={sort}
                dir={dir}
                onSort={onSort}
                align="right"
                title="区间涨幅来自接口 H（每周刷新），次新 ETF 可能为空"
              />
            ) : null}
            {hasRet3y ? (
              <SortableTh
                label="近3年"
                sortKey="ret3y"
                sort={sort}
                dir={dir}
                onSort={onSort}
                align="right"
                title="区间涨幅来自接口 H（每周刷新），成立不足 3 年的为空"
              />
            ) : null}
            {hasListingDate ? (
              <SortableTh
                label="上市日"
                sortKey="listingDate"
                sort={sort}
                dir={dir}
                onSort={onSort}
                align="right"
              />
            ) : null}
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
              {hasFeeder ? (
                <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                  {fund.feederFunds.length > 0 ? `${fund.feederFunds.length} 只` : '--'}
                </td>
              ) : null}
              <td className="tabular px-3 py-2 text-right">{formatNumber(fund.price, 3)}</td>
              <td className={`tabular px-3 py-2 text-right ${trendClass(fund.changePct)}`}>
                {formatPercent(fund.changePct)}
              </td>
              {hasPremium ? (
                <td
                  className={`tabular px-3 py-2 text-right ${PREMIUM_TONE[fund.premiumLevel] ?? ''}`}
                  {...(fund.premiumNote ? { title: fund.premiumNote } : {})}
                >
                  {fund.premiumText}
                </td>
              ) : null}
              <td className="tabular px-3 py-2 text-right text-slate-600 dark:text-slate-300">
                {formatYuan(fund.amount)}
              </td>
              <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                {formatPercent(fund.turnover)}
              </td>
              <td className="tabular px-3 py-2 text-right text-slate-600 dark:text-slate-300">
                {formatYuan(fund.scale)}
              </td>
              {hasRet1y ? (
                <td className={`tabular px-3 py-2 text-right ${trendClass(fund.ret1y)}`}>
                  {formatPercent(fund.ret1y)}
                </td>
              ) : null}
              {hasRet3y ? (
                <td className={`tabular px-3 py-2 text-right ${trendClass(fund.ret3y)}`}>
                  {formatPercent(fund.ret3y)}
                </td>
              ) : null}
              {hasListingDate ? (
                <td className="tabular px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                  {fund.listingDate ?? '--'}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
