import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { FreshnessBadge } from '../../components/FreshnessBadge.tsx';
import { Chip, EmptyState, ErrorState, Spinner } from '../../components/ui.tsx';
import { api, apiErrorDetail } from '../../lib/api.ts';
import { formatYuan } from '../../lib/format.ts';
import { FundDrawer } from './FundDrawer.tsx';
import { FundTable } from './FundTable.tsx';
import {
  AMOUNT_FILTERS,
  CATEGORY_FILTERS,
  DEFAULT_FILTERS,
  type EtfFilters,
  facetCounts,
  fromSearchParams,
  MARKET_FILTERS,
  PREMIUM_FILTERS,
  refine,
  SCALE_FILTERS,
  SORT_OPTIONS,
  toggleValue,
  toSearchParams,
} from './filters.ts';
import { EtfSummaryPanel } from './panels.tsx';

/** 详情抽屉的 URL 就是列表 URL 的子路径，`/tools/etf/*` 单路由因此不会重挂载 */
function useSelectedCode(): string | null {
  const { pathname } = useLocation();
  return useMemo(() => {
    const rest = pathname.replace(/^\/tools\/etf\/?/, '');
    if (rest === '') return null;
    return decodeURIComponent(rest.split('/')[0] ?? '');
  }, [pathname]);
}

export default function EtfPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const searchRef = useRef<HTMLInputElement | null>(null);

  const selectedCode = useSelectedCode();
  const filters = useMemo(() => fromSearchParams(searchParams), [searchParams]);

  const applyFilters = useCallback(
    (next: EtfFilters, options: { replace?: boolean } = {}) => {
      setSearchParams(toSearchParams(next), { replace: options.replace ?? false });
    },
    [setSearchParams],
  );

  const datasetQuery = useQuery({
    queryKey: ['etf', 'dataset'],
    queryFn: () => api.getEtfDataset(),
    staleTime: 10 * 60_000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.refreshEtf(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['etf'] }),
  });

  // 「/」聚焦搜索框（与其它工具一致）
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
  const categoryCounts = useMemo(() => facetCounts(funds, filters, 'category'), [funds, filters]);
  const marketCounts = useMemo(() => facetCounts(funds, filters, 'market'), [funds, filters]);
  const selectedRecord = useMemo(
    () => funds.find((fund) => fund.code === selectedCode) ?? null,
    [funds, selectedCode],
  );

  const openDrawer = useCallback(
    (code: string) =>
      navigate({
        pathname: `/tools/etf/${encodeURIComponent(code)}`,
        search: searchParams.toString(),
      }),
    [navigate, searchParams],
  );

  const closeDrawer = useCallback(
    () => navigate({ pathname: '/tools/etf', search: searchParams.toString() }),
    [navigate, searchParams],
  );

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">ETF 汇总</h1>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            全市场 ETF 现在什么价、有多大、贵不贵（折溢价）、跟踪的是什么指数？
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
        「规模」是场内市值估算（价格 × 份额），与基金定期报告口径略有差异； 折溢价率正数表示
        <strong>场内价高于净值</strong>（此刻买入等于多付），跨境 ETF 盘中溢价常见。
        行情为延时/快照数据，仅供筛选参考。
      </p>

      {refreshMutation.data ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          {refreshMutation.data.message}
        </p>
      ) : null}
      {refreshMutation.isError ? (
        <ErrorState message="重新抓取失败" detail={apiErrorDetail(refreshMutation.error)} />
      ) : null}

      {datasetQuery.isPending ? <Spinner label="加载全市场 ETF 数据集…" /> : null}
      {datasetQuery.isError ? (
        <ErrorState
          message="数据集加载失败（上游可能临时不可用，可点右上角「重新抓取上游」重试）"
          detail={apiErrorDetail(datasetQuery.error)}
        />
      ) : null}

      {datasetQuery.data ? (
        <>
          <EtfSummaryPanel
            stats={datasetQuery.data.stats}
            records={funds}
            activeCategories={filters.categories}
            onToggleCategory={(category) =>
              applyFilters({ ...filters, categories: toggleValue(filters.categories, category) })
            }
          />

          <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <FilterRow label="分类">
              {CATEGORY_FILTERS.map((item) => (
                <Chip
                  key={item.value}
                  active={filters.categories.includes(item.value)}
                  onClick={() =>
                    applyFilters({
                      ...filters,
                      categories: toggleValue(filters.categories, item.value),
                    })
                  }
                >
                  {item.label}
                  <span className="ml-1 text-xs opacity-70">
                    {categoryCounts.get(item.value) ?? 0}
                  </span>
                </Chip>
              ))}
            </FilterRow>

            <FilterRow label="交易所">
              {MARKET_FILTERS.map((item) => (
                <Chip
                  key={item.value}
                  active={filters.markets.includes(item.value)}
                  onClick={() =>
                    applyFilters({ ...filters, markets: toggleValue(filters.markets, item.value) })
                  }
                >
                  {item.label}
                  <span className="ml-1 text-xs opacity-70">
                    {marketCounts.get(item.value) ?? 0}
                  </span>
                </Chip>
              ))}
            </FilterRow>

            <FilterRow label="折溢价">
              {PREMIUM_FILTERS.map((item) => (
                <Chip
                  key={item.value}
                  active={filters.premiums.includes(item.value)}
                  onClick={() =>
                    applyFilters({
                      ...filters,
                      premiums: toggleValue(filters.premiums, item.value),
                    })
                  }
                >
                  {item.label}
                </Chip>
              ))}
            </FilterRow>

            <FilterRow label="规模">
              {SCALE_FILTERS.map((item) => (
                <Chip
                  key={item.value}
                  active={filters.minScale === item.value}
                  onClick={() => applyFilters({ ...filters, minScale: item.value })}
                >
                  {item.label}
                </Chip>
              ))}
            </FilterRow>

            <FilterRow label="成交额">
              {AMOUNT_FILTERS.map((item) => (
                <Chip
                  key={item.value}
                  active={filters.minAmount === item.value}
                  onClick={() => applyFilters({ ...filters, minAmount: item.value })}
                >
                  {item.label}
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
                placeholder="搜索代码 / 名称 / 跟踪指数（按 / 聚焦）"
                className="min-w-64 flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-950"
              />
              <label className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                排序
                <select
                  value={filters.sort}
                  onChange={(event) =>
                    applyFilters({ ...filters, sort: event.target.value as EtfFilters['sort'] })
                  }
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
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
                筛选出{' '}
                <strong className="tabular text-slate-800 dark:text-slate-100">
                  {visible.length}
                </strong>{' '}
                只（全市场 {funds.length} 只）
              </span>
              {visible.length > 0 ? (
                <span>
                  规模合计 {formatYuan(visible.reduce((sum, fund) => sum + (fund.scale ?? 0), 0))} ·
                  成交额合计{' '}
                  {formatYuan(visible.reduce((sum, fund) => sum + (fund.amount ?? 0), 0))}
                </span>
              ) : null}
            </div>
          </section>

          {visible.length === 0 ? (
            <EmptyState
              message="没有符合条件的 ETF。"
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
