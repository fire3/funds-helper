import { SORT_LABELS } from '@funds-helper/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { FreshnessBadge } from '../../components/FreshnessBadge.tsx';
import { Chip, EmptyState, ErrorState, Spinner } from '../../components/ui.tsx';
import { api, apiErrorDetail } from '../../lib/api.ts';
import { FundDrawer } from './FundDrawer.tsx';
import { FundTable } from './FundTable.tsx';
import {
  DEFAULT_FILTERS,
  facetCounts,
  fromSearchParams,
  refine,
  SORT_OPTIONS,
  STATUS_FILTERS,
  toggleValue,
  toSearchParams,
  USD_KIND_FILTERS,
  type UsdFilters,
} from './filters.ts';

/** 详情抽屉的 URL 就是列表 URL 的子路径，`/tools/usd/*` 单路由因此不会重挂载 */
function useSelectedCode(): string | null {
  const { pathname } = useLocation();
  return useMemo(() => {
    const rest = pathname.replace(/^\/tools\/usd\/?/, '');
    if (rest === '') return null;
    return decodeURIComponent(rest.split('/')[0] ?? '');
  }, [pathname]);
}

export default function UsdPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const searchRef = useRef<HTMLInputElement | null>(null);

  const selectedCode = useSelectedCode();
  const filters = useMemo(() => fromSearchParams(searchParams), [searchParams]);

  const applyFilters = useCallback(
    (next: UsdFilters, options: { replace?: boolean } = {}) => {
      setSearchParams(toSearchParams(next), { replace: options.replace ?? false });
    },
    [setSearchParams],
  );

  const datasetQuery = useQuery({
    queryKey: ['usd', 'dataset'],
    queryFn: () => api.getUsdDataset(),
    staleTime: 10 * 60_000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.refreshUsd(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['usd'] }),
  });

  // 「/」聚焦搜索框
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const funds = datasetQuery.data?.funds ?? [];
  const visible = useMemo(() => refine(funds, filters), [funds, filters]);
  const regionCounts = useMemo(() => facetCounts(funds, filters, 'region'), [funds, filters]);
  const themeCounts = useMemo(() => facetCounts(funds, filters, 'theme'), [funds, filters]);
  const selectedRecord = useMemo(
    () => funds.find((fund) => fund.code === selectedCode) ?? null,
    [funds, selectedCode],
  );

  const openDrawer = useCallback(
    (code: string) =>
      navigate({
        pathname: `/tools/usd/${encodeURIComponent(code)}`,
        search: searchParams.toString(),
      }),
    [navigate, searchParams],
  );

  const closeDrawer = useCallback(
    () => navigate({ pathname: '/tools/usd', search: searchParams.toString() }),
    [navigate, searchParams],
  );

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">美元份额</h1>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            我想用美元买基金，全市场有哪些美元份额、现在还能不能买？
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FreshnessBadge freshness={datasetQuery.data?.freshness} />
          <button
            type="button"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            className="rounded-md border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {refreshMutation.isPending ? '拉取中…' : '重新抓取上游'}
          </button>
        </div>
      </header>

      <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300">
        美元份额（现汇 / 现钞）通常不在天天基金渠道销售。此处「可买」以申购状态为准；
        日限额列显示的「渠道不适用」表示该渠道不售、并非没有限额，实际以银行 / 基金公司直销为准。
      </p>

      {refreshMutation.data ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          {refreshMutation.data.message}
        </p>
      ) : null}
      {refreshMutation.isError ? (
        <ErrorState message="重新抓取失败" detail={apiErrorDetail(refreshMutation.error)} />
      ) : null}

      {datasetQuery.isPending ? <Spinner label="加载美元份额数据集…" /> : null}
      {datasetQuery.isError ? (
        <ErrorState
          message="数据集加载失败（上游可能临时不可用，可点右上角「重新抓取上游」重试）"
          detail={apiErrorDetail(datasetQuery.error)}
        />
      ) : null}

      {datasetQuery.data ? (
        <>
          <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <FilterRow label="申购状态">
              {STATUS_FILTERS.map((item) => (
                <Chip
                  key={item.value}
                  active={filters.status === item.value}
                  onClick={() => applyFilters({ ...filters, status: item.value })}
                >
                  {item.label}
                </Chip>
              ))}
            </FilterRow>

            <FilterRow label="份额形式">
              {USD_KIND_FILTERS.map((item) => (
                <Chip
                  key={item.value}
                  active={filters.usdKinds.includes(item.value)}
                  onClick={() =>
                    applyFilters({
                      ...filters,
                      usdKinds: toggleValue(filters.usdKinds, item.value),
                    })
                  }
                >
                  {item.label}
                </Chip>
              ))}
            </FilterRow>

            <FilterRow label="地区/市场">
              {datasetQuery.data.categories.regions.map((item) => (
                <Chip
                  key={item.name}
                  active={filters.regions.includes(item.name)}
                  onClick={() =>
                    applyFilters({ ...filters, regions: toggleValue(filters.regions, item.name) })
                  }
                >
                  {item.name}
                  <span className="ml-1 text-xs opacity-70">
                    {regionCounts.get(item.name) ?? 0}
                  </span>
                </Chip>
              ))}
            </FilterRow>

            <FilterRow label="主题">
              {datasetQuery.data.categories.themes.map((item) => (
                <Chip
                  key={item.name}
                  active={filters.themes.includes(item.name)}
                  onClick={() =>
                    applyFilters({ ...filters, themes: toggleValue(filters.themes, item.name) })
                  }
                >
                  {item.name}
                  <span className="ml-1 text-xs opacity-70">{themeCounts.get(item.name) ?? 0}</span>
                </Chip>
              ))}
            </FilterRow>

            <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
              <input
                ref={searchRef}
                value={filters.keyword}
                onChange={(event) =>
                  applyFilters({ ...filters, keyword: event.target.value }, { replace: true })
                }
                placeholder="搜索基金代码或名称（按 / 聚焦）"
                className="min-w-64 flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-950"
              />
              <label className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                排序
                <select
                  value={filters.sort}
                  onChange={(event) =>
                    applyFilters({ ...filters, sort: event.target.value as UsdFilters['sort'] })
                  }
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {SORT_LABELS[option.value]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => applyFilters({ ...DEFAULT_FILTERS })}
                className="rounded-md border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                清空筛选
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <span>
                共{' '}
                <strong className="tabular text-slate-800 dark:text-slate-100">
                  {visible.length}
                </strong>{' '}
                只 （全市场美元份额 {funds.length} 只）
              </span>
              <span>可买 {datasetQuery.data.stats.buyable} 只</span>
              <span>
                {USD_KIND_FILTERS.map(
                  (item) => `${item.label} ${datasetQuery.data?.stats.usdKind[item.value] ?? 0}`,
                ).join(' · ')}
              </span>
            </div>
          </section>

          {visible.length === 0 ? (
            <EmptyState
              message="没有符合条件的美元份额。"
              action={
                <button
                  type="button"
                  onClick={() => applyFilters({ ...DEFAULT_FILTERS })}
                  className="rounded-md bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500"
                >
                  清空筛选
                </button>
              }
            />
          ) : (
            <FundTable funds={visible} selectedCode={selectedCode} onSelect={openDrawer} />
          )}
        </>
      ) : null}

      {selectedRecord ? <FundDrawer record={selectedRecord} onClose={closeDrawer} /> : null}
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-2">
      <span className="w-20 shrink-0 pt-1 text-xs text-slate-500 dark:text-slate-400">{label}</span>
      <div className="flex flex-1 flex-wrap gap-1.5">{children}</div>
    </div>
  );
}
