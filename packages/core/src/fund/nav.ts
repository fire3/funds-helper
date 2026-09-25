/**
 * 净值走势的**可比口径**。
 *
 * 单位净值会因为「份额分拆 / 分红除息」机械下调 —— 那不是亏损：
 * 拆分后持有份额按比例增加，总市值不变；分红是把钱发到了账户里。
 *
 * 实测样例（159507 通信ETF广发，2026-06-08 每份分拆 3 份）：
 *
 * | 日期 | 单位净值 | 累计净值 | 上游 `equityReturn` |
 * |---|---|---|---|
 * | 2026-06-05 | 3.1334 | 3.1334 | -1.19% |
 * | 2026-06-08 | 1.0103 | 3.0309 | **-3.27%** |
 *
 * 单位净值看起来一天跌了 **67.8%**，而上游记录的真实涨跌只有 -3.27%，
 * 累计净值（3.1334 → 3.0309）也说明当天只跌了 3.27%。
 *
 * 后果：**用原始单位净值做首尾比值，区间涨幅与最大回撤全是错的** ——
 * 159507 的近3年会算出 -2.54%（实际 +190% 量级），和「成立来 +166%」自相矛盾。
 * 因此：走势图仍画原始单位净值（它本身是准确的），但**区间统计必须用可比序列**。
 */

/** 单位净值事件的类型（上游 `unitMoney` 字段）*/
export const NAV_EVENT_KINDS = ['split', 'dividend', 'other'] as const;
export type NavEventKind = (typeof NAV_EVENT_KINDS)[number];

export interface NavEvent {
  date: string;
  kind: NavEventKind;
  /** 上游原文，例如「拆分：每份基金份额分拆3.0份」*/
  detail: string;
  /** 拆分比例：3 = 每份拆成 3 份（`kind='split'` 且有值时可用）*/
  ratio: number | null;
  /** 每份分红金额（元，`kind='dividend'` 且有值时可用）*/
  amount: number | null;
}

/** 单位净值走势的原始点（`sources` 层解析出来的形状）*/
export interface RawNavPoint {
  date: string;
  nav: number;
  change: number | null;
  /** 上游 `unitMoney`：空串 = 当日无除权事件 */
  unitMoney: string | null;
}

export interface ComparableNavPoint {
  date: string;
  nav: number;
}

/** `拆分：每份基金份额分拆3.0份` → 3.0 */
const SPLIT_RATIO = /(?:拆分|分拆)[^0-9]*([0-9]+(?:\.[0-9]+)?)/;
/** `每份派现金0.0430元` → 0.043 */
const DIVIDEND_AMOUNT = /派[^0-9]*([0-9]+(?:\.[0-9]+)?)/;
const SPLIT_WORDS = /拆分|分拆/;
const DIVIDEND_WORDS = /派|分红|红利/;

/**
 * 解析单日的除权事件。无法识别的文本按 `other` 保留 ——
 * 宁可只提示「当天有净值调整」，也不要静默丢掉一条会影响可比性的记录。
 */
export function parseNavEvent(date: string, unitMoney: string | null | undefined): NavEvent | null {
  const detail = unitMoney?.trim();
  if (!detail) return null;

  if (SPLIT_WORDS.test(detail)) {
    const ratio = Number(SPLIT_RATIO.exec(detail)?.[1]);
    if (Number.isFinite(ratio) && ratio > 0) {
      return { date, kind: 'split', detail, ratio, amount: null };
    }
  }
  if (DIVIDEND_WORDS.test(detail)) {
    const amount = Number(DIVIDEND_AMOUNT.exec(detail)?.[1]);
    if (Number.isFinite(amount) && amount > 0) {
      return { date, kind: 'dividend', detail, ratio: null, amount };
    }
  }
  return { date, kind: 'other', detail, ratio: null, amount: null };
}

/** 从原始走势里抽出全部除权事件（按日期升序）*/
export function extractNavEvents(points: readonly RawNavPoint[]): NavEvent[] {
  const events: NavEvent[] = [];
  for (const point of points) {
    const event = parseNavEvent(point.date, point.unitMoney);
    if (event) events.push(event);
  }
  return events;
}

/** 事件是否会改变「单位净值 vs 复权净值」的比值（`other` 无法量化，不计入）*/
export function isQuantifiableNavEvent(event: NavEvent): boolean {
  if (event.kind === 'split') return event.ratio !== null && event.ratio > 0 && event.ratio !== 1;
  if (event.kind === 'dividend') return event.amount !== null && event.amount > 0;
  return false;
}

const EPSILON = 1e-9;

/**
 * 上游累计净值是否能当可比序列用：长度/日期必须逐点对齐，且**确实与单位净值不同**
 * （完全相同说明上游没有做复权，用它等于没修）。
 */
function usableAccumulated(
  points: readonly RawNavPoint[],
  accumulated: readonly ComparableNavPoint[],
): boolean {
  if (accumulated.length !== points.length || points.length === 0) return false;
  let differs = false;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const acc = accumulated[index];
    if (!point || !acc || acc.date !== point.date) return false;
    if (Math.abs(acc.nav - point.nav) > EPSILON) differs = true;
  }
  return differs;
}

