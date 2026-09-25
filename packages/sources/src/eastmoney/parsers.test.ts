import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError } from '../errors.ts';
import { parseFundDetail } from './fund-detail.ts';
import { parseFundCatalog } from './fund-list.ts';
import { parseHoldings } from './holdings.ts';
import { noticeUrl, parseNotices } from './notices.ts';
import { parsePeriodIncrease } from './period-increase.ts';
import {
  extractAccumulatedNav,
  extractAllocation,
  extractHolders,
  extractNavTrend,
  extractScale,
  parsePingzhong,
  tsToDate,
} from './pingzhong.ts';
import { parseQuotes, toSecId } from './quote.ts';

function fixture(path: string): string {
  return readFileSync(new URL(`../../test/fixtures/eastmoney/${path}`, import.meta.url), 'utf8');
}

describe('parseFundDetail —— 接口 B', () => {
  it('解析实时字段', () => {
    const detail = parseFundDetail(fixture('fund-detail/normal.json'));
    expect(detail).toMatchObject({
      code: '270042',
      name: '广发纳斯达克100ETF联接人民币(QDII)A',
      fundType: '指数型-海外股票',
      purchaseStatus: '限大额',
      redeemStatus: '开放赎回',
      minPurchase: '2',
      maxPurchase: '2',
      nav: '8.1177',
      navDate: '2026-09-11',
      sourceRate: '1.30%',
      rate: '0.13%',
      company: '广发基金',
      manager: '刘杰',
      riskLevel: '4',
    });
  });

  it('FSRQ 带完整年份（优于接口 A 的 MM-DD）', () => {
    expect(parseFundDetail(fixture('fund-detail/normal.json')).navDate).toBe('2026-09-11');
  });

  it('DUEDATE 的 "--" 归一化为 null', () => {
    expect(parseFundDetail(fixture('fund-detail/normal.json')).nextOpenDate).toBeNull();
  });

  it('场内交易的 MINSG/MAXSG = "--" 归一化为 null', () => {
    const detail = parseFundDetail(fixture('fund-detail/on-exchange.json'));
    expect(detail.minPurchase).toBeNull();
    expect(detail.maxPurchase).toBeNull();
  });

  it('非 JSON → ParseError', () => {
    expect(() => parseFundDetail('<html>404</html>')).toThrow(ParseError);
  });

  it('缺少 Datas → ParseError', () => {
    expect(() => parseFundDetail('{"ErrCode":1,"Success":false}')).toThrow(ParseError);
  });
});

describe('parseNotices —— 接口 D（JSONP）', () => {
  it('剥离 cb(...) 外壳并解析公告', () => {
    const notices = parseNotices(fixture('notices/limit-notices.jsonp'));
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({
      id: 'AN202609101828123456',
      publishDate: '2026-09-10',
      category: '5',
    });
    expect(notices[0]?.title).toContain('调整大额申购');
  });

  it('出版日期截断到 YYYY-MM-DD', () => {
    const notices = parseNotices(fixture('notices/limit-notices.jsonp'));
    expect(notices.every((notice) => /^\d{4}-\d{2}-\d{2}$/.test(notice.publishDate))).toBe(true);
  });

  it('空数据返回空数组而不抛错', () => {
    expect(parseNotices(fixture('notices/empty.jsonp'))).toEqual([]);
  });

  it('非 JSONP 内容返回空数组', () => {
    expect(parseNotices('not jsonp at all')).toEqual([]);
  });

  it('生成公告详情页 URL', () => {
    expect(noticeUrl('270042', 'AN123')).toBe(
      'https://fund.eastmoney.com/gonggao/270042,AN123.html',
    );
  });
});

describe('parseFundCatalog —— 接口 E', () => {
  it('解析 var r = [...] 形式的全量列表', () => {
    const entries = parseFundCatalog(fixture('fund-list/fundcode_search.js'));
    expect(entries).toHaveLength(3);
    expect(entries[1]).toMatchObject({
      code: '270042',
      name: '广发纳斯达克100ETF联接人民币(QDII)A',
      fundType: '指数型-海外股票',
    });
  });

  it('结构不符 → ParseError', () => {
    expect(() => parseFundCatalog('var r = null;')).toThrow(ParseError);
  });
});

