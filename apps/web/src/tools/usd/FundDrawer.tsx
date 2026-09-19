import type { UsdFundDetailResponse, UsdFundRecord } from '@funds-helper/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Drawer } from '../../components/Drawer.tsx';
import { FundDetailSections, InfoRow, Section } from '../../components/FundDetailSections.tsx';
import { Badge, ErrorState } from '../../components/ui.tsx';
import { api, apiErrorDetail } from '../../lib/api.ts';
import { formatNumber } from '../../lib/format.ts';

export function FundDrawer({
  record,
  onClose,
}: {
  /** 来自数据集的记录，保证抽屉与列表口径一致；打开时再拉详情 */
  record: UsdFundRecord;
  onClose: () => void;
}) {
  const detailQuery = useQuery({
    queryKey: ['usd', 'fund', record.code],
    queryFn: () => api.getUsdFund(record.code),
    staleTime: 10 * 60_000,
  });

  const detail: UsdFundDetailResponse | undefined = detailQuery.data;

  return (
    <Drawer
      open
      onClose={onClose}
      title={record.name}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <span className="tabular">{record.code}</span>
          <span>{record.fundType}</span>
          <Badge tone={record.usdKind === '现汇' ? 'info' : 'neutral'}>{record.usdKind}</Badge>
          <Badge tone={record.buyable ? 'warn' : 'neutral'}>
            {record.status === '' ? '数据缺失' : record.status}
          </Badge>
        </span>
      }
    >
      <div className="space-y-6">
        {/* 1) 渠道与可买提示置顶 */}
        <Section title="购买提示">
          <div
            className={
              'rounded-md border px-3 py-2 text-sm ' +
              (record.buyable
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300')
            }
          >
            <p className="font-medium">
              {record.buyable
                ? `当前状态「${record.status}」，按申购状态判断可买`
                : `当前状态「${record.status}」，暂不可买`}
            </p>
            <p className="mt-1 text-xs">
              美元份额通常不在天天基金渠道销售，此处申购状态来自基金公司口径；
              {record.dailyLimitNote ? ` ${record.dailyLimitNote}` : ''}
            </p>
          </div>
        </Section>

        {detailQuery.isError ? (
          <ErrorState message="详情加载失败" detail={apiErrorDetail(detailQuery.error)} />
        ) : null}

        {/* 2) 当前额度 */}
        <Section title="当前额度">
          <div>
            <InfoRow
              label="日累计限额"
              value={
                <span
                  className="tabular"
                  {...(record.dailyLimitNote ? { title: record.dailyLimitNote } : {})}
                >
                  {record.limitText}
                </span>
              }
            />
            <InfoRow
              label="申购起点"
              value={<span className="tabular">{record.minPurchaseText}</span>}
            />
            <InfoRow label="赎回状态" value={record.redeemStatus || '--'} />
            <InfoRow label="下一开放日" value={record.nextOpenDate ?? '--'} />
            <InfoRow
              label="单位净值"
              value={`${formatNumber(record.nav)}（${record.navDate ?? '--'}）`}
            />
            <InfoRow label="费率" value={record.fee || '--'} />
            {detail?.base?.company ? (
              <InfoRow label="基金公司" value={detail.base.company} />
            ) : null}
            {detail?.base?.manager ? (
              <InfoRow label="基金经理" value={detail.base.manager} />
            ) : null}
            {detail?.base?.rate ? (
              <InfoRow
                label="费率（实时）"
                value={`${detail.base.sourceRate ?? '--'} → ${detail.base.rate}`}
              />
            ) : null}
            <InfoRow
              label="额度采集于"
              value={<span className="text-xs text-slate-500">{record.capturedAt}</span>}
            />
          </div>
        </Section>

        {/* 3) 同基金人民币份额对照 */}
        {detail && detail.cnySiblings.length > 0 ? (
          <Section title="同基金人民币份额（成本对照）">
            <ul className="space-y-1.5">
              {detail.cnySiblings.map((item) => (
                <li
                  key={item.code}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
                >
                  <span className="tabular text-slate-500 dark:text-slate-400">{item.code}</span>
                  <Link
                    to={`/tools/qdii/${encodeURIComponent(item.code)}`}
                    className="min-w-0 flex-1 truncate text-sky-600 hover:underline dark:text-sky-400"
                  >
                    {item.name}
                  </Link>
                  <Badge tone="neutral">{item.status || '未知'}</Badge>
                  <span className="tabular">
                    {item.dailyLimit === null ? '无限额' : `${item.dailyLimit} 元`}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-slate-400">
              人民币份额按元申购、美元份额按美元申购，两者净值口径不同，不宜直接比较净值高低。
            </p>
          </Section>
        ) : null}

        {/* 4+) 通用详情区块：净值 / 收益 / 规模 / 配置 / 持仓 / 公告 */}
        <FundDetailSections detail={detail} />

        <p className="pb-2 text-xs text-slate-400">{detail?.disclaimer ?? ''}</p>
      </div>
    </Drawer>
  );
}
