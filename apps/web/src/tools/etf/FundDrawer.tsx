import type { EtfFundDetailResponse, EtfRecord } from '@funds-helper/shared';
import { useQuery } from '@tanstack/react-query';
import { Drawer } from '../../components/Drawer.tsx';
import { FundDetailSections, InfoRow, Section } from '../../components/FundDetailSections.tsx';
import { Badge, ErrorState } from '../../components/ui.tsx';
import { api, apiErrorDetail } from '../../lib/api.ts';
import { formatNumber, formatPercent, formatYuan, trendClass } from '../../lib/format.ts';

/**
 * ETF 详情抽屉。
 *
 * 与 QDII / 美元份额相同的结构：**本工具特有区块**（折溢价 + ETF 基础信息）在前，
 * 通用区块（净值走势 / 收益 / 规模 / 配置 / 持仓 / 公告）在后。
 */
export function FundDrawer({ record, onClose }: { record: EtfRecord; onClose: () => void }) {
  const detailQuery = useQuery({
    queryKey: ['etf', 'fund', record.code],
    queryFn: () => api.getEtfFund(record.code),
    staleTime: 10 * 60_000,
  });
  const detail: EtfFundDetailResponse | undefined = detailQuery.data;
  const profile = detail?.profile ?? null;

  const premiumTone =
    record.premiumLevel === '高溢价'
      ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300'
      : record.premiumLevel === '平价' || record.premiumLevel === '未知'
        ? 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
        : 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300';

  return (
    <Drawer
      open
      onClose={onClose}
      title={`${record.code} ${record.name}`}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{record.category}</Badge>
          <Badge tone="neutral">{record.market}</Badge>
          {record.indexName ? <span>跟踪 {record.indexName}</span> : <span>无跟踪指数</span>}
          {record.listingDate ? <span>上市 {record.listingDate}</span> : null}
          {record.categorySource === 'name' ? (
            <span className="text-amber-600 dark:text-amber-400">（分类为名称推断）</span>
          ) : null}
        </span>
      }
    >
      <div className="space-y-6">
        {/* 1) 折溢价置顶：这是 ETF 决策里最容易踩的坑 */}
        <Section title="折溢价">
          <div className={`rounded-md border px-3 py-2 text-sm ${premiumTone}`}>
            <p className="font-medium">
              {record.premiumText}
              {record.premiumRate === null ? '（该标的当前无折溢价数据，可能停牌）' : ''}
            </p>
            <p className="mt-1 text-xs">
              {record.premiumNote ??
                '折溢价率 = (净值 − 价格) / 净值。正数表示场内价高于净值（买入即多付），负数表示便宜。'}
            </p>
          </div>
          <div className="mt-2">
            <InfoRow
              label="最新价"
              value={<span className="tabular">{formatNumber(record.price, 3)}</span>}
            />
            <InfoRow
              label="涨跌幅"
              value={
                <span className={`tabular ${trendClass(record.changePct)}`}>
                  {formatPercent(record.changePct)}
                </span>
              }
            />
            <InfoRow
              label="成交额 / 换手"
              value={
                <span className="tabular">
                  {formatYuan(record.amount)} / {formatPercent(record.turnover)}
                </span>
              }
            />
            <InfoRow
              label="振幅 / 量比"
              value={
                <span className="tabular">
                  {formatPercent(record.amplitude)} / {formatNumber(record.volumeRatio, 2)}
                </span>
              }
            />
            <InfoRow
              label="行情时间"
              value={
                <span className="text-xs text-slate-500">
                  {record.quoteAt
                    ? new Date(record.quoteAt).toLocaleString('zh-CN', { hour12: false })
                    : '--'}
                </span>
              }
            />
          </div>
        </Section>

        {detailQuery.isError ? (
          <ErrorState message="详情加载失败" detail={apiErrorDetail(detailQuery.error)} />
        ) : null}

        {/* 2) ETF 基础信息：规模 / 费率 / 管理人（接口 C） */}
        <Section title="基础信息">
          <div>
            <InfoRow label="跟踪指数" value={profile?.indexName ?? record.indexName ?? '--'} />
            <InfoRow label="基金全称" value={profile?.fullName ?? '--'} />
            <InfoRow
              label="场内规模"
              value={
                <span className="tabular">
                  {formatYuan(record.scale)}
                  {record.shares ? `（${formatYuan(record.shares)}份）` : ''}
                </span>
              }
            />
            <InfoRow
              label="净资产规模"
              value={
                <span className="tabular">
                  {formatYuan(profile?.netAssets ?? null)}
                  {profile?.netAssetsDate ? `（${profile.netAssetsDate}）` : ''}
                </span>
              }
            />
            <InfoRow
              label="管理费 / 托管费"
              value={
                <span className="tabular">
                  {profile?.managementFee ?? '--'} / {profile?.custodyFee ?? '--'}
                  {profile?.salesServiceFee ? ` / 销售服务费 ${profile.salesServiceFee}` : ''}
                </span>
              }
            />
            <InfoRow label="基金管理人" value={profile?.company ?? detail?.base?.company ?? '--'} />
            <InfoRow label="基金托管人" value={profile?.custodian ?? '--'} />
            <InfoRow label="基金经理" value={profile?.manager ?? detail?.base?.manager ?? '--'} />
            <InfoRow label="成立日期" value={profile?.establishedDate ?? '--'} />
            <InfoRow label="业绩比较基准" value={profile?.benchmark ?? '--'} />
            <InfoRow
              label="风险等级"
              value={profile?.riskLevel ?? detail?.base?.riskLevel ?? '--'}
            />
          </div>
          <p className="mt-2 text-xs text-slate-400">
            规模为场内市值估算（价格 × 份额）；净资产规模来自基金定期报告，两者口径不同。
          </p>
        </Section>

        {/* 3) 区间表现（接口 B） */}
        <Section title="区间表现">
          <div>
            <InfoRow
              label="近 1 周"
              value={
                <span className={`tabular ${trendClass(record.change1w)}`}>
                  {formatPercent(record.change1w)}
                </span>
              }
            />
            <InfoRow
              label="近 1 月"
              value={
                <span className={`tabular ${trendClass(record.change1m)}`}>
                  {formatPercent(record.change1m)}
                </span>
              }
            />
            <InfoRow
              label="近 3 月"
              value={
                <span className={`tabular ${trendClass(record.change3m)}`}>
                  {formatPercent(record.change3m)}
                </span>
              }
            />
            <InfoRow
              label="今年以来"
              value={
                <span className={`tabular ${trendClass(record.ytdChange)}`}>
                  {formatPercent(record.ytdChange)}
                </span>
              }
            />
            <InfoRow
              label="近一年最大回撤"
              value={
                <span className="tabular text-emerald-600 dark:text-emerald-400">
                  {formatPercent(record.maxDrawdown1y)}
                </span>
              }
            />
          </div>
          <p className="mt-2 text-xs text-slate-400">
            数据日期 {record.dataDate ?? '未知'}；次新 ETF 的部分区间为空属正常。
          </p>
        </Section>

        {/* 4+) 通用详情区块：净值走势 / 收益 / 规模 / 配置 / 持仓 / 公告 */}
        <FundDetailSections detail={detail} />

        <p className="pb-2 text-xs text-slate-400">{detail?.disclaimer ?? ''}</p>
      </div>
    </Drawer>
  );
}