describe('parseQuotes —— 接口 F', () => {
  it('解析折价率 f402', () => {
    const items = parseQuotes(fixture('quote/ulist.json'));
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ code: '513500', name: '标普500ETF博时', discountRate: -8.24 });
  });

  it('f402 负值即溢价，用 T-1 净值复算可验证', () => {
    const items = parseQuotes(fixture('quote/ulist.json'));
    const target = items.find((item) => item.code === '513100');
    // 价格 2.191 / 净值 1.9831 → 溢价 +10.48%，故 f402 ≈ -10.47
    expect(target?.discountRate).toBeCloseTo(-10.47, 1);
    expect(target?.discountRate).toBeLessThan(0);
  });

  it('上游返回 data:null（未知 secid）→ 空数组，不抛错', () => {
    expect(parseQuotes(fixture('quote/no-data.json'))).toEqual([]);
  });

  it('非 JSON → ParseError', () => {
    expect(() => parseQuotes('<html>')).toThrow(ParseError);
  });

  it('secids 前缀：5 开头为沪市 1.，其余为深市 0.', () => {
    expect(toSecId('513500')).toBe('1.513500');
    expect(toSecId('159941')).toBe('0.159941');
  });
});

describe('parsePingzhong —— 接口 G', () => {
  it('逐 var 块解析，跳过非 JSON 块', () => {
    const data = parsePingzhong(fixture('pingzhong/270042.js'));
    expect(Object.keys(data).length).toBeGreaterThan(5);
    // 函数块被跳过，不是解析失败
    expect(data.Data_netWorthTrend).toBeDefined();
    expect(data.calcRate).toBeUndefined();
  });

  it('提取全历史净值走势', () => {
    const trend = extractNavTrend(parsePingzhong(fixture('pingzhong/270042.js')));
    expect(trend).toHaveLength(3);
    expect(trend[0]).toMatchObject({ x: 1344960000000, y: 1.0 });
  });

  it('时间戳按 UTC+8 换算日期（按 UTC 取会差一天）', () => {
    expect(tsToDate(1344960000000)).toBe('2012-08-15');
  });

  it('提取季度规模并按日期升序', () => {
    const scale = extractScale(parsePingzhong(fixture('pingzhong/270042.js')));
    expect(scale).toHaveLength(5);
    expect(scale[0]).toMatchObject({ date: '2025-06-30', scale: 93.14 });
    expect(scale.at(-1)).toMatchObject({ date: '2026-06-30', scale: 122.23, mom: '25.81%' });
  });

  it('资产配置取最新一期占比，跳过 type:line 的绝对值序列', () => {
    const allocation = extractAllocation(parsePingzhong(fixture('pingzhong/270042.js')));
    const names = allocation.map((item) => item.name);
    expect(names).toContain('现金占净比');
    expect(names).not.toContain('净资产'); // type: 'line' 被跳过
    expect(allocation.find((item) => item.name === '现金占净比')?.value).toBe(9.04);
  });

  it('持有人结构取最新一期', () => {
    const holders = extractHolders(parsePingzhong(fixture('pingzhong/270042.js')));
    expect(holders.find((item) => item.name === '机构持有比例')?.value).toBe(0.12);
    expect(holders.find((item) => item.name === '个人持有比例')?.value).toBe(99.88);
  });

  it('空文本返回空对象（由 fetch 层负责判定为失败）', () => {
    expect(parsePingzhong('/* nothing here */')).toEqual({});
  });

  it('保留 unitMoney：份额分拆/分红是解释「净值突变」的唯一线索', () => {
    const trend = extractNavTrend(parsePingzhong(fixture('pingzhong/split.js')));
    expect(trend).toHaveLength(3);
    // 没有事件的日子归一化成 null，有事件的日子保留原文
    expect(trend[0]?.unitMoney).toBeNull();
    expect(trend[2]?.unitMoney).toBe('拆分：每份基金份额分拆3.0份');
  });

  it('提取累计净值走势（Data_ACWorthTrend 是 [时间戳, 净值] 二元组）', () => {
    const accumulated = extractAccumulatedNav(parsePingzhong(fixture('pingzhong/split.js')));
    expect(accumulated).toHaveLength(3);
    expect(accumulated[2]).toMatchObject({ x: 1789084800000, y: 3.3 });
    // 分拆日累计净值连续（单位净值同日 3.3 → 1.1）
    expect(accumulated[1]?.y).toBe(3.3);
  });

  it('没有累计净值块时返回空数组（由 core 退回按拆分比例还原）', () => {
    expect(extractAccumulatedNav(parsePingzhong('/* nothing here */'))).toEqual([]);
  });
});

