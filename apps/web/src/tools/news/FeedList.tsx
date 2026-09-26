import {
  NEWS_CATEGORIES,
  NEWS_CATEGORY_LABELS,
  NEWS_RANGE_LABELS,
  NEWS_RANGES,
  type NewsItem,
} from '@funds-helper/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Badge, Chip, EmptyState, ErrorState, Spinner } from '../../components/ui.tsx';
import { api, apiErrorDetail, apiErrorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { type NewsFilters, toggleValue } from './filters.ts';
import { shanghaiDate, shanghaiTime } from './format.ts';

/**
 * 信息流：**服务端筛选 + 游标分页**（条目几个月就是几万行，前端全量拉不现实）。
 *
 * 刻意**不做抽屉**：新闻条目就是一行标题 + 一行摘要 + 一个外链，
 * 抽屉是多余的交互层级；但条目行可点开原文，与其它视图的「可点开」习惯一致。
 *
 * **英文原文不翻译展示** —— 用户要看的正是英文信源，中文只出现在简报里。
 */
export function FeedList({
  view,
  onApply,
}: {
  view: NewsFilters;
  onApply: (next: NewsFilters) => void;
}) {
  const [keywordDraft, setKeywordDraft] = useState(view.keyword);

  const query = useInfiniteQuery({
    queryKey: ['news', 'feed', view.range, view.categories, view.sources, view.keyword],
    queryFn: ({ pageParam }) =>
      api.getNewsFeed({
        range: view.range,
        categories: view.categories,
        sources: view.sources,
        q: view.keyword,
        cursor: pageParam,
        limit: 100,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 60_000,
  });

  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? null;
  const freshness = query.data?.pages[0]?.freshness;

  /** 按 Asia/Shanghai 的日期分组（信息流的阅读节奏是「今天有什么」） */
  const groups = useMemo(() => {
    const result: { date: string; items: NewsItem[] }[] = [];
    for (const item of items) {
      const date = shanghaiDate(item.publishedAt ?? item.fetchedAt) ?? '时间未知';
      const last = result.at(-1);
      if (last !== undefined && last.date === date) last.items.push(item);
      else result.push({ date, items: [item] });
    }
    return result;
  }, [items]);

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-start gap-2">
          <span className="w-20 shrink-0 pt-1 text-xs text-slate-500 dark:text-slate-400">
            窗口
          </span>
          <div className="flex flex-1 flex-wrap gap-1.5">
            {NEWS_RANGES.map((range) => (
              <Chip
                key={range}
                active={view.range === range}
                onClick={() => onApply({ ...view, range })}
              >
                {NEWS_RANGE_LABELS[range]}
              </Chip>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-2">
          <span className="w-20 shrink-0 pt-1 text-xs text-slate-500 dark:text-slate-400">
            分组
          </span>
          <div className="flex flex-1 flex-wrap gap-1.5">
            {NEWS_CATEGORIES.map((category) => (
              <Chip
                key={category}
                active={view.categories.includes(category)}
                onClick={() =>
                  onApply({ ...view, categories: toggleValue(view.categories, category) })
                }
              >
                {NEWS_CATEGORY_LABELS[category]}
                {category === 'discovery' ? '（仅线索）' : ''}
              </Chip>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-2">
          <span className="w-20 shrink-0 pt-1 text-xs text-slate-500 dark:text-slate-400">
            搜索
          </span>
          <div className="flex flex-1 items-center gap-2">
            <input
              value={keywordDraft}
              onChange={(event) => setKeywordDraft(event.target.value)}
              // **回车才提交**：实时写 URL 会打断中文输入法（taste 已记录，其它工具同样对齐）
              onKeyDown={(event) => {
                if (event.key === 'Enter') onApply({ ...view, keyword: keywordDraft });
              }}
              placeholder="标题或摘要关键词，回车搜索"
              className="w-64 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-950"
            />
            <button
              type="button"
              onClick={() => onApply({ ...view, keyword: keywordDraft })}
              className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              搜索
            </button>
            {view.keyword !== '' ? (
              <button
                type="button"
                onClick={() => {
                  setKeywordDraft('');
                  onApply({ ...view, keyword: '' });
                }}
                className="text-xs text-slate-500 underline"
              >
                清除
              </button>
            ) : null}
          </div>
        </div>

        <SourcePicker view={view} onApply={onApply} />
      </section>

      {query.isError ? (
        <ErrorState
          message={apiErrorMessage(query.error) ?? '信息流加载失败'}
          detail={apiErrorDetail(query.error)}
        />
      ) : null}
      {query.isPending ? <Spinner label="加载信息流…" /> : null}

      {query.isSuccess ? (
        <>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {NEWS_RANGE_LABELS[view.range]}共 {total ?? items.length} 条
            {items.length < (total ?? 0) ? `（已加载 ${items.length} 条）` : ''}
            {freshness ? ` · 最新抓取 ${shanghaiTime(freshness.fetchedAt) ?? '--'}` : ''}
          </p>

          {items.length === 0 ? (
            <EmptyState
              message={
                view.keyword === ''
                  ? '该条件下没有条目（换个窗口或先抓取一次信源）'
                  : '没有匹配的条目'
              }
            />
          ) : (
            <div className="space-y-4">
              {groups.map((group) => (
                <section key={group.date}>
                  <div className="mb-2 flex items-center gap-3">
                    <h2 className="text-sm font-semibold">── {group.date} ──</h2>
                    <span className="text-xs text-slate-400">{group.items.length} 条</span>
                    <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
                  </div>
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800/60">
                    {group.items.map((item) => (
                      <FeedRow key={item.id} item={item} />
                    ))}
                  </ul>
                </section>
              ))}

              {query.hasNextPage ? (
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={() => query.fetchNextPage()}
                    disabled={query.isFetchingNextPage}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    {query.isFetchingNextPage ? '加载中…' : '加载更多'}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function FeedRow({ item }: { item: NewsItem }) {
  return (
    <li className="group py-2.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="w-10 shrink-0 text-xs tabular text-slate-400">
          {shanghaiTime(item.publishedAt ?? item.fetchedAt) ?? '时间未知'}
        </span>
        <span className="text-xs text-slate-500 dark:text-slate-400">{item.sourceName}</span>
        <Badge tone={item.category === 'policy' ? 'info' : item.discovery ? 'warn' : 'neutral'}>
          {NEWS_CATEGORY_LABELS[item.category]}
        </Badge>
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 text-sm font-medium leading-snug text-slate-800 hover:text-sky-700 dark:text-slate-100 dark:hover:text-sky-300"
        >
          {item.title}
        </a>
        <span
          className={cn(
            'text-xs text-slate-300 opacity-0 transition-opacity group-hover:opacity-100',
            'dark:text-slate-600',
          )}
          aria-hidden
        >
          ↗
        </span>
      </div>
      {item.summary !== null && item.summary !== '' ? (
        <p className="mt-1 pl-12 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {item.summary}
        </p>
      ) : null}
      {item.publishedAt === null ? (
        <p className="mt-1 pl-12 text-xs text-slate-400">上游未提供发布时间，按抓取时间排序</p>
      ) : null}
    </li>
  );
}

/** 信源多选：15 个信源塞进一行 chips 太吵，用可折叠的选择器 */
function SourcePicker({
  view,
  onApply,
}: {
  view: NewsFilters;
  onApply: (next: NewsFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['news', 'sources'],
    queryFn: () => api.getNewsSources(),
    staleTime: 5 * 60_000,
  });
  const sources = query.data?.sources ?? [];

  return (
    <div className="flex flex-wrap items-start gap-2">
      <span className="w-20 shrink-0 pt-1 text-xs text-slate-500 dark:text-slate-400">信源</span>
      <div className="flex flex-1 flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {view.sources.length === 0 ? '全部信源（15）' : `已选 ${view.sources.length} 个信源`}
        </button>
        {view.sources.length > 0 ? (
          <button
            type="button"
            onClick={() => onApply({ ...view, sources: [] })}
            className="text-xs text-slate-500 underline"
          >
            清除
          </button>
        ) : null}
        {view.sources.map((id) => (
          <Chip
            key={id}
            active
            onClick={() => onApply({ ...view, sources: toggleValue(view.sources, id) })}
          >
            {sources.find((source) => source.id === id)?.name ?? id} ×
          </Chip>
        ))}
      </div>

      {open ? (
        <div className="flex w-full flex-wrap gap-1.5 pl-24">
          {sources.map((source) => (
            <Chip
              key={source.id}
              active={view.sources.includes(source.id)}
              onClick={() => onApply({ ...view, sources: toggleValue(view.sources, source.id) })}
              title={source.url}
            >
              {source.name}
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}
