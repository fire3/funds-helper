import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ErrorState, Spinner } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { WEB_TOOLS } from '../tools/registry.ts';

const STATUS_LABEL: Record<string, string> = {
  ready: '可用',
  beta: '试用',
  planned: '规划中',
};

/** 工具箱首页：工具卡片墙。清单由服务端 /api/tools 提供 */
export function HomePage() {
  const toolsQuery = useQuery({
    queryKey: ['tools'],
    queryFn: () => api.listTools(),
    staleTime: 10 * 60_000,
  });

  const pages = new Map(WEB_TOOLS.map((tool) => [tool.descriptor.id, tool.page]));

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">基金理财工具箱</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          每个工具解决一个具体的投资决策问题，共享同一套数据源接入、缓存与落库能力。
        </p>
      </header>

      {toolsQuery.isPending ? <Spinner /> : null}

      {toolsQuery.isError ? (
        <ErrorState
          message="工具清单加载失败"
          detail={toolsQuery.error instanceof Error ? toolsQuery.error.message : undefined}
        />
      ) : null}

      {toolsQuery.data ? (
        <ul className="grid gap-4 sm:grid-cols-2">
          {toolsQuery.data.map((tool) => {
            const Page = pages.get(tool.id);
            const available = Page !== undefined && tool.status !== 'planned';

            return (
              <li
                key={tool.id}
                className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-base font-semibold">{tool.name}</h2>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {STATUS_LABEL[tool.status] ?? tool.status}
                  </span>
                </div>

                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{tool.question}</p>
                <p className="mt-1 text-xs text-slate-400">{tool.summary}</p>

                <div className="mt-4">
                  {available ? (
                    <Link
                      to={`/tools/${tool.id}`}
                      className="inline-flex rounded-md bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500"
                    >
                      打开工具
                    </Link>
                  ) : (
                    <span className="text-xs text-slate-400">尚未实现</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