describe('parsePeriodIncrease —— 接口 H', () => {
  it('解析各周期收益率与同类排名', () => {
    const data = parsePeriodIncrease(fixture('period-increase/270042.json'));
    expect(data.periods).toHaveLength(10);
    expect(data.estabDate).toBe('2012-08-15');
    expect(data.time).toBe('2026-09-11');

    const oneYear = data.periods.find((period) => period.title === '1N');
    expect(oneYear).toMatchObject({
      ret: '15.00',
      avg: '-0.56',
      bench: '-0.93',
      rank: '118',
      total: '349',
    });
  });

  it('成立来（LN）的空基准保留为 null，由展示层兜底', () => {
    const data = parsePeriodIncrease(fixture('period-increase/270042.json'));
    const sinceInception = data.periods.find((period) => period.title === 'LN');
    expect(sinceInception?.ret).toBe('885.36');
    expect(sinceInception?.avg).toBeNull();
    expect(sinceInception?.rank).toBeNull();
  });

  it('场内 ETF（510300）同样可用：6Y/1N/3N 与数据日期齐备（热点研究的取数前提）', () => {
    const data = parsePeriodIncrease(fixture('period-increase/510300.json'));
    expect(data.periods).toHaveLength(10);
    expect(data.time).toBe('2026-09-22');
    const pick = (title: string) => data.periods.find((period) => period.title === title);
    expect(pick('6Y')).toMatchObject({ ret: '0.90', bench: '2.25' });
    expect(pick('1N')).toMatchObject({ ret: '2.53', bench: '-0.06' });
    expect(pick('3N')).toMatchObject({ ret: '29.78', bench: '20.82' });
  });
});

describe('parseHoldings —— 接口 I', () => {
  it('联接基金：fundStocks 为空，回退到 ETFCODE', () => {
    const holdings = parseHoldings(fixture('holdings/linked-fund.json'));
    expect(holdings.stocks).toEqual([]);
    expect(holdings.etf).toEqual({ code: '159941', name: '纳指ETF广发' });
  });

  it('报告期在响应顶层（不在 Datas 内）', () => {
    expect(parseHoldings(fixture('holdings/linked-fund.json')).reportDate).toBe('2026-06-30');
    expect(parseHoldings(fixture('holdings/direct-stock.json')).reportDate).toBe('2026-06-30');
  });

  it('直投型 QDII：解析重仓股与债券，ETFCODE 为空时 etf 为 null', () => {
    const holdings = parseHoldings(fixture('holdings/direct-stock.json'));
    expect(holdings.stocks).toHaveLength(3);
    expect(holdings.stocks[0]).toMatchObject({
      code: 'NVDA',
      name: '英伟达',
      weight: 4.33,
      action: '增持',
      delta: 0.99,
    });
    expect(holdings.bonds).toHaveLength(1);
    expect(holdings.bonds[0]).toMatchObject({ code: '019666', weight: 2.5 });
    expect(holdings.etf).toBeNull();
  });

  it('缺少 Datas → ParseError', () => {
    expect(() => parseHoldings('{"Expansion":"2026-06-30"}')).toThrow(ParseError);
  });
});
