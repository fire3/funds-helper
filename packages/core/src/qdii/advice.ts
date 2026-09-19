import { type FundLimit, PurchaseStatus } from './model.ts';
import { formatAmount, isOnExchange } from './normalize.ts';
import { shareClassLetter } from './share-class.ts';

// ---------------------------------------------------------------------------
// 阶段收益的周期映射
// ---------------------------------------------------------------------------

/**
 * 上游 `title` 枚举 → 中文标签。
 * **`Y` 表示「月」、`N` 表示「年」**，不要按字面理解成 y/n。
 */
export const PERIOD_LABELS: Record<string, string> = {
  Z: '近1周',
  Y: '近1月',
  '3Y': '近3月',
  '6Y': '近6月',
  '1N': '近1年',
  '2N': '近2年',
  '3N': '近3年',
  '5N': '近5年',
  JN: '今年来',
  LN: '成立来',
};

export const PERIOD_ORDER: readonly string[] = [
  'Z',
  'Y',
  '3Y',
  '6Y',
  '1N',
  '2N',
  '3N',
  '5N',
  'JN',
  'LN',
];

export function periodLabel(key: string): string {
  return PERIOD_LABELS[key] ?? key;
}

export function periodRank(key: string): number {
  const index = PERIOD_ORDER.indexOf(key);
  return index === -1 ? PERIOD_ORDER.length : index;
}

// ---------------------------------------------------------------------------
// 净值走势的区间统计
// ---------------------------------------------------------------------------

export interface NavPointLike {
  date: string;
  nav: number;
}

export const NAV_WINDOWS = [
  { label: '近1月', days: 30 },
  { label: '近3月', days: 91 },
  { label: '近6月', days: 182 },
  { label: '近1年', days: 365 },
  { label: '近3年', days: 1095 },
] as const;

export interface NavSummaryRow {
  label: string;
  returnPct: number | null;
  maxDrawdownPct: number | null;
}

