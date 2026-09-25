import {
  buildComparableNav,
  describeNavEvents,
  describeNavSummaryBasis,
  extractNavEvents,
  periodLabel,
  periodRank,
  summarizeNav,
} from '@funds-helper/core';
import type {
  AllocationItem,
  FundDetailBase,
  Holdings,
  NavEvent,
  NavPoint,
  NavSummaryRow,
  Notice,
  PeriodReturn,
  ScalePoint,
} from '@funds-helper/shared';
import {
  extractAccumulatedNav,
  extractAllocation,
  extractHolders,
  extractNavTrend,
  extractScale,
  noticeUrl,
  type RawNotice,
  tsToDate,
  UpstreamError,
} from '@funds-helper/sources';
import type { EastmoneyFundDataSource } from '../data-sources/eastmoney.ts';

/**
 * 单只基金详情的**通用区块**聚合。
 *
 * 净值走势 / 区间统计 / 分周期收益 / 规模 / 配置 / 持仓 / 公告 —— 这些与「是 QDII 还是
 * 美元份额」无关，两个工具的详情抽屉完全一样，因此抽到这里共用，避免出现第二份上游口径。
 *
 * 每块**独立容错**：某块失败只写进 `errors[]`，其余区块照常返回。
 */

/** 净值走势只回传最近约 3.2 年（800 个交易日），全量 3000+ 点没有意义 */
export const NAV_POINTS = 800;

export interface FundDetailSections {
  base: FundDetailBase | null;
  /** 原始**单位净值**走势（不加工，图上会出现分拆/分红造成的台阶）*/
  navTrend: NavPoint[];
  /** 除权事件（份额分拆 / 分红除息），用于在卡片里解释净值突变 */
  navEvents: NavEvent[];
  /** 区间涨幅与最大回撤；发生除权时按复权口径计算 */
  navSummary: NavSummaryRow[];
  /** 区间统计的口径说明；序列本身可比时为 null */
  navSummaryNote: string | null;
  scale: ScalePoint[];
  allocation: AllocationItem[];
  holders: AllocationItem[];
  periods: PeriodReturn[];
  holdings: Holdings;
  reportDate: string | null;
  notices: Notice[];
  /** 供调用方按需落库的原始公告 */
  rawNotices: RawNotice[];
  errors: string[];
}

export function toNumberOrNull(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function emptyHoldings(): Holdings {
  return { stocks: [], bonds: [], etf: null };
}

export async function buildFundDetailSections(
  source: EastmoneyFundDataSource,
  code: string,
): Promise<FundDetailSections> {
  const errors: string[] = [];
  const timed = (label: string, error: Error): void => {
    errors.push(`${label}不可用：${error.message}`);
  };

  let base: FundDetailBase | null = null;
  let navTrend: NavPoint[] = [];
  let navEvents: NavEvent[] = [];
  let navSummary: NavSummaryRow[] = [];
  let navSummaryBasisNote: string | null = null;
  let scale: ScalePoint[] = [];
  let allocation: AllocationItem[] = [];
  let holders: AllocationItem[] = [];
  let periods: PeriodReturn[] = [];
  let holdings: Holdings = emptyHoldings();
  let reportDate: string | null = null;
  let notices: Notice[] = [];
  let rawNotices: RawNotice[] = [];

  // 接口 B：基础信息
  try {
    const detail = await source.fetchFundDetail(code);
    base = {
      name: detail.name,
      fundType: detail.fundType,
      company: detail.company,
      manager: detail.manager,
      purchaseStatus: detail.purchaseStatus,
      redeemStatus: detail.redeemStatus,
      maxPurchase: toNumberOrNull(detail.maxPurchase),
      minPurchase: toNumberOrNull(detail.minPurchase),
      nav: toNumberOrNull(detail.nav),
      navDate: detail.navDate,
      nextOpenDate: detail.nextOpenDate,
      sourceRate: detail.sourceRate,
      rate: detail.rate,
      riskLevel: detail.riskLevel,
    };
  } catch (error) {
    if (error instanceof UpstreamError) timed('详情接口', error);
    else throw error;
  }

  // 接口 G：净值走势 / 规模 / 配置 / 持有人
  try {
    const pingzhong = await source.fetchPingzhong(code);
    const points = extractNavTrend(pingzhong).map((point) => ({
      date: tsToDate(point.x),
      nav: point.y,
      change: point.equityReturn,
      unitMoney: point.unitMoney,
    }));

    // 单位净值会因份额分拆/分红机械下调（实测 159507 一天「跌」67.8%），
    // 直接拿它算首尾比值会把除权当成亏损 —— 所以区间统计走**可比序列**，
    // 走势图仍回传原始单位净值（它本身是准确的），并由 navEvents 解释台阶。
    const events = extractNavEvents(points);
    const notes = describeNavEvents(points, events);
    navEvents = events.flatMap((event, index) => {
      const note = notes[index];
      return note === undefined ? [] : [{ ...event, title: note.title, text: note.text }];
    });

    const accumulated = extractAccumulatedNav(pingzhong).map((point) => ({
      date: tsToDate(point.x),
      nav: point.y,
    }));
    const comparable = buildComparableNav(points, accumulated);
    navSummaryBasisNote = describeNavSummaryBasis(comparable.basis);

    // 区间统计用完整历史，图表只回传最近 NAV_POINTS 个点
    navSummary = summarizeNav(comparable.points);
    navTrend = points.slice(-NAV_POINTS);
    scale = extractScale(pingzhong).map((point) => ({
      date: point.date,
      scale: point.scale,
      mom: point.mom,
    }));
    allocation = extractAllocation(pingzhong).map((item) => ({
      name: item.name,
      value: item.value,
    }));
    holders = extractHolders(pingzhong).map((item) => ({ name: item.name, value: item.value }));
  } catch (error) {
    if (error instanceof UpstreamError) timed('净值走势', error);
    else throw error;
  }

  // 接口 H：分周期收益率
  try {
    const increase = await source.fetchPeriodIncrease(code);
    periods = increase.periods
      .map((period) => ({
        key: period.title,
        label: periodLabel(period.title),
        ret: toNumberOrNull(period.ret),
        avg: toNumberOrNull(period.avg),
        bench: toNumberOrNull(period.bench),
        rank: toNumberOrNull(period.rank),
        total: toNumberOrNull(period.total),
      }))
      .sort((a, b) => periodRank(a.key) - periodRank(b.key));
  } catch (error) {
    if (error instanceof UpstreamError) timed('阶段涨幅', error);
    else throw error;
  }

  // 接口 I：持仓
  try {
    const raw = await source.fetchHoldings(code);
    reportDate = raw.reportDate;
    holdings = { stocks: raw.stocks, bonds: raw.bonds, etf: raw.etf };
  } catch (error) {
    if (error instanceof UpstreamError) timed('持仓数据', error);
    else throw error;
  }

  // 接口 D：申购类公告
  try {
    rawNotices = await source.fetchNotices(code, 8);
    notices = rawNotices.map((notice) => ({
      id: notice.id,
      title: notice.title,
      publishDate: notice.publishDate,
      url: noticeUrl(code, notice.id),
    }));
  } catch (error) {
    if (error instanceof UpstreamError) timed('限购公告', error);
    else throw error;
  }

  return {
    base,
    navTrend,
    navEvents,
    navSummary,
    navSummaryNote: navSummaryBasisNote,
    scale,
    allocation,
    holders,
    periods,
    holdings,
    reportDate,
    notices,
    rawNotices,
    errors,
  };
}
