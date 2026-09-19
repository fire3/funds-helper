import { SORT_LABELS } from '@funds-helper/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Chart } from '../../components/Chart.tsx';
import { FreshnessBadge } from '../../components/FreshnessBadge.tsx';
import { Chip, EmptyState, ErrorState, Spinner } from '../../components/ui.tsx';
import { api, apiErrorDetail } from '../../lib/api.ts';
import { FundDrawer } from './FundDrawer.tsx';
import { FundTable } from './FundTable.tsx';
import {
  CURRENCY_FILTERS,
  DEFAULT_FILTERS,
  facetCounts,
  fromSearchParams,
  LIMIT_BANDS,
  type QdiiFilters,
  refine,
  SORT_OPTIONS,
  STATUS_FILTERS,
  toggleValue,
  toSearchParams,
} from './filters.ts';
import { ChangesPanel, fundNameLookup, PremiumPanel } from './panels.tsx';

const TABS = [
  { value: 'list', label: '额度列表' },
  { value: 'premium', label: '场内溢价' },
  { value: 'changes', label: '额度变更' },
] as const;

type TabValue = (typeof TABS)[number]['value'];

/** 详情抽屉的 URL 就是列表 URL 的子路径，`/tools/qdii/*` 单路由因此不会重挂载 */
function useSelectedCode(): string | null {
  const { pathname } = useLocation();
  return useMemo(() => {
    const rest = pathname.replace(/^\/tools\/qdii\/?/, '');
    if (rest === '') return null;
    return decodeURIComponent(rest.split('/')[0] ?? '');
  }, [pathname]);
}

export default function QdiiPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const searchRef = useRef<HTMLInputElement | null>(null);

  const selectedCode = useSelectedCode();
  const tab = (searchParams.get('tab') ?? 'list') as TabValue;
  const filters = useMemo(() => fromSearchParams(searchParams), [searchParams]);

  const applyFilters = useCallback(
    (next: QdiiFilters, options: { replace?: boolean } = {}) => {
      const params = toSearchParams(next);
      if (tab !== 'list') params.set('tab', tab);
      setSearchParams(params, { replace: options.replace ?? false });
    },
    [setSearchParams, tab],
  );

  const datasetQuery = useQuery({
    queryKey: ['qdii', 'dataset'],
    queryFn: () => api.getQdiiDataset(),
    staleTime: 10 * 60_000,
  });

  const premiumQuery = useQuery({
    queryKey: ['qdii', 'premium'],
    queryFn: () => api.getQdiiPremium(),
    enabled: tab === 'premium',
    staleTime: 10 * 60_000,
  });

  const changesQuery = useQuery({
    queryKey: ['qdii', 'changes'],
    queryFn: () => api.getQdiiChanges(30),
    enabled: tab === 'changes',
    staleTime: 10 * 60_000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.refreshQdii(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['qdii'] }),
  });

  // 「/」聚焦搜索框（沿用 qdii-helper 的既有习惯）
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

  const limitScan = useMemo(() => {
    const limited = funds.filter(
      (fund) => fund.currency === 'CNY' && fund.status === '限大额' && fund.dailyLimit !== null,
    );
    const buckets = [
      { label: '≤10 元', max: 10 },
      { label: '≤100 元', max: 100 },
      { label: '≤1000 元', max: 1000 },
      { label: '≤1 万', max: 10_000 },
      { label: '≤100 万', max: 1_000_000 },
      { label: '>100 万', max: Number.POSITIVE_INFINITY },
    ];
    return {
      categories: buckets.map((bucket) => bucket.label),
      data: buckets.map(
        (bucket) =>
          limited.filter((fund) => {
            const value = fund.dailyLimit ?? 0;
            const lower = buckets[buckets.indexOf(bucket) - 1]?.max ?? 0;
            return value > lower && value <= bucket.max;
          }).length,
      ),
    };
  }, [funds]);

  // 抽屉与列表共用查询串：开关抽屉都带上当前筛选，避免返回后筛选被重置/列表重排
  const openDrawer = useCallback(
    (code: string) =>
      navigate({
        pathname: `/tools/qdii/${encodeURIComponent(code)}`,
        search: searchParams.toString(),
      }),
    [navigate, searchParams],
  );

  const closeDrawer = useCallback(
    () => navigate({ pathname: '/tools/qdii', search: searchParams.toString() }),
    [navigate, searchParams],
  );

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">QDII 额度</h1>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            我想买的这只 QDII，今天还能买多少？
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

      {refreshMutation.data ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          {refreshMutation.data.message}
        </p>
      ) : null}
      {refreshMutation.isError ? (
        <ErrorState message="重新抓取失败" detail={apiErrorDetail(refreshMutation.error)} />
      ) : null}

      <nav className="flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => {
              const params = toSearchParams(filters);
              if (item.value !== 'list') params.set('tab', item.value);
              setSearchParams(params);
            }}
            className={
              'border-b-2 px-3 py-2 text-sm ' +
              (tab === item.value
                ? 'border-sky-600 font-medium text-sky-700 dark:text-sky-400'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')
            }
          >
            {item.label}
          </button>
        ))}
      </nav>

      {datasetQuery.isPending ? <Spinner label="加载 QDII 数据集…" /> : null}
      {datasetQuery.isError ? (
        <ErrorState
          message="数据集加载失败（上游可能临时不可用，可点右上角「重新抓取上游」重试）"
          detail={apiErrorDetail(datasetQuery.error)}
        />
      ) : null}

      {datasetQuery.data && tab === 'list' ? (
        <>
          <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
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

            <FilterRow label="日限额">
              {LIMIT_BANDS.map((item) => (
                <Chip
                  key={item.value}
                  active={filters.band === item.value}
                  onClick={() => applyFilters({ ...filters, band: item.value })}
                >
                  {item.label}
                </Chip>
              ))}
            </FilterRow>

            <FilterRow label="份额币种">
              {CURRENCY_FILTERS.map((item) => (
                <Chip
                  key={item.value}
                  active={filters.currency === item.value}
                  onClick={() => applyFilters({ ...filters, currency: item.value })}
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
                placeholder="搜索基金代码或名称（按 / 聚焦）"
                className="min-w-64 flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-950"
              />
              <label className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                排序
                <select
                  value={filters.sort}
                  onChange={(event) =>
                    applyFilters({ ...filters, sort: event.target.value as QdiiFilters['sort'] })
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
                只 （匹配 {funds.length} 只 QDII）
              </span>
              {datasetQuery.data.stats.tightest !== null ? (
                <span>
                  最紧限额{' '}
                  <strong className="tabular">{datasetQuery.data.stats.tightest} 元</strong>
                </span>
              ) : null}
              <span>可买 {datasetQuery.data.stats.buyable} 只</span>
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="mb-2 text-sm font-semibold">限大额档位分布（人民币份额）</h2>
            <Chart
              categories={limitScan.categories}
              series={[{ name: '基金数', type: 'bar', data: limitScan.data }]}
              height={180}
            />
          </section>

          {visible.length === 0 ? (
            <EmptyState
              message="没有符合条件的基金。"
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

      {tab === 'premium' ? (
        <PremiumPanel
          data={premiumQuery.data}
          isPending={premiumQuery.isPending}
          error={premiumQuery.error}
        />
      ) : null}

      {tab === 'changes' && datasetQuery.data ? (
        <ChangesPanel
          items={changesQuery.data?.items ?? []}
          isPending={changesQuery.isPending}
          error={changesQuery.error}
          nameOf={fundNameLookup(datasetQuery.data.funds)}
        />
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
