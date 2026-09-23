import type { EtfCategory } from './model.ts';
import { classifyEtfTheme } from './theme.ts';

/**
 * 热点研究的聚合与反查（纯函数，见 docs/design/etf-hotspot.md §3.2）。
 *
 * 两条互补路径：
 * - `aggregateThemes`（自上而下）：主题内等权平均涨幅 → 「方向整体强不强」；
 * - `reverseHotspots`（自下而上）：涨幅/资金榜 Top-K → 按主题计数 → 「头部异动集中在哪」。
 *
 * 两者同向 = 热点确认；背离 = 均值可能被个别权重拉动，或普涨还没形成。
 */

/** 观察窗口（顺序 = 热点表的列顺序：近期在前，长周期在后） */
export const ETF_WINDOWS = ['1w', '1m', '3m', '6m', 'ytd', '1y', '3y'] as const;
export type EtfWindow = (typeof ETF_WINDOWS)[number];

export const ETF_WINDOW_LABELS: Record<EtfWindow, string> = {
  '1w': '近1周',
  '1m': '近1月',
  '3m': '近3月',
  '6m': '近6月',
  ytd: '今年来',
  '1y': '近1年',
  '3y': '近3年',
};

/**
 * 聚合/反查所需的最小字段集。
 *
 * 与 `EtfStatRecord` 同一模式：结构接口，`EtfRecord` 天然满足，
 * core 不依赖传输层 DTO，测试也能用最小对象。
 */
export interface EtfHotspotRecord {
  code: string;
  name: string;
  indexName: string | null;
  category: EtfCategory;
  scale: number | null;
  amount: number | null;
  premiumRate: number | null;
  maxDrawdown1y: number | null;
  /** 主力净流入（元；新浪渠道为 null） */
  mainInflow: number | null;
  /** 份额变化率 %（净申购代理；积累不足两天为 null） */
  sharesChangePct: number | null;
  change1w: number | null;
  change1m: number | null;
  change3m: number | null;
  ytdChange: number | null;
  ret6m: number | null;
  ret1y: number | null;
  ret3y: number | null;
}

/** 单只 ETF 的窗口涨幅 —— 表格、排序、聚合、反查共用这一个取数口径 */
export function windowReturn(record: EtfHotspotRecord, window: EtfWindow): number | null {
  switch (window) {
    case '1w':
      return record.change1w;
    case '1m':
      return record.change1m;
    case '3m':
      return record.change3m;
    case '6m':
      return record.ret6m;
    case 'ytd':
      return record.ytdChange;
    case '1y':
      return record.ret1y;
    case '3y':
      return record.ret3y;
  }
}

export interface EtfThemeRow<T extends EtfHotspotRecord = EtfHotspotRecord> {
  theme: string;
  /** 主题内 ETF 只数 */
  count: number;
  members: T[];
  /** 各窗口**等权平均**涨幅 %（null = 该窗口所有成员都无数据） */
  meanRet: Record<EtfWindow, number | null>;
  /** 各窗口参与均值的只数（覆盖率提示：`covered < count` 属正常，次新 ETF 缺长窗口） */
  covered: Record<EtfWindow, number>;
  /** 各窗口排名（1 起，按 meanRet 降序；null = 无数据） */
  ranks: Record<EtfWindow, number | null>;
  /** 各窗口参与排名的主题总数（信号按分位判断要用） */
  rankedCount: Record<EtfWindow, number>;
  /** 成交额合计（元），null = 成员全部无数据 */
  amount: number | null;
  /** 成交额占全市场 %（聚合完成后回填） */
  amountSharePct: number | null;
  /** 规模合计（元） */
  scale: number;
  /** 平均折溢价 %（无数据的成员不计入） */
  meanPremium: number | null;
  /** 平均近1年最大回撤 %（负值） */
  meanDrawdown1y: number | null;
  /** 平均份额变化 %（净申购代理；无数据 → null） */
  meanSharesChangePct: number | null;
}

