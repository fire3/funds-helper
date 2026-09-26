import {
  NEWS_RISK_LABEL,
  NEWS_SECTION_KEYS,
  NEWS_SECTION_LABELS,
  NEWS_WATCH_LABEL,
  NEWS_WINDOW_LABELS,
  type NewsSummaryPoint,
  type NewsWindow,
} from '@funds-helper/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, EmptyState, ErrorState, SectionCard, Spinner } from '../../components/ui.tsx';
import { ApiError, api, apiErrorDetail, apiErrorMessage } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { shanghaiDateTime } from './format.ts';

/**
 * 中文简报视图。
 *
 * 三种警示**一律显示在顶部条上，不藏进 tooltip**（dropped / invalidRefs / 旧提示词）——
 * 「模型编造了引用」「预算截断了条目」这类事实必须被看见，否则会变成误导。
 */
export function NewsSummaryView({ window: win }: { window: NewsWindow }) {
  const queryClient = useQueryClient();
  const [showHistory, setShowHistory] = useState(false);

  const summaryQuery = useQuery({
    queryKey: ['news', 'summary', win],
    queryFn: () => api.getNewsSummary(win),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const configQuery = useQuery({
    queryKey: ['news', 'config'],
    queryFn: () => api.getNewsConfig(),
    staleTime: 60_000,
  });
  const historyQuery = useQuery({
    queryKey: ['news', 'history', win],
    queryFn: () => api.getNewsSummaryHistory(win),
    enabled: showHistory,
    staleTime: 60_000,
  });

  const generate = useMutation({
    mutationFn: (force: boolean) => api.generateNewsSummary({ window: win, force }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['news', 'summary', win] });
      queryClient.invalidateQueries({ queryKey: ['news', 'history', win] });
      queryClient.invalidateQueries({ queryKey: ['news', 'config'] });
    },
  });

  const notFound =
    summaryQuery.isError &&
    summaryQuery.error instanceof ApiError &&
    summaryQuery.error.code === 'NOT_FOUND';

  if (summaryQuery.isPending) return <Spinner label="加载简报…" />;

  if (summaryQuery.isError && !notFound) {
    return (
      <ErrorState
        message={apiErrorMessage(summaryQuery.error) ?? '简报加载失败'}
        detail={apiErrorDetail(summaryQuery.error)}
      />
    );
  }

  const summary = summaryQuery.data?.summary;
  const payload = summary?.payload ?? null;
  const disclaimer = summaryQuery.data?.disclaimer ?? '';
  const usage = configQuery.data?.usage;
  const currentPrompt = configQuery.data?.prompts.find(
    (prompt) => prompt.key === summary?.promptKey,
  );
  const promptDrifted =
    summary?.promptHash != null &&
    currentPrompt?.promptHash != null &&
    summary.promptHash !== currentPrompt.promptHash;

  const windowTotal = (summary?.itemCount ?? 0) + (summary?.droppedCount ?? 0);
  const latestHistory = historyQuery.data?.history[0];
  const lastFailure = historyQuery.data?.history.find((row) => row.status === 'failed');

  return (
    <div className="space-y-4">
      {/* ---- 顶部条 ---- */}
      <SectionCard
        title={`${NEWS_WINDOW_LABELS[win]}简报`}
        subtitle={
          summary === undefined || summary === null
            ? '该窗口还没有生成过简报'
            : `${shanghaiDateTime(summary.generatedAt) ?? '--'} 生成 · 模型 ${summary.model ?? '未知'} · ` +
              `提示词 ${summary.promptKey ?? '未知'} (${summary.promptHash ?? '--'}) · ` +
              `${summary.itemCount ?? 0} 条送入模型` +
              ((summary.droppedCount ?? 0) > 0 ? ` / 窗口内 ${windowTotal} 条` : '') +
              (summary.promptTokens != null
                ? ` · tokens ${summary.promptTokens}+${summary.completionTokens ?? 0}`
                : '')
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {usage ? (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                今日 AI 调用 {usage.used}/{usage.limit}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setShowHistory((value) => !value)}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {showHistory ? '收起历史' : '历史'}
            </button>
            <button
              type="button"
              onClick={() => generate.mutate(true)}
              disabled={generate.isPending}
              className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
            >
              {generate.isPending
                ? '生成中…'
                : summary === undefined || summary === null
                  ? '生成简报'
                  : '重新生成'}
            </button>
          </div>
        }
      >
        <div className="space-y-2">
          {generate.isSuccess && generate.data.reused ? (
            <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300">
              距上次生成不足 4 小时且期间没有新条目，返回缓存的那份（本次没有调用模型）。
            </p>
          ) : null}
          {generate.isError ? (
            <ErrorState
              message={apiErrorMessage(generate.error) ?? '生成失败'}
              detail={apiErrorDetail(generate.error)}
            />
          ) : null}

          {summary !== null && summary !== undefined ? (
            <div className="flex flex-col gap-1.5">
              {(summary.droppedCount ?? 0) > 0 ? (
                <Warning>
                  已从 {windowTotal} 条中抽取 {summary.itemCount} 条送入模型 （token
                  预算截断，未送入的不参与总结）
                </Warning>
              ) : null}
              {(summary.invalidRefs ?? 0) > 0 ? (
                <Warning>
                  有 {summary.invalidRefs} 条引用编号越界，已丢弃（要点正文保留，可核验性下降）
                </Warning>
              ) : null}
              {summary.citations === 'none' ? <Warning>本次总结未能关联到原文条目</Warning> : null}
              {promptDrifted ? (
                <Warning>
                  当前简报由旧提示词生成（提示词已修改但尚未重新生成，点「重新生成」可对齐）
                </Warning>
              ) : null}
              {latestHistory?.status === 'failed' ? (
                <Warning>最近一次生成失败：{latestHistory.error ?? '未知原因'}</Warning>
              ) : null}
            </div>
          ) : null}

          {notFound ? (
            <EmptyState
              message={`「${NEWS_WINDOW_LABELS[win]}」还没有生成过简报`}
              action={
                <button
                  type="button"
                  onClick={() => generate.mutate(true)}
                  disabled={generate.isPending}
                  className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
                >
                  {generate.isPending ? '生成中…' : '生成简报'}
                </button>
              }
            />
          ) : null}

          {showHistory ? (
            historyQuery.isPending ? (
              <Spinner label="加载历史…" />
            ) : (
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500 dark:border-slate-800">
                    <th className="py-1.5 pr-2 font-medium">生成时间</th>
                    <th className="py-1.5 pr-2 font-medium">状态</th>
                    <th className="py-1.5 pr-2 font-medium">模型</th>
                    <th className="py-1.5 pr-2 font-medium">提示词</th>
                    <th className="py-1.5 pr-2 font-medium">条数</th>
                    <th className="py-1.5 font-medium">tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {historyQuery.data?.history.map((row) => (
                    <tr key={row.id} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="py-1.5 pr-2 tabular">{formatDateTime(row.generatedAt)}</td>
                      <td className="py-1.5 pr-2">
                        <Badge tone={row.status === 'success' ? 'good' : 'danger'}>
                          {row.status === 'success' ? '成功' : '失败'}
                        </Badge>
                        {row.kind === 'test' ? (
                          <span className="ml-1 text-slate-400">（连通性测试）</span>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-2">{row.model ?? '--'}</td>
                      <td className="py-1.5 pr-2">
                        {row.promptKey ?? '--'} ({row.promptHash ?? '--'})
                      </td>
                      <td className="py-1.5 pr-2 tabular">{row.itemCount ?? '--'}</td>
                      <td className="py-1.5 tabular">
                        {row.promptTokens ?? '--'}+{row.completionTokens ?? '--'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : null}
        </div>
      </SectionCard>

      {lastFailure !== undefined && lastFailure !== null && lastFailure.id !== summary?.id ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          最近一次自动生成失败：{lastFailure.error ?? '未知原因'}（下面展示的是上一次成功的版本）
        </p>
      ) : null}

      {payload !== null ? (
        <>
          <SectionCard
            title="一句话今日要闻"
            subtitle={shanghaiDateTime(summary?.generatedAt ?? null) ?? ''}
          >
            <p className="text-base font-medium leading-relaxed">{payload.headline}</p>
          </SectionCard>

          <div className="grid gap-3 lg:grid-cols-2">
            {NEWS_SECTION_KEYS.map((key) => (
              <SectionCard key={key} title={`🔹 ${NEWS_SECTION_LABELS[key]}`}>
                <Points points={payload.sections[key]} items={payload.items} />
              </SectionCard>
            ))}
            <SectionCard title={`🔹 ${NEWS_RISK_LABEL}`}>
              <Points points={payload.risk} items={payload.items} />
            </SectionCard>
            <SectionCard title={`🔹 ${NEWS_WATCH_LABEL}`} subtitle="0–5 条，尚无条目可引用">
              {payload.watch.length === 0 ? (
                <p className="text-sm text-slate-400">无</p>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {payload.watch.map((item) => (
                    <li key={item} className="leading-relaxed">
                      · {item}
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>

          <p className="text-xs text-slate-400 dark:text-slate-500">{disclaimer}</p>
        </>
      ) : null}
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
      {children}
    </p>
  );
}

/**
 * 一条要点 + 引用角标。
 *
 * 角标**点开原文链接（新窗口）**而不是抽屉：引用的目的是核验，直接跳原文更快。
 * `refs` 为空 = 背景性表述，不渲染角标。
 */
function Points({
  points,
  items,
}: {
  points: readonly NewsSummaryPoint[];
  items: Record<string, { id: number; title: string; url: string; sourceName: string }>;
}) {
  if (points.length === 0) {
    return <p className="text-sm text-slate-400">无</p>;
  }
  return (
    <ul className="space-y-2 text-sm">
      {points.map((point) => (
        <li key={`${point.text}|${point.refs.join(',')}}`} className="leading-relaxed">
          <span>· {point.text}</span>
          {point.refs.map((ref) => {
            const item = items[String(ref)];
            if (item === undefined) return null;
            return (
              <a
                key={ref}
                href={item.url}
                target="_blank"
                rel="noreferrer"
                title={`${item.sourceName}｜${item.title}`}
                className="ml-1 inline-flex items-center rounded bg-slate-100 px-1 text-xs text-sky-700 hover:bg-sky-100 dark:bg-slate-800 dark:text-sky-300 dark:hover:bg-sky-950"
              >
                [{ref}]
              </a>
            );
          })}
        </li>
      ))}
    </ul>
  );
}
