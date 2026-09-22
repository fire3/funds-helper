import { describe, expect, it } from 'vitest';
import { isFeederFundName } from './feeder.ts';

describe('isFeederFundName', () => {
  it('识别标准的 ETF 联接基金（含发起式 / 各类份额后缀）', () => {
    for (const name of [
      '嘉实中证500ETF联接A',
      '华安纳斯达克100ETF联接(QDII)A美元现钞',
      '广发上证科创板成长ETF发起式联接A',
      '景顺长城纳斯达克科技ETF联接(QDII)E人民币',
      '南方富时中国国企开放共赢ETF发起联接I',
    ]) {
      expect(isFeederFundName(name)).toBe(true);
    }
  });

  it('名称省略了「ETF」的联接基金也算（实测这 50 只同样是 ETF 联接）', () => {
    // 000942 广发信息技术联接A → 159939 信息技术ETF广发
    expect(isFeederFundName('广发信息技术联接A')).toBe(true);
    // 011608 易方达上证科创50联接A → 588080 科创50ETF易方达
    expect(isFeederFundName('易方达上证科创50联接A')).toBe(true);
    // 161211 国投沪深300金融地产联接 → 159933 金融地产ETF国投瑞银
    expect(isFeederFundName('国投沪深300金融地产联接')).toBe(true);
  });

  it('普通指数基金 / ETF 本身不算候选', () => {
    for (const name of [
      '华夏成长混合',
      '沪深300ETF华泰柏瑞',
      '易方达蓝筹精选混合',
      '招商中证白酒指数(LOF)A',
    ]) {
      expect(isFeederFundName(name)).toBe(false);
    }
  });
});