function shiftDate(date: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  const ms = Date.UTC(year, month - 1, day) - days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 计算各区间涨幅与**最大回撤**。
 *
 * 最大回撤定义：区间内任一时点相对此前最高点的最大跌幅（负数，%）。
 */
export function summarizeNav(trend: readonly NavPointLike[]): NavSummaryRow[] {
  const points = trend.filter((point) => Number.isFinite(point.nav) && point.nav > 0);
  const last = points.at(-1);

  return NAV_WINDOWS.map((window) => {
    if (!last) return { label: window.label, returnPct: null, maxDrawdownPct: null };

    const cutoff = shiftDate(last.date, window.days);
    const slice = points.filter((point) => point.date >= cutoff);
    if (slice.length < 2) return { label: window.label, returnPct: null, maxDrawdownPct: null };

    const firstPoint = slice[0];
    if (!firstPoint) return { label: window.label, returnPct: null, maxDrawdownPct: null };

    const returnPct = (last.nav / firstPoint.nav - 1) * 100;

    let peak = firstPoint.nav;
    let maxDrawdown = 0;
    for (const point of slice) {
      if (point.nav > peak) peak = point.nav;
      const drawdown = (point.nav / peak - 1) * 100;
      if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    }

    return {
      label: window.label,
      returnPct: Number(returnPct.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdown.toFixed(2)),
    };
  });
}

// ---------------------------------------------------------------------------
// 购买建议
// ---------------------------------------------------------------------------

export interface AdviceItem {
  tone: 'info' | 'warn' | 'good';
  title: string;
  text: string;
}

export interface SiblingClass {
  code: string;
  name: string;
  dailyLimit: number | null;
  limitText: string;
  status: PurchaseStatus;
}

export interface AdviceInput {
  fund: FundLimit;
  siblings?: readonly SiblingClass[];
  company?: string | null | undefined;
  rate?: string | null | undefined;
}

/**
 * 生成购买建议。
 *
 * 原则：**只陈述有数据支撑的事实**，不做没有依据的推算。
 * 因此这里不计算 A/C「平衡持有期」（需要 C 类销售服务费率，接口 A 不提供），
 * 只给出方向性说明与两类份额的并列事实。
 */
export function buildAdvice(input: AdviceInput): AdviceItem[] {
  const { fund, siblings = [] } = input;
  const advice: AdviceItem[] = [];

  switch (fund.status) {
    case PurchaseStatus.Suspended:
      advice.push({
        tone: 'warn',
        title: '当前暂停申购',
        text: '这只基金现在买不进。可关注基金公司的申购类公告，或考虑同指数的其它 QDII；场内份额可看「场内溢价」是否值得。',
      });
      break;
    case PurchaseStatus.OnExchange:
      advice.push({
        tone: 'warn',
        title: '场内交易品种',
        text: '只能二级市场买卖，不受申赎额度限制，但**受溢价影响**。QDII ETF 溢价 8%~10% 是常态，最高曾达 23%，买入前务必先看溢价率。',
      });
      break;
    case PurchaseStatus.Closed:
    case PurchaseStatus.Subscribing:
      advice.push({
        tone: 'info',
        title: fund.status === PurchaseStatus.Closed ? '封闭运作中' : '仍在募集期',
        text: '当前不可正常申购，需等开放或募集结束。',
      });
      break;
    default:
      break;
  }

  if (fund.status === PurchaseStatus.Limited && fund.dailyLimit !== null) {
    const limit = fund.dailyLimit;
    if (limit === 0) {
      advice.push({
        tone: 'warn',
        title: '日限额为 0',
        text: '状态仍显示「限大额」但日累计限额为 0，通常是暂停申购前兆，请以基金公司最新公告为准。',
      });
    } else if (limit <= 100) {
      advice.push({
        tone: 'warn',
        title: `额度极紧：单日仅 ${formatAmount(limit, fund.currency)}`,
        text: '适合小额定投或分批买入。若有同指数的其它基金额度更宽，可分散配置以提升单日可买总额。',
      });
    } else {
      advice.push({
        tone: 'info',
        title: `日累计限额 ${formatAmount(limit, fund.currency)}`,
        text: '额度仍可正常买入，超出部分需要分多日申购。',
      });
    }
  }

  if (fund.status === PurchaseStatus.Open && fund.dailyLimit === null) {
    advice.push({
      tone: 'good',
      title: '开放申购且无限额',
      text: '当前没有额度限制，可直接按需申购。',
    });
  }

  if (siblings.length > 0) {
    const list = siblings
      .slice(0, 3)
      .map((item) => `${item.name}（${item.code}，${item.limitText}）`)
      .join('、');
    advice.push({
      tone: 'info',
      title: '同基金其它份额类别',
      text: `${list}。费率结构不同：A 类收申购费、C 类收销售服务费，持有期短通常 C 更划算，长期持有通常 A 更划算。`,
    });
  }

  const letter = shareClassLetter(fund.name);
  if (letter === 'A') {
    advice.push({
      tone: 'info',
      title: 'A 类份额',
      text: '前端收取申购费（通常有折扣），无销售服务费。持有期越长，相对 C 类的成本优势越明显。',
    });
  } else if (letter === 'C') {
    advice.push({
      tone: 'info',
      title: 'C 类份额',
      text: '无申购费，但按日计提销售服务费。持有期越长，累计服务费越高，短线持有更划算。',
    });
  }

  advice.push({
    tone: 'info',
    title: '赎回费红线',
    text: '持有不满 7 天赎回，赎回费通常按不低于 1.5% 的惩罚性费率收取（多数权益类基金的通行规则），短线申赎成本极高。具体费率以基金合同为准。',
  });

  if (input.company) {
    advice.push({
      tone: 'info',
      title: '发行方',
      text: `${input.company}${input.rate ? ` · 天天基金折后费率 ${input.rate}` : ''}`,
    });
  }

  return advice;
}

/** 数据集中某条记录的「可买」判定，供 shareClasses 展示用 */
export function buyableText(fund: Pick<FundLimit, 'status'>): string {
  if (fund.status === PurchaseStatus.Open || fund.status === PurchaseStatus.Limited) return '可买';
  if (isOnExchange(fund as FundLimit)) return '场内交易';
  return fund.status || '未知';
}