export interface ComparableNavSeries {
  points: ComparableNavPoint[];
  /**
   * `accumulated` = 直接用上游累计净值（首选）
   * `split-adjusted` = 上游累计净值不可用时，按拆分比例本地还原
   * `unit` = 没有需要还原的事件，序列与单位净值一致
   */
  basis: 'accumulated' | 'split-adjusted' | 'unit';
}

/**
 * 构造**跨除权可比**的净值序列（区间涨幅 / 最大回撤必须用它）。
 *
 * 首选上游累计净值；它缺失或没做复权时，退化为按拆分比例本地还原：
 * 从最后一天往回走，把该日之后发生的拆分比例累乘到当天净值上
 * （分红按「加回每份派现金额」近似，与累计净值的定义一致）。
 */
export function buildComparableNav(
  points: readonly RawNavPoint[],
  accumulated: readonly ComparableNavPoint[] = [],
): ComparableNavSeries {
  const events = extractNavEvents(points);
  const quantifiable = events.filter(isQuantifiableNavEvent);

  if (quantifiable.length === 0) {
    return { points: points.map((point) => ({ date: point.date, nav: point.nav })), basis: 'unit' };
  }
  if (usableAccumulated(points, accumulated)) {
    return {
      points: accumulated.map((point) => ({ date: point.date, nav: point.nav })),
      basis: 'accumulated',
    };
  }

  const eventByDate = new Map(events.map((event) => [event.date, event]));
  const adjusted: ComparableNavPoint[] = new Array(points.length);
  let splitFactor = 1;
  let dividendAdd = 0;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (!point) continue;
    adjusted[index] = { date: point.date, nav: point.nav * splitFactor + dividendAdd };
    const event = eventByDate.get(point.date);
    if (event?.kind === 'split' && event.ratio !== null && event.ratio > 0) {
      splitFactor *= event.ratio;
    }
    if (event?.kind === 'dividend' && event.amount !== null && event.amount > 0) {
      dividendAdd += event.amount;
    }
  }
  return { points: adjusted.filter((point) => point !== undefined), basis: 'split-adjusted' };
}

function trim(value: number, digits = 4): string {
  return String(Number(value.toFixed(digits)));
}

export interface NavEventNote {
  date: string;
  kind: NavEventKind;
  title: string;
  text: string;
}

/**
 * 把除权事件写成**可直接展示的解释**（详情卡片用）。
 *
 * 文案只陈述数据里的事实：上游原文、前后单位净值、上游记录的真实涨跌。
 * 前端不再自己算口径，避免两边对「突变」各有一套说法。
 */
export function describeNavEvents(
  points: readonly RawNavPoint[],
  events: readonly NavEvent[],
): NavEventNote[] {
  const indexByDate = new Map(points.map((point, index) => [point.date, index]));
  const notes: NavEventNote[] = [];

  for (const event of events) {
    const index = indexByDate.get(event.date);
    const point = index === undefined ? undefined : points[index];
    const previous = index === undefined || index === 0 ? undefined : points[index - 1];
    const actual = point?.change ?? null;
    const actualText =
      actual === null ? '' : `当日真实涨跌 ${actual > 0 ? '+' : ''}${trim(actual, 2)}%`;

    if (event.kind === 'split' && event.ratio !== null && point && previous) {
      notes.push({
        date: event.date,
        kind: event.kind,
        title: `净值因份额分拆下调（每份拆 ${trim(event.ratio)} 份）`,
        text:
          `${event.date} 每份基金份额分拆 ${trim(event.ratio)} 份，` +
          `单位净值由 ${trim(previous.nav)} 元调整为 ${trim(point.nav)} 元，` +
          `净值“跳水” ${trim((1 - point.nav / previous.nav) * 100, 2)}%。` +
          `这不是亏损：拆分后持有份额按比例增加（${trim(event.ratio)} 倍），持有总市值不变` +
          (actualText ? `，${actualText}` : '') +
          '。图中该点是单位净值的机械下调，区间涨幅已按复权口径计算。',
      });
      continue;
    }
    if (event.kind === 'dividend') {
      notes.push({
        date: event.date,
        kind: event.kind,
        title: '净值因分红除息下调',
        text:
          `${event.date} 每份派发现金 ${event.amount === null ? '（金额见上游原文）' : `${trim(event.amount)} 元`}` +
          (point && previous
            ? `，单位净值由 ${trim(previous.nav)} 元调整为 ${trim(point.nav)} 元`
            : '') +
          '。这不是亏损：跌掉的部分已作为红利发放，区间涨幅已按复权口径计算。',
      });
      continue;
    }
    notes.push({
      date: event.date,
      kind: 'other',
      title: '单位净值发生除权调整',
      text: `${event.date} 上游记录了净值调整（${event.detail}），图中可能出现跳变；区间涨幅已按可比口径计算，请结合该事件理解走势。`,
    });
  }
  return notes;
}

/** 区间统计口径的说明文案；序列本身可比时返回 null（前端就不用显示） */
export function describeNavSummaryBasis(basis: ComparableNavSeries['basis']): string | null {
  if (basis === 'unit') return null;
  const source = basis === 'accumulated' ? '上游累计净值' : '按拆分比例还原的单位净值';
  return `该基金发生过份额分拆/分红，下方区间涨幅与最大回撤按${source}（复权口径）计算，与图中原始单位净值的首尾比值不同。`;
}