function mean(values: readonly (number | null)[]): number | null {
  let sum = 0;
  let n = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    sum += value;
    n += 1;
  }
  return n === 0 ? null : sum / n;
}

function sum(values: readonly (number | null)[]): number | null {
  let total = 0;
  let n = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    total += value;
    n += 1;
  }
  return n === 0 ? null : total;
}

/** 分组 → 等权聚合 → 各窗口排名 → 成交占比回填 */
export function aggregateThemes<T extends EtfHotspotRecord>(
  records: readonly T[],
): EtfThemeRow<T>[] {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const theme = classifyEtfTheme(record.name, record.indexName, record.category);
    const list = groups.get(theme);
    if (list === undefined) groups.set(theme, [record]);
    else list.push(record);
  }

  const rows: EtfThemeRow<T>[] = [...groups.entries()].map(([theme, members]) => {
    const meanRet = {} as Record<EtfWindow, number | null>;
    const covered = {} as Record<EtfWindow, number>;
    for (const window of ETF_WINDOWS) {
      const values = members.map((member) => windowReturn(member, window));
      meanRet[window] = mean(values);
      covered[window] = values.filter((value) => value !== null).length;
    }
    const premiums = members.map((member) => member.premiumRate);
    const drawdowns = members.map((member) => member.maxDrawdown1y);
    const shareChanges = members.map((member) => member.sharesChangePct);
    return {
      theme,
      count: members.length,
      members,
      meanRet,
      covered,
      ranks: Object.fromEntries(ETF_WINDOWS.map((window) => [window, null])) as Record<
        EtfWindow,
        number | null
      >,
      rankedCount: Object.fromEntries(ETF_WINDOWS.map((window) => [window, 0])) as Record<
        EtfWindow,
        number
      >,
      amount: sum(members.map((member) => member.amount)),
      amountSharePct: null,
      scale: sum(members.map((member) => member.scale)) ?? 0,
      meanPremium: mean(premiums),
      meanDrawdown1y: mean(drawdowns),
      meanSharesChangePct: mean(shareChanges),
    };
  });

  // 各窗口独立排名：只在「该窗口有数据」的主题之间比（rankedCount 记录分母）
  for (const window of ETF_WINDOWS) {
    const ranked = rows
      .filter((row) => row.meanRet[window] !== null)
      .sort((a, b) => (b.meanRet[window] ?? 0) - (a.meanRet[window] ?? 0));
    ranked.forEach((row, index) => {
      row.ranks[window] = index + 1;
      row.rankedCount[window] = ranked.length;
    });
  }

  const totalAmount = sum(rows.map((row) => row.amount));
  if (totalAmount !== null && totalAmount > 0) {
    for (const row of rows) {
      row.amountSharePct = row.amount === null ? null : (row.amount / totalAmount) * 100;
    }
  }

  // 展示序：按焦点窗口排名排不在此处做（焦点窗口是 UI 状态），返回按只数降序的稳定序
  return rows.sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme, 'zh-CN'));
}

/** 轮动信号（焦点窗口排名分位 × 近1年排名分位） */
export type EtfThemeSignal = '持续强势' | '新热点' | '退潮' | '震荡';

export const ETF_THEME_SIGNALS: readonly EtfThemeSignal[] = ['持续强势', '新热点', '退潮', '震荡'];

/**
 * 分位阈值（按 rank / rankedCount）：
 * - ≤25% 视为强，≥50% 分位视为弱（25%~50% 之间是中性过渡带，避免标签抖动）；
 * - 任一窗口无数据 → `震荡`（没有信号不等于强，也绝不能伪装成弱）。
 */
