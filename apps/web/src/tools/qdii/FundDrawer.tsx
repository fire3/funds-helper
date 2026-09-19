import type { FundRecord, QdiiFundDetailResponse } from '@funds-helper/shared';
import { useQuery } from '@tanstack/react-query';
import { Drawer } from '../../components/Drawer.tsx';
import { FundDetailSections, InfoRow, Section } from '../../components/FundDetailSections.tsx';
import { Badge, ErrorState, type Tone } from '../../components/ui.tsx';
import { api, apiErrorDetail } from '../../lib/api.ts';
import { formatNumber } from '../../lib/format.ts';

const ADVICE_TONE: Record<string, Tone> = { info: 'info', warn: 'warn', good: 'good' };

export function FundDrawer({
  record,
  onClose,
}: {
  /** 来自数据集的记录，保证抽屉与列表口径一致；打开时再拉详情 */
  record: FundRecord;
  onClose: () => void;
}) {
  const detailQuery = useQuery({
    queryKey: ['qdii', 'fund', record.code],
    queryFn: () => api.getQdiiFund(record.code),
    staleTime: 10 * 60_000,
  });

  const detail: QdiiFundDetailResponse | undefined = detailQuery.data;

  return (
    <Drawer
      open
      onClose={onClose}
      title={record.name}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <span className="tabular">{record.code}</span>
          <span>{record.fundType}</span>
          <Badge tone={record.buyable ? 'warn' : 'neutral'}>
            {record.status === '' ? '数据缺失' : record.status}
          </Badge>
          <span>{record.currency}</span>
        </span>
      }
    >
      <div className="space-y-6">
        {/* 1) 购买建议置顶 */}
        <Section title="购买建议">
          {detailQuery.isPending ? (
            <p className="text-sm text-slate-400">加载中…</p>
          ) : detail && detail.advice.length > 0 ? (
            <ul className="space-y-2">
              {detail.advice.map((item) => (
                <li
                  key={item.title}
                  className="rounded-md border border-slate-200 px-3 py-2 dark:border-slate-800"
                >
                  <div className="flex items-center gap-2">
                    <Badge tone={ADVICE_TONE[item.tone] ?? 'neutral'}>{item.title}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{item.text}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-400">暂无建议</p>
          )}
        </Section>

        {detailQuery.isError ? (
          <ErrorState message="详情加载失败" detail={apiErrorDetail(detailQuery.error)} />
        ) : null}

        {/* 2) 当前额度 */}
        <Section title="当前额度">
          <div>
            <InfoRow
              label="日累计限额"
              value={<span className="tabular">{record.limitText}</span>}
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

        {/* 3) 同基金其它份额类别 */}
        {detail && detail.shareClasses.length > 0 ? (
          <Section title="同基金其它份额类别">
            <ul className="space-y-1.5">
              {detail.shareClasses.map((item) => (
                <li
                  key={item.code}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
                >
                  <span className="tabular text-slate-500 dark:text-slate-400">{item.code}</span>
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <Badge tone="neutral">{item.status || '未知'}</Badge>
                  <span className="tabular">
                    {item.dailyLimit === null ? '无限额' : `${item.dailyLimit} 元`}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {/* 4+) 通用详情区块：净值 / 收益 / 规模 / 配置 / 持仓 / 公告 */}
        <FundDetailSections detail={detail} />

        <p className="pb-2 text-xs text-slate-400">{detail?.disclaimer ?? ''}</p>
      </div>
    </Drawer>
  );
}
