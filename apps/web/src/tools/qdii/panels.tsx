import type { ChangeItem, FundRecord, QdiiPremiumResponse } from '@funds-helper/shared';
import { useState } from 'react';
import { Badge, Chip, EmptyState, ErrorState, FilterRow, Spinner } from '../../components/ui.tsx';
import { apiErrorDetail } from '../../lib/api.ts';
import { formatPremium } from '../../lib/format.ts';
import {
  CHANGE_DIRECTION_FILTERS,
  CHANGE_FIELD_FILTERS,
  CHANGE_FIELD_LABELS,
  CHANGE_RANGES,
  type ChangeFilters,
  changesSummary,
  changeValueText,
  DEFAULT_CHANGE_FILTERS,
  directionLabel,
  refineChanges,
} from './changes-filters.ts';

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

/** 额度变更记录 —— 上游没有历史接口，这些是工具自己累积出来的 */
export function ChangesPanel({
  items,
  isPending,
  error,
  nameOf,
  selectedCode,
  onSelect,
  days,
  onDaysChange,
}: {
  items: readonly ChangeItem[];
  isPending: boolean;
  error: unknown;
  nameOf: (code: string) => string | undefined;
  selectedCode: string | null;
  onSelect: (code: string) => void;
  days: number;
  onDaysChange: (days: number) => void;
}) {
  // 筛选与折叠只活在页面内（切 tab / 刷新即重置），不进 URL
  const [filters, setFilters] = useState<ChangeFilters>(DEFAULT_CHANGE_FILTERS);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  if (isPending) return <Spinner label="加载变更记录…" />;
  if (error) {
    return <ErrorState message="变更记录加载失败" detail={apiErrorDetail(error)} />;
  }
  if (items.length === 0) {
    return (
      <EmptyState
        message={`近 ${days} 天还没有检测到额度变更。工具会在每次抓取后与上一交易日对比，累积出变更历史。`}
      />
    );
  }

  const groups = refineChanges(items, filters);
  const summary = changesSummary(groups);
  const viewTotal = summary.tightened + summary.loosened;

  function toggleCollapsed(code: string): void {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <FilterRow label="方向">
          {CHANGE_DIRECTION_FILTERS.map((item) => (
            <Chip
              key={item.value}
              active={filters.direction === item.value}
              onClick={() => setFilters({ ...filters, direction: item.value })}
            >
              {item.label}
            </Chip>
          ))}
        </FilterRow>

        <FilterRow label="变更字段">
          {CHANGE_FIELD_FILTERS.map((item) => (
            <Chip
              key={item.value}
              active={filters.field === item.value}
              onClick={() => setFilters({ ...filters, field: item.value })}
            >
              {item.label}
            </Chip>
          ))}
        </FilterRow>

        <FilterRow label="时间范围">
          {CHANGE_RANGES.map((item) => (
            <Chip
              key={item.value}
              active={days === item.value}
              onClick={() => onDaysChange(item.value)}
            >
              {item.label}
            </Chip>
          ))}
        </FilterRow>

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <input
            value={filters.keyword}
            onChange={(event) => setFilters({ ...filters, keyword: event.target.value })}
            placeholder="搜索基金代码或名称"
            className="min-w-56 flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-950"
          />
          <Chip
            active={filters.multiOnly}
            title="只保留窗口内被调整了 2 次以上的基金"
            onClick={() => setFilters({ ...filters, multiOnly: !filters.multiOnly })}
          >
            只看多次变更
          </Chip>
          <button
            type="button"
            onClick={() => setFilters(DEFAULT_CHANGE_FILTERS)}
            className="rounded-md border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            清空筛选
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          <span>
            收紧{' '}
            <strong className="tabular text-rose-600 dark:text-rose-400">
              {summary.tightened}
            </strong>{' '}
            次
          </span>
          <span>
            放宽{' '}
            <strong className="tabular text-emerald-600 dark:text-emerald-400">
              {summary.loosened}
            </strong>{' '}
            次
          </span>
          <span>
            涉及{' '}
            <strong className="tabular text-slate-800 dark:text-slate-100">{summary.funds}</strong>{' '}
            只基金
          </span>
          <span>其中多次变更 {summary.multi} 只</span>
          {viewTotal < items.length ? (
            <span>
              （近 {days} 天共 {items.length} 次）
            </span>
          ) : null}
        </div>
      </section>

      {groups.length === 0 ? (
        <EmptyState
          message="没有符合当前筛选的额度变更。"
          action={
            <button
              type="button"
              onClick={() => setFilters(DEFAULT_CHANGE_FILTERS)}
              className="rounded-md bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500"
            >
              清空筛选
            </button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {groups.map((group) => {
            const collapsible = group.items.length >= 2;
            const isCollapsed = collapsible && collapsed.has(group.code);
            // 只有仍在当前数据集里的基金才打得开详情抽屉（抽屉的记录来自数据集）
            const name = nameOf(group.code);
            // 已不在数据集里的基金，服务端只能回传代码，此时明确提示而不是再显示一遍代码
            const label = name ?? (group.name === group.code ? '（已不在当前列表中）' : group.name);
            const identity = (
              <>
                <span className="tabular shrink-0 text-slate-500 dark:text-slate-400">
                  {group.code}
                </span>
                <span className="min-w-0 truncate font-medium" title={label}>
                  {label}
                </span>
              </>
            );
            return (
              <li
                key={group.code}
                className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
              >
                <div
                  className={
                    'flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 ' +
                    (group.code === selectedCode ? 'bg-sky-50 dark:bg-sky-950/40' : '')
                  }
                >
                  {collapsible ? (
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(group.code)}
                      aria-expanded={!isCollapsed}
                      title={isCollapsed ? '展开这只基金的全部变更' : '收起'}
                      className="w-4 shrink-0 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                    >
                      {isCollapsed ? '▸' : '▾'}
                    </button>
                  ) : (
                    <span className="w-4 shrink-0" />
                  )}
                  {name === undefined ? (
                    <span className="flex min-w-0 flex-1 items-center gap-x-3">{identity}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSelect(group.code)}
                      title={`查看 ${name} 的详情`}
                      className="flex min-w-0 flex-1 items-center gap-x-3 rounded text-left hover:text-sky-700 hover:underline dark:hover:text-sky-400"
                    >
                      {identity}
                    </button>
                  )}
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {group.items.length} 次变更
                  </span>
                  {group.tightened > 0 ? <Badge tone="danger">收紧 {group.tightened}</Badge> : null}
                  {group.loosened > 0 ? <Badge tone="good">放宽 {group.loosened}</Badge> : null}
                </div>

                {isCollapsed ? null : (
                  <ul className="border-t border-slate-100 dark:border-slate-800">
                    {group.items.map((item) => (
                      <li
                        key={`${item.field}-${item.dataDate}`}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 px-3 py-1.5 text-sm last:border-0 dark:border-slate-800/60"
                      >
                        <span className="tabular w-20 shrink-0 text-xs text-slate-400">
                          {item.dataDate}
                        </span>
                        <span className="w-24 shrink-0 text-xs text-slate-500 dark:text-slate-400">
                          {CHANGE_FIELD_LABELS[item.field] ?? item.field}
                        </span>
                        <span className="tabular min-w-0 flex-1 text-xs">
                          <span className="text-slate-400 line-through">
                            {changeValueText(item.field, item.oldValue)}
                          </span>
                          <span className="mx-1 text-slate-400">→</span>
                          <span className="font-medium">
                            {changeValueText(item.field, item.newValue)}
                          </span>
                        </span>
                        <Badge tone={item.direction === 'tightened' ? 'danger' : 'good'}>
                          {directionLabel(item.direction)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function fundNameLookup(funds: readonly FundRecord[]): (code: string) => string | undefined {
  const names = new Map(funds.map((fund) => [fund.code, fund.name]));
  return (code) => names.get(code);
}
