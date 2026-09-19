import { describe, expect, it } from 'vitest';
import { PurchaseStatus, type RawFundRow } from './model.ts';
import {
  buildFundLimit,
  isBuyable,
  isOnExchange,
  isQdii,
  limitDisplay,
  normalizeLimit,
  parseCurrencyFromName,
  parsePurchaseStatus,
  parseRedeemStatus,
  toNumber,
} from './normalize.ts';

function row(overrides: Partial<RawFundRow> = {}): RawFundRow {
  return {
    code: '270042',
    name: '广发纳斯达克100ETF联接人民币(QDII)A',
    fundType: '指数型-海外股票',
    nav: '8.1177',
    navDate: '09-11',
    purchaseStatus: '限大额',
    redeemStatus: '开放赎回',
    nextOpenDate: '',
    minPurchase: '2.0',
    dailyLimit: '2.0',
    fee: '0.13%',
    ...overrides,
  };
}

describe('isQdii —— QDII 口径（最容易出错的地方）', () => {
  it('识别指数型 QDII：标签不含 "QDII" 字样', () => {
    expect(isQdii('指数型-海外股票')).toBe(true);
  });

  it('识别 QDII-* 系列标签', () => {
    for (const type of ['QDII-混合偏股', 'QDII-普通股票', 'QDII-纯债', 'QDII-FOF', 'QDII-REITs']) {
      expect(isQdii(type)).toBe(true);
    }
  });

  it('排除非 QDII 类型', () => {
    expect(isQdii('混合型-灵活')).toBe(false);
    expect(isQdii('股票型')).toBe(false);
    expect(isQdii('指数型-股票')).toBe(false);
  });
});

describe('parseCurrencyFromName —— 份额币种（「人民币」优先）', () => {
  it('「人民币」优先于「美元」，避免美元债主题误判', () => {
    // 这两只是人民币份额，名称中的「美元」描述的是投资方向
    expect(parseCurrencyFromName('中银美元债债券(QDII)人民币A')).toBe('CNY');
    expect(parseCurrencyFromName('汇添富美元债债券(QDII)人民币A')).toBe('CNY');
  });

  it('识别常见美元份额标记', () => {
    expect(parseCurrencyFromName('嘉实美国成长股票美元现汇')).toBe('USD');
    expect(parseCurrencyFromName('嘉实全球互联网股票美元现钞')).toBe('USD');
    expect(parseCurrencyFromName('广发纳斯达克100ETF联接美元(QDII)A')).toBe('USD');
    expect(parseCurrencyFromName('华夏恒生ETF联接现汇')).toBe('USD');
  });

  it('识别美元的简写变体 美汇/美钞（漏掉会误判为人民币）', () => {
    expect(parseCurrencyFromName('摩根富时发达市场REITs指数(QDII)美汇')).toBe('USD');
    expect(parseCurrencyFromName('摩根富时发达市场REITs指数(QDII)美钞')).toBe('USD');
  });

  it('识别港币份额', () => {
    expect(parseCurrencyFromName('某基金港币份额')).toBe('HKD');
    expect(parseCurrencyFromName('某基金港元份额')).toBe('HKD');
  });

  it('无标记时默认人民币', () => {
    expect(parseCurrencyFromName('博时标普500ETF联接A')).toBe('CNY');
  });
});

