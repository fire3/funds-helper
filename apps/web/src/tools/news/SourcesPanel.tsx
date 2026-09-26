import { NEWS_CATEGORY_LABELS, type NewsSourcesResponse } from '@funds-helper/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, ErrorState, SectionCard, Spinner } from '../../components/ui.tsx';
import { api, apiErrorDetail, apiErrorMessage } from '../../lib/api.ts';
import { formatDateTime, formatRelative } from '../../lib/format.ts';

/**
 * 信源健康页：**16 个信源各自的运行状态**。
 *
 * 这一页回答的是「上游还好吗」——`last_status` / `last_error` / 连续失败次数 / 下次抓取，
 * 让「某个站点在挑战我」变成一个可查询的事实，而不是只留在日志里。
 */
export function SourcesPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['news', 'sources'],
    queryFn: (): Promise<NewsSourcesResponse> => api.getNewsSources(),
    staleTime: 30_000,
  });

  const refresh = useMutation({
    mutationFn: () => api.refreshNews(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['news'] }),
  });

  if (query.isPending) return <Spinner label="加载信源状态…" />;
  if (query.isError) {
    return (
      <ErrorState
        message={apiErrorMessage(query.error) ?? '信源状态加载失败'}
        detail={apiErrorDetail(query.error)}
      />
    );
  }

  const { sources, lastRun } = query.data;
  const totalItems = sources.reduce((sum, source) => sum + source.itemCount, 0);
  const failing = sources.filter((source) => source.consecFailures > 0);

  return (
    <div className="space-y-4">
      <SectionCard
        title="信源总览"
        subtitle={
          lastRun === null
            ? '还没有抓取过'
            : `上一轮 ${formatDateTime(lastRun.startedAt)}：${lastRun.okFeeds} 成功 / ` +
              `${lastRun.failFeeds} 失败，新增 ${lastRun.newItems} 条`
        }
        actions={
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {refresh.isPending ? '抓取中…' : '立即抓取'}
          </button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="信源" value={`${sources.length} 个`} hint="全部硬编码在注册表里" />
          <Stat label="条目总量" value={String(totalItems)} hint="180 天保留期，按月清理" />
          <Stat
            label="异常信源"
            value={String(failing.length)}
            hint={failing.length === 0 ? '全部正常' : failing.map((s) => s.name).join('、')}
          />
        </div>

        {refresh.isSuccess ? (
          <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
            {refresh.data.message}
          </p>
        ) : null}
        {refresh.isError ? (
          <div className="mt-3">
            <ErrorState message="抓取失败" detail={apiErrorDetail(refresh.error)} />
          </div>
        ) : null}
        {lastRun?.error ? (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs break-all text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            上一轮错误：{lastRun.error}
          </p>
        ) : null}
      </SectionCard>

      <SectionCard
        title="逐信源状态"
        subtitle="403/429/HTML 挑战页都会体现在这里，并按连续失败次数退避"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800">
                <th className="px-3 py-2 font-medium">信源</th>
                <th className="px-3 py-2 font-medium">分组</th>
                <th className="px-3 py-2 font-medium">轮询</th>
                <th className="px-3 py-2 font-medium">条目</th>
                <th className="px-3 py-2 font-medium">最近抓取</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">下次抓取</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="px-3 py-2">
                    <a
                      href={source.homeUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium hover:text-sky-700 dark:hover:text-sky-300"
                    >
                      {source.name}
                    </a>
                    <p className="text-xs break-all text-slate-400">{source.url}</p>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
                    {NEWS_CATEGORY_LABELS[source.category]}
                    {source.category === 'discovery' ? (
                      <span className="ml-1 text-amber-600">(线索)</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 tabular text-xs text-slate-500">
                    {Math.round(source.cadenceSec / 60)} 分钟 · 权重 {source.weight}
                  </td>
                  <td className="px-3 py-2 tabular text-xs">{source.itemCount}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {source.lastFetchedAt === null ? (
                      '未抓取'
                    ) : (
                      <span title={formatDateTime(source.lastFetchedAt)}>
                        {formatRelative(source.lastFetchedAt)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {source.lastStatus === null ? (
                      <Badge tone="neutral">未抓取</Badge>
                    ) : source.lastStatus >= 400 ? (
                      <Badge tone="danger">HTTP {source.lastStatus}</Badge>
                    ) : source.consecFailures > 0 ? (
                      <Badge tone="warn">连续失败 {source.consecFailures}</Badge>
                    ) : (
                      <Badge tone={source.lastStatus === 304 ? 'neutral' : 'good'}>
                        {source.lastStatus === 304 ? '304 未变更' : `HTTP ${source.lastStatus}`}
                      </Badge>
                    )}
                    {source.lastError !== null ? (
                      <p className="mt-1 max-w-[24rem] break-all text-rose-600/80">
                        {source.lastError}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500" title={source.nextFetchAt}>
                    {formatRelative(source.nextFetchAt)}后
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/40">
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className="tabular mt-1 text-lg font-semibold">{value}</p>
      <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{hint}</p>
    </div>
  );
}
