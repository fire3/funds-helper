import type { Freshness } from '@funds-helper/shared';
import { cn } from '../lib/cn.ts';
import { formatDateTime, formatRelative } from '../lib/format.ts';

/**
 * 数据新鲜度徽标。
 *
 * 固定在顶栏展示，避免用户基于过期数据做决策 ——
 * 这是设计里「数据新鲜度契约」的界面落点。
 */
export function FreshnessBadge({
  freshness,
  className,
}: {
  freshness: Freshness | undefined;
  className?: string;
}) {
  if (!freshness) {
    return <span className={cn('text-xs text-slate-400', className)}>数据加载中…</span>;
  }

  const stale = freshness.stale;
  const title = [
    `数据日期：${freshness.dataDate ?? '未知'}`,
    `抓取时间：${formatDateTime(freshness.fetchedAt)}`,
    `来源：${freshness.source}`,
    stale && freshness.staleReason ? `降级原因：${freshness.staleReason}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs',
        stale
          ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
          : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
        className,
      )}
    >
      <span
        className={cn('size-1.5 rounded-full', stale ? 'bg-amber-500' : 'bg-emerald-500')}
        aria-hidden
      />
      数据日期 {freshness.dataDate ?? '未知'}
      <span className="text-slate-400 dark:text-slate-500">
        · {formatRelative(freshness.fetchedAt)}更新
      </span>
      {stale ? <span className="font-medium">· 上游不可用，已降级</span> : null}
    </span>
  );
}