describe('normalizeLimit —— 无限额哨兵值与 0 的三义', () => {
  it('大整数哨兵值一律归一化为 null（无限额）', () => {
    expect(normalizeLimit('100000000000', PurchaseStatus.Open, 'CNY')).toBeNull(); // 1e11
    expect(normalizeLimit('10000000000', PurchaseStatus.Open, 'CNY')).toBeNull(); // 1e10
    expect(normalizeLimit('9999999999', PurchaseStatus.Open, 'CNY')).toBeNull();
    expect(normalizeLimit(100000000, PurchaseStatus.Open, 'CNY')).toBeNull(); // 恰好 1e8
  });

  it('真实限额原样保留', () => {
    expect(normalizeLimit('2.0', PurchaseStatus.Limited, 'CNY')).toBe(2);
    expect(normalizeLimit('10000000', PurchaseStatus.Limited, 'CNY')).toBe(10000000);
  });

  it('0 的第一义：场内交易不走申赎通道 → 无限额', () => {
    expect(normalizeLimit('0', PurchaseStatus.OnExchange, 'CNY')).toBeNull();
  });

  it('0 的第二义：非人民币份额渠道不售 → 无限额', () => {
    expect(normalizeLimit('0', PurchaseStatus.Limited, 'USD')).toBeNull();
    expect(normalizeLimit('0', PurchaseStatus.Limited, 'HKD')).toBeNull();
  });

  it('0 的第三义：人民币 + 限大额 → 真实就是 0', () => {
    expect(normalizeLimit('0', PurchaseStatus.Limited, 'CNY')).toBe(0);
  });

  it('缺失值容错："--" / "" / null 均归一化为 null', () => {
    expect(normalizeLimit('--', PurchaseStatus.Limited, 'CNY')).toBeNull();
    expect(normalizeLimit('', PurchaseStatus.Limited, 'CNY')).toBeNull();
    expect(normalizeLimit(null, PurchaseStatus.Limited, 'CNY')).toBeNull();
    expect(normalizeLimit(undefined, PurchaseStatus.Limited, 'CNY')).toBeNull();
  });
});

describe('状态解析', () => {
  it('申购状态未知值降级为 Unknown 而不抛错', () => {
    expect(parsePurchaseStatus('限大额')).toBe(PurchaseStatus.Limited);
    expect(parsePurchaseStatus('某种新状态')).toBe(PurchaseStatus.Unknown);
    expect(parsePurchaseStatus(null)).toBe(PurchaseStatus.Unknown);
  });

  it('赎回状态独立解析：开放赎回 不会退化成 Unknown', () => {
    expect(parseRedeemStatus('开放赎回')).toBe('开放赎回');
    expect(parseRedeemStatus('暂停赎回')).toBe('暂停赎回');
    // 用申购枚举解析赎回状态会得到 Unknown —— 这正是要避免的
    expect(parsePurchaseStatus('开放赎回')).toBe(PurchaseStatus.Unknown);
  });
});

describe('toNumber', () => {
  it('容错各类上游脏值', () => {
    expect(toNumber('2.0')).toBe(2);
    expect(toNumber('--')).toBeNull();
    expect(toNumber('')).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
  });
});

describe('buildFundLimit', () => {
  it('把具名行归一化为领域模型', () => {
    const fund = buildFundLimit(row());
    expect(fund.code).toBe('270042');
    expect(fund.currency).toBe('CNY');
    expect(fund.status).toBe(PurchaseStatus.Limited);
    expect(fund.dailyLimit).toBe(2);
    expect(fund.minPurchase).toBe(2);
    expect(fund.redeemStatus).toBe('开放赎回');
    expect(fund.nextOpenDate).toBeNull(); // '' → null
    expect(isBuyable(fund)).toBe(true);
    expect(isOnExchange(fund)).toBe(false);
  });

  it('场内交易行：限额归一化为无限额', () => {
    const fund = buildFundLimit(
      row({
        code: '513100',
        name: '纳指ETF国泰',
        purchaseStatus: '场内交易',
        redeemStatus: '场内交易',
        dailyLimit: '0',
        minPurchase: '0',
        fee: '',
      }),
    );
    expect(fund.dailyLimit).toBeNull();
    expect(isOnExchange(fund)).toBe(true);
    expect(isBuyable(fund)).toBe(false);
    expect(limitDisplay(fund)).toBe('场内交易');
  });
});

describe('limitDisplay', () => {
  it('暂停申购优先于额度展示', () => {
    const fund = buildFundLimit(row({ purchaseStatus: '暂停申购', dailyLimit: '100.0' }));
    expect(limitDisplay(fund)).toBe('暂停申购');
  });

  it('无限额展示为「无限额」', () => {
    const fund = buildFundLimit(row({ purchaseStatus: '开放申购', dailyLimit: '100000000000' }));
    expect(limitDisplay(fund)).toBe('无限额');
  });

  it('人民币取整、美元保留两位', () => {
    expect(limitDisplay(buildFundLimit(row({ dailyLimit: '10000.0' })))).toBe('10,000 元');
    const usd = buildFundLimit(row({ name: '某基金美元现汇', dailyLimit: '2000.5' }));
    expect(limitDisplay(usd)).toBe('2,000.50 美元');
  });
});
