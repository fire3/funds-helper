import { describe, expect, it } from 'vitest';
import { parseCurrencyFromName } from '../fund/normalize.ts';
import { isUsdBuyable, isUsdShare, parseUsdKind } from './identify.ts';

describe('parseUsdKind —— 现汇 / 现钞 / 未标注', () => {
  it('现汇（含简写「美汇」）', () => {
    expect(parseUsdKind('嘉实美国成长股票美元现汇')).toBe('现汇');
    expect(parseUsdKind('华夏恒生ETF联接现汇')).toBe('现汇');
    expect(parseUsdKind('摩根富时发达市场REITs指数(QDII)美汇')).toBe('现汇');
  });

  it('现钞（含简写「美钞」）', () => {
    expect(parseUsdKind('嘉实全球互联网股票美元现钞')).toBe('现钞');
    expect(parseUsdKind('华夏恒生ETF联接现钞')).toBe('现钞');
    expect(parseUsdKind('摩根富时发达市场REITs指数(QDII)美钞')).toBe('现钞');
  });

  it('只写「美元」未标注形式', () => {
    expect(parseUsdKind('广发纳斯达克100ETF联接美元(QDII)A')).toBe('未标注');
  });

  it('「美元现汇」不会被误判成未标注（顺序敏感）', () => {
    expect(parseUsdKind('美元现汇')).toBe('现汇');
    expect(parseUsdKind('美元现钞')).toBe('现钞');
  });
});

describe('isUsdShare —— 币种由名称判定', () => {
  it('美元份额标记均判为 USD', () => {
    for (const name of [
      '嘉实美国成长股票美元现汇',
      '嘉实全球互联网股票美元现钞',
      '广发纳斯达克100ETF联接美元(QDII)A',
      '华夏恒生ETF联接现汇',
      '摩根富时发达市场REITs指数(QDII)美汇',
    ]) {
      expect(isUsdShare({ currency: parseCurrencyFromName(name) })).toBe(true);
    }
  });

  it('「人民币」优先：美元债主题不是美元份额', () => {
    expect(isUsdShare({ currency: parseCurrencyFromName('中银美元债债券(QDII)人民币A') })).toBe(
      false,
    );
    expect(isUsdShare({ currency: 'CNY' })).toBe(false);
    expect(isUsdShare({ currency: 'HKD' })).toBe(false);
  });
});

describe('isUsdBuyable —— 以申购状态为准', () => {
  it('开放申购 / 限大额 → 可买', () => {
    expect(isUsdBuyable({ status: '开放申购' })).toBe(true);
    expect(isUsdBuyable({ status: '限大额' })).toBe(true);
  });

  it('暂停申购 / 场内交易 / 空 → 不可买', () => {
    expect(isUsdBuyable({ status: '暂停申购' })).toBe(false);
    expect(isUsdBuyable({ status: '场内交易' })).toBe(false);
    expect(isUsdBuyable({ status: '' })).toBe(false);
  });
});
