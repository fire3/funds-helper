import { sortEtfs } from '@funds-helper/core';
import { ETF_CATEGORIES, type EtfRecord, type EtfStats } from '@funds-helper/shared';
import { Badge, Chip, type Tone } from '../../components/ui.tsx';
import { formatPercent, formatYuan, trendClass } from '../../lib/format.ts';

/**
 * 汇总面板 —— 本工具的主命题（「全市场 ETF 现在什么价、有多大、贵不贵」）的落点。
 *
 * 分类分布、折溢价分布、榜单全部由服务端下发的 `stats` 与本地 records 计算：
 * 分布口径与列表徽标同源（都来自 core 的 describePremium），不会出现两套数字。
 */

const PREMIUM_TONE: Record<string, Tone> = {
  高溢价: 'danger',
  溢价: 'warn',
  平价: 'neutral',
  折价: 'info',
  高折价: 'good',
};

const PREMIUM_LEVELS = ['高溢价', '溢价', '平价', '折价', '高折价'] as const;

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className="tabular mt-1 text-lg font-semibold">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}

function RankList({
  title,
  records,
  value,
  tone,
}: {
  title: string;
  records: readonly EtfRecord[];
  value: (record: EtfRecord) => string;
  tone?: (record: EtfRecord) => string;
}) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium text-slate-500 dark:text-slate-400">{title}</h4>
      {records.length === 0 ? (
        <p className="text-xs text-slate-400">暂无数据</p>
      ) : (
        <ol className="space-y-1">
          {records.map((record, index) => (
            <li key={record.code} className="flex items-center gap-2 text-xs">
              <span className="tabular w-4 shrink-0 text-slate-400">{index + 1}</span>
              <span className="tabular shrink-0 text-slate-500 dark:text-slate-400">
                {record.code}
              </span>
              <span className="min-w-0 flex-1 truncate" title={record.name}>
                {record.name}
              </span>
              <span className={`tabular shrink-0 ${tone?.(record) ?? ''}`}>{value(record)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function EtfSummaryPanel({
  stats,
  records,
  activeCategories,
  onToggleCategory,
}: {
  stats: EtfStats;
  records: readonly EtfRecord[];
  activeCategories: readonly string[];
  onToggleCategory: (category: string) => void;
}) {
  // 榜单用 core 的排序器：口径与表格排序完全一致
  const largest = sortEtfs(records, 'scale').slice(0, 5);
  const active = sortEtfs(records, 'amount').slice(0, 5);
  const premium = sortEtfs(records, 'premium')
    .filter((item) => item.premiumRate !== null)
    .slice(0, 5);
  const discount = sortEtfs(records, 'discount')
    .filter((item) => item.premiumRate !== null)
    .slice(0, 5);
  // 当前渠道没有 IOPV（如新浪列表）时，折溢价分布与两张榜单直接隐藏并说明原因，
  // 而不是展示一排「未知 0」——那会被读成「全市场都是平价」
  const hasPremium = records.some((item) => item.premiumRate !== null);

  const categoryStat = (category: string) =>
    stats.byCategory.find((item) => item.category === category);

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-900/40">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">全市场汇总</h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          目录 {stats.coverage.profile} 只 · 有场内行情 {stats.coverage.spot} 只
          {stats.coverage.unlisted > 0 ? ` · 未上市 ${stats.coverage.unlisted} 只` : ''}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="ETF 数量" value={`${stats.total} 只`} />
        <StatCard
          label="场内规模合计"
          value={formatYuan(stats.totalScale)}
          hint="价格 × 份额，含未披露规模的行按 0 计"
        />
        <StatCard label="成交额合计" value={formatYuan(stats.totalAmount)} />
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-medium text-slate-500 dark:text-slate-400">
          分类分布（点击筛选，数量 / 规模）
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {ETF_CATEGORIES.map((category) => {
            const stat = categoryStat(category);
            if (!stat) return null;
            return (
              <Chip
                key={category}
                active={activeCategories.includes(category)}
                onClick={() => onToggleCategory(category)}
                title={`${stat.count} 只 · 规模 ${formatYuan(stat.scale)}`}
              >
                {category}
                <span className="ml-1 text-xs opacity-70">{stat.count}</span>
                <span className="ml-1 text-xs opacity-60">{formatYuan(stat.scale)}</span>
              </Chip>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-medium text-slate-500 dark:text-slate-400">折溢价分布</h3>
        {hasPremium ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {PREMIUM_LEVELS.map((level) => (
              <Badge key={level} tone={PREMIUM_TONE[level] ?? 'neutral'}>
                {level} {stats.premium.counts[level] ?? 0}
              </Badge>
            ))}
            {stats.premium.unknown > 0 ? (
              <Badge tone="neutral">无数据 {stats.premium.unknown}</Badge>
            ) : null}
            {stats.premium.maxPremium ? (
              <span className="text-slate-500 dark:text-slate-400">
                最贵 {stats.premium.maxPremium.name} 溢价{' '}
                {formatPercent(stats.premium.maxPremium.rate)}
              </span>
            ) : null}
            {stats.premium.maxDiscount ? (
              <span className="text-slate-500 dark:text-slate-400">
                最便宜 {stats.premium.maxDiscount.name} 折价{' '}
                {formatPercent(Math.abs(stats.premium.maxDiscount.rate))}
              </span>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-slate-400 dark:text-slate-500">
            当前行情渠道不提供 IOPV（实时参考净值），折溢价分布与榜单暂不可用。
          </p>
        )}
      </div>

      <div
        className={`grid gap-4 border-t border-slate-200 pt-3 sm:grid-cols-2 dark:border-slate-800 ${
          hasPremium ? 'lg:grid-cols-4' : 'lg:grid-cols-2'
        }`}
      >
        <RankList title="规模最大" records={largest} value={(record) => formatYuan(record.scale)} />
        <RankList
          title="成交最活跃"
          records={active}
          value={(record) => formatYuan(record.amount)}
        />
        {hasPremium ? (
          <>
            <RankList
              title="溢价最高（买贵了）"
              records={premium}
              value={(record) => record.premiumText}
              tone={() => 'text-rose-600 dark:text-rose-400'}
            />
            <RankList
              title="折价最深"
              records={discount}
              value={(record) => record.premiumText}
              tone={(record) => trendClass(record.changePct)}
            />
          </>
        ) : null}
      </div>
    </section>
  );
}
