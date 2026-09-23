import {
  ETF_SPOT_SOURCE_ORDER,
  ETF_SPOT_SOURCES,
  type EtfSpotSourceId,
} from '@funds-helper/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  FEEDER_FILTERS,
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
import { HotspotPanel } from './HotspotPanel.tsx';
import { EtfSummaryPanel } from './panels.tsx';

const TABS = [
  { value: 'list', label: 'ETF 列表' },
  { value: 'hotspot', label: '热点研究' },
] as const;

type TabValue = (typeof TABS)[number]['value'];

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
  const tab = ((searchParams.get('tab') ?? 'list') as TabValue) === 'hotspot' ? 'hotspot' : 'list';
  const filters = useMemo(() => fromSearchParams(searchParams), [searchParams]);

  // 搜索框与地址栏解耦：输入过程只改本地 `draft`，按回车才写 URL 并触发筛选。
  // 实时写 URL 会让中文输入法组词中途就刷新受控值，React 把拼音提前「提交」，
  // 表现为中文输不进去（组词被打断，框里只剩字母）。
  const [draft, setDraft] = useState(filters.keyword);
  const composingRef = useRef(false);
  useEffect(() => {
    setDraft(filters.keyword);
  }, [filters.keyword]);

  const applyFilters = useCallback(
    (next: EtfFilters, options: { replace?: boolean } = {}) => {
      const params = toSearchParams(next);
      // 列表 tab 的筛选变化不携带热点视图的参数（mode/w 等），但 tab 本身要保住
      if (tab !== 'list') params.set('tab', tab);
      setSearchParams(params, { replace: options.replace ?? false });
    },
    [setSearchParams, tab],
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

  // 行情渠道偏好：存在服务端（跟着数据库走），因此换设备/重启后仍然生效
  const configQuery = useQuery({
    queryKey: ['etf', 'config'],
    queryFn: () => api.getEtfConfig(),
    staleTime: 5 * 60_000,
  });
  // 配置还没回来时先用 shared 的渠道目录渲染下拉框（避免出现空白选项）
  const sourceOptions =
    configQuery.data?.sources ?? ETF_SPOT_SOURCE_ORDER.map((id) => ETF_SPOT_SOURCES[id]);

  const switchSourceMutation = useMutation({
    mutationFn: (spotSource: EtfSpotSourceId) => api.updateEtfConfig(spotSource),
    // 切换后服务端已经重抓过，这里只要让数据集/配置重新拉一次
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['etf'] }),
  });

  // 场外联接基金的反查是**独立慢链路**：默认增量（几十个请求），
  // 只有从没查过时才需要全量重建（约 2300 个请求 / 4 分钟）
  const feederScanned = datasetQuery.data?.feeder.updatedAt ?? null;
  const feederMutation = useMutation({
    mutationFn: () => api.refreshEtfFeeders(feederScanned === null),
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
  // 偏好渠道与实际渠道不一致 = 本次发生了降级（界面要显式说明，否则「切了东财却还有缺口」会很迷惑）
  const degraded =
    configQuery.data !== undefined &&
    datasetQuery.data !== undefined &&
    configQuery.data.spotSource !== datasetQuery.data.dataSource.id;
  // 渠道能力：新浪列表没有 IOPV，折溢价相关的 UI 整体隐藏（见 dataSource.missing）
  const premiumAvailable = !(datasetQuery.data?.dataSource.missing ?? []).includes('折溢价率');
  // 折溢价不可用时忽略 URL 里的折溢价条件：否则一个带 ?premium=premium 的旧链接会筛出空列表
  const effectiveFilters = useMemo(
    () => (premiumAvailable ? filters : { ...filters, premiums: [] }),
    [filters, premiumAvailable],
  );
  const visible = useMemo(() => refine(funds, effectiveFilters), [funds, effectiveFilters]);
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
          <label className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
            行情渠道
            <select
              value={configQuery.data?.spotSource ?? sourceOptions[0]?.id}
              disabled={configQuery.isPending || switchSourceMutation.isPending}
              onChange={(event) =>
                switchSourceMutation.mutate(event.target.value as EtfSpotSourceId)
              }
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950"
            >
              {sourceOptions.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                  {source.missing.length === 0 ? '（含折溢价）' : '（无折溢价）'}
                </option>
              ))}
            </select>
          </label>
          {switchSourceMutation.isPending ? (
            <span className="text-xs text-slate-400 dark:text-slate-500">切换并重新抓取中…</span>
          ) : null}
          {degraded ? (
            <span
              className="text-xs text-amber-600 dark:text-amber-400"
              title="偏好渠道本次不可用，已自动降级"
            >
              实际：{datasetQuery.data?.dataSource.name}
            </span>
          ) : null}
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

      <nav className="flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => {
              // 保留当前全部查询参数（列表筛选、热点窗口等），只切换 tab
              const params = new URLSearchParams(searchParams);
              if (item.value === 'list') params.delete('tab');
              else params.set('tab', item.value);
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

      {premiumAvailable ? null : (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300">
          行情渠道：<strong>{datasetQuery.data?.dataSource.name ?? '—'}</strong>
          ，该渠道不含{datasetQuery.data?.dataSource.missing.join('、')}
          —— 折溢价与上市日期相关的列、分布、榜单与筛选已隐藏。
        </p>
      )}

      {refreshMutation.data ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          {refreshMutation.data.message}
        </p>
      ) : null}
      {refreshMutation.isError ? (
        <ErrorState message="重新抓取失败" detail={apiErrorDetail(refreshMutation.error)} />
      ) : null}
      {switchSourceMutation.data ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          已切换行情渠道 —— {switchSourceMutation.data.refresh.message}
        </p>
      ) : null}
      {switchSourceMutation.isError ? (
        <ErrorState
          message="切换行情渠道失败（渠道偏好已保存，可再点「重新抓取上游」重试）"
          detail={apiErrorDetail(switchSourceMutation.error)}
        />
      ) : null}
      {feederMutation.isPending ? (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300">
          正在反查场外联接基金：每只联接基金一个上游请求，首次全量约 2300 个请求 / 4 分钟
          （之后是增量补查，几秒钟）。期间可以正常浏览其它内容。
        </p>
      ) : null}
      {feederMutation.data ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          {feederMutation.data.message}（用时 {(feederMutation.data.durationMs / 1000).toFixed(1)}{' '}
          秒）
        </p>
      ) : null}
      {feederMutation.isError ? (
        <ErrorState message="反查场外联接基金失败" detail={apiErrorDetail(feederMutation.error)} />
      ) : null}

      {datasetQuery.isPending ? <Spinner label="加载全市场 ETF 数据集…" /> : null}
      {datasetQuery.isError ? (
        <ErrorState
          message="数据集加载失败（上游可能临时不可用，可点右上角「重新抓取上游」重试）"
          detail={apiErrorDetail(datasetQuery.error)}
        />
      ) : null}

      {datasetQuery.data && tab === 'hotspot' ? (
        <HotspotPanel
          records={funds}
          periodReturns={datasetQuery.data.periodReturns}
          onSelect={openDrawer}
        />
      ) : null}

      {datasetQuery.data && tab === 'list' ? (
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

            <FilterRow label="折溢价" hidden={!premiumAvailable}>
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

            <FilterRow label="场外">
              {FEEDER_FILTERS.map((item) => (
                <Chip
                  key={item.value}
                  active={filters.feeder === item.value}
                  onClick={() => applyFilters({ ...filters, feeder: item.value })}
                >
                  {item.label}
                </Chip>
              ))}
            </FilterRow>

            <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
              <input
                ref={searchRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                onKeyDown={(event) => {
                  // 中文输入法里回车是「选词」，不能当成确认搜索（此刻组词还没结束）
                  if (
                    event.key === 'Enter' &&
                    !composingRef.current &&
                    !event.nativeEvent.isComposing
                  ) {
                    applyFilters({ ...filters, keyword: draft }, { replace: true });
                  }
                }}
                placeholder="搜索代码 / 名称 / 跟踪指数（回车搜索，按 / 聚焦）"
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
              <span className="flex flex-wrap items-center gap-2">
                <span title="场外联接基金由接口 I 反查得到（独立于行情快照），覆盖不到的是本来就没有联接基金的品种">
                  场外联接：{datasetQuery.data.feeder.etfCount} 只 ETF /{' '}
                  {datasetQuery.data.feeder.fundCount} 只联接基金
                  {feederScanned === null
                    ? '（尚未反查）'
                    : `（更新于 ${feederScanned.slice(0, 10)}）`}
                </span>
                <button
                  type="button"
                  onClick={() => feederMutation.mutate()}
                  disabled={feederMutation.isPending}
                  className="rounded-md border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  {feederMutation.isPending
                    ? '反查中…'
                    : feederScanned === null
                      ? '反查场外联接基金'
                      : '补查新增'}
                </button>
              </span>
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

function FilterRow({
  label,
  children,
  hidden = false,
}: {
  label: string;
  children: React.ReactNode;
  /** 渠道不提供该维度时整行不渲染（而不是渲染一组永远筛不出结果的按钮） */
  hidden?: boolean;
}) {
  if (hidden) return null;
  return (
    <div className="flex flex-wrap items-start gap-2">
      <span className="w-20 shrink-0 pt-1 text-xs text-slate-500 dark:text-slate-400">{label}</span>
      <div className="flex flex-1 flex-wrap gap-1.5">{children}</div>
    </div>
  );
}