export function themeSignal(
  row: Pick<EtfThemeRow, 'ranks' | 'rankedCount'>,
  focusWindow: EtfWindow,
): EtfThemeSignal {
  const shortRank = row.ranks[focusWindow];
  const shortTotal = row.rankedCount[focusWindow];
  const longRank = row.ranks['1y'];
  const longTotal = row.rankedCount['1y'];
  if (shortRank === null || shortTotal === 0 || longRank === null || longTotal === 0) {
    return '震荡';
  }

  const shortPos = shortRank / shortTotal;
  const longPos = longRank / longTotal;
  const shortStrong = shortPos <= 0.25;
  const shortWeak = shortPos >= 0.5;
  const longStrong = longPos <= 0.25;
  const longWeak = longPos >= 0.5;

  if (shortStrong && longStrong) return '持续强势';
  if (shortStrong && longWeak) return '新热点';
  if (shortWeak && longStrong) return '退潮';
  return '震荡';
}

// ---------------------------------------------------------------------------
// 反查（自下而上）
// ---------------------------------------------------------------------------

export const ETF_REVERSE_METRICS = ['ret', 'mainInflow', 'sharesChange', 'amount'] as const;
export type EtfReverseMetric = (typeof ETF_REVERSE_METRICS)[number];

export const ETF_REVERSE_METRIC_LABELS: Record<EtfReverseMetric, string> = {
  ret: '涨幅榜',
  mainInflow: '主力净流入榜',
  sharesChange: '份额增长榜',
  amount: '成交额榜',
};

export interface EtfReverseOptions {
  metric: EtfReverseMetric;
  /** `metric='ret'` 的窗口，默认近1月 */
  window?: EtfWindow;
  /** 升序 = 看领跌/份额流失（只对 `ret`、`sharesChange` 有「反向」意义，UI 控制） */
  dir?: 'desc' | 'asc';
  /** 取前 K 只（默认 30） */
  k?: number;
}

export interface EtfReverseGroup<T extends EtfHotspotRecord = EtfHotspotRecord> {
  theme: string;
  /** 上榜只数：≥2 = 「多点开花」强信号 */
  hits: number;
  /** 按指标值排序的成员（Top-K 内） */
  members: T[];
  /** 组内头部指标值（排序键） */
  headValue: number;
}

/** 反查指标取数口径（null = 不参与榜单，剔除而不是当成 0） */
export function reverseValueOf(
  record: EtfHotspotRecord,
  options: Pick<EtfReverseOptions, 'metric' | 'window'>,
): number | null {
  switch (options.metric) {
    case 'ret':
      return windowReturn(record, options.window ?? '1m');
    case 'mainInflow':
      return record.mainInflow;
    case 'sharesChange':
      return record.sharesChangePct;
    case 'amount':
      return record.amount;
  }
}

/**
 * Top-K 榜单 → 按主题分组。
 *
 * 排序：命中数降序 → 组内头部指标值按 `dir` —— 「3 只进榜」比「1 只涨幅第一」
 * 更能说明资金在往整个方向聚集（多点开花）。
 */
export function reverseHotspots<T extends EtfHotspotRecord>(
  records: readonly T[],
  options: EtfReverseOptions,
): EtfReverseGroup<T>[] {
  const { dir = 'desc', k = 30 } = options;

  const valued: { record: T; value: number }[] = [];
  for (const record of records) {
    const value = reverseValueOf(record, options);
    if (value === null || !Number.isFinite(value)) continue;
    valued.push({ record, value });
  }
  valued.sort(
    (a, b) =>
      (dir === 'desc' ? b.value - a.value : a.value - b.value) ||
      a.record.code.localeCompare(b.record.code),
  );

  const groups = new Map<string, EtfReverseGroup<T>>();
  for (const { record, value } of valued.slice(0, k)) {
    const theme = classifyEtfTheme(record.name, record.indexName, record.category);
    const group = groups.get(theme);
    if (group === undefined) {
      groups.set(theme, { theme, hits: 1, members: [record], headValue: value });
    } else {
      group.hits += 1;
      group.members.push(record);
    }
  }

  return [...groups.values()].sort(
    (a, b) =>
      b.hits - a.hits ||
      (dir === 'desc' ? b.headValue - a.headValue : a.headValue - b.headValue) ||
      a.theme.localeCompare(b.theme, 'zh-CN'),
  );
}
