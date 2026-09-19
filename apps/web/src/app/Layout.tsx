import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { cn } from '../lib/cn.ts';
import { useTheme } from '../lib/theme.ts';
import { WEB_TOOLS } from '../tools/registry.ts';

const DISCLAIMER = '数据来自天天基金公开接口，仅供参考，实际限额以基金公司最新公告为准';

export function AppLayout() {
  const { dark, toggle } = useTheme();
  const { pathname } = useLocation();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-3">
          <span className="text-base font-semibold">基金理财工具箱</span>
          <span className="hidden text-xs text-slate-400 sm:inline">funds-helper</span>
        </div>
        <button
          type="button"
          onClick={toggle}
          className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          aria-label="切换深色模式"
        >
          {dark ? '浅色' : '深色'}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="工具列表"
          className="hidden w-52 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-3 md:block dark:border-slate-800 dark:bg-slate-900"
        >
          <NavLink
            to="/"
            className={({ isActive }) =>
              cn(
                'block rounded-md px-3 py-2 text-sm',
                isActive
                  ? 'bg-sky-50 font-medium text-sky-700 dark:bg-sky-950 dark:text-sky-300'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
              )
            }
          >
            首页
          </NavLink>

          <p className="mt-4 px-3 text-xs font-medium text-slate-400">工具</p>
          <ul className="mt-1 space-y-0.5">
            {WEB_TOOLS.map((tool) => (
              <li key={tool.descriptor.id}>
                <NavLink
                  to={`/tools/${tool.descriptor.id}`}
                  className={cn(
                    'block rounded-md px-3 py-2 text-sm',
                    pathname.startsWith(`/tools/${tool.descriptor.id}`)
                      ? 'bg-sky-50 font-medium text-sky-700 dark:bg-sky-950 dark:text-sky-300'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                  )}
                >
                  {tool.descriptor.name}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>

      <footer className="border-t border-slate-200 bg-white px-4 py-2 text-center text-xs text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-500">
        {DISCLAIMER}
      </footer>
    </div>
  );
}
