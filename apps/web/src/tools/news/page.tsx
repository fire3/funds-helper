import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Chip, ErrorState } from '../../components/ui.tsx';
import { api, apiErrorDetail } from '../../lib/api.ts';
import { FeedList } from './FeedList.tsx';
import {
  fromSearchParams,
  NEWS_TAB_LABELS,
  NEWS_TABS,
  type NewsFilters,
  toSearchParams,
} from './filters.ts';
import { NewsSettingsPanel } from './SettingsPanel.tsx';
import { SourcesPanel } from './SourcesPanel.tsx';
import { NewsSummaryView } from './SummaryView.tsx';

/**
 * `news` 工具的入口：四个 tab + 全局窗口选择。
 *
 * 筛选与 tab 全部写进 URL（可分享、刷新可复现）；**信息流与简报是两条独立读路径**，
 * 模型挂了也能正常浏览信息流（这是整个工具的可用性下限）。
 */
export default function NewsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const view = useMemo(() => fromSearchParams(searchParams), [searchParams]);

  const apply = useCallback(
    (next: NewsFilters) => setSearchParams(toSearchParams(next)),
    [setSearchParams],
  );

  const refresh = useMutation({
    mutationFn: () => api.refreshNews(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['news'] }),
  });

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">财经信息流</h1>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            全球英文财经媒体今天发生了什么？用中文讲清楚。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="rounded-md border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {refresh.isPending ? '抓取中…' : '立即抓取信源'}
          </button>
        </div>
      </header>

      {refresh.isError ? (
        <ErrorState message="抓取失败" detail={apiErrorDetail(refresh.error)} />
      ) : null}
      {refresh.data ? (
        <p
          className={
            refresh.data.ok
              ? 'rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
          }
        >
          {refresh.data.message}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {NEWS_TABS.map((tab) => (
            <Chip key={tab} active={view.tab === tab} onClick={() => apply({ ...view, tab })}>
              {NEWS_TAB_LABELS[tab]}
            </Chip>
          ))}
        </div>

        {/* 窗口只对简报有意义；信息流自己有一行筛选（两者语义不同，硬合成一个枚举会骗人） */}
        {view.tab === 'summary' ? (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-500 dark:text-slate-400">窗口</span>
            <WindowChips value={view.window} onChange={(window) => apply({ ...view, window })} />
          </div>
        ) : null}
      </div>

      {view.tab === 'summary' ? <NewsSummaryView window={view.window} /> : null}
      {view.tab === 'feed' ? <FeedList view={view} onApply={apply} /> : null}
      {view.tab === 'sources' ? <SourcesPanel /> : null}
      {view.tab === 'settings' ? <NewsSettingsPanel /> : null}
    </div>
  );
}

const WINDOWS = ['today', 'yesterday', 'last7d'] as const;

function WindowChips({
  value,
  onChange,
}: {
  value: NewsFilters['window'];
  onChange: (window: NewsFilters['window']) => void;
}) {
  const labels: Record<NewsFilters['window'], string> = {
    today: '今日',
    yesterday: '昨日',
    last7d: '近 7 日',
  };
  return (
    <>
      {WINDOWS.map((window) => (
        <Chip key={window} active={value === window} onClick={() => onChange(window)}>
          {labels[window]}
        </Chip>
      ))}
    </>
  );
}
