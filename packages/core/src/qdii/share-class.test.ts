import { describe, expect, it } from 'vitest';
import { findSiblingShareClasses, shareClassKey, shareClassLetter } from './share-class.ts';

describe('shareClassKey —— 归一化成「份额家族键」', () => {
  it('剥离 (QDII) 与结尾类别字母', () => {
    expect(shareClassKey('广发纳斯达克100ETF联接人民币(QDII)A')).toBe('广发纳斯达克100ETF联接');
    expect(shareClassKey('广发纳斯达克100ETF联接人民币(QDII)C')).toBe('广发纳斯达克100ETF联接');
  });

  it('同一基金的 A/C 份额得到相同键', () => {
    expect(shareClassKey('大成纳斯达克100ETF联接(QDII)A')).toBe(
      shareClassKey('大成纳斯达克100ETF联接(QDII)C'),
    );
  });

  it('币种不同的份额归入同一家族（用户需要把外币份额并列比较）', () => {
    const cny = shareClassKey('广发纳斯达克100ETF联接人民币(QDII)A');
    const usd = shareClassKey('广发纳斯达克100ETF联接美元(QDII)A');
    expect(cny).toBe(usd);
  });

  it('不同公司的同名指数基金不会被错并', () => {
    expect(shareClassKey('广发纳斯达克100ETF联接(QDII)A')).not.toBe(
      shareClassKey('大成纳斯达克100ETF联接(QDII)A'),
    );
  });

  it('剥离括号内的人民币/LOF/ETF 等限定词', () => {
    expect(shareClassKey('华夏全球股票(QDII)(人民币)')).toBe('华夏全球股票');
    expect(shareClassKey('华宝海外科技股票(QDII-LOF)A')).toBe('华宝海外科技股票');
  });
});

describe('shareClassLetter', () => {
  it('取结尾类别字母', () => {
    expect(shareClassLetter('博时标普500ETF联接A')).toBe('A');
    expect(shareClassLetter('广发纳斯达克100ETF联接人民币(QDII)C')).toBe('C');
  });

  it('无类别字母时返回 null', () => {
    expect(shareClassLetter('纳指ETF国泰')).toBeNull();
  });
});

describe('findSiblingShareClasses', () => {
  const currencyOf = (item: { name: string }) =>
    item.name.includes('美元') ? 'USD' : item.name.includes('人民币') ? 'CNY' : 'CNY';

  const all = [
    { code: '270042', name: '广发纳斯达克100ETF联接人民币(QDII)A' },
    { code: '006479', name: '广发纳斯达克100ETF联接人民币(QDII)C' },
    { code: '000834', name: '大成纳斯达克100ETF联接(QDII)A' },
    { code: '001234', name: '广发纳斯达克100ETF联接美元(QDII)A' },
  ];

  it('只返回同家族、不含自己', () => {
    const siblings = findSiblingShareClasses(all[0]!, all, currencyOf);
    expect(siblings.map((s) => s.code)).toEqual(['006479', '001234']);
  });

  it('同币种的兄弟排在前（那才是用户会去比较的对象）', () => {
    const siblings = findSiblingShareClasses(all[0]!, all, currencyOf);
    expect(siblings[0]?.code).toBe('006479'); // 人民币 C 在前，美元 A 在后
  });

  it('没有兄弟份额时返回空数组', () => {
    const target = all[2]!;
    expect(findSiblingShareClasses(target, all, currencyOf)).toEqual([]);
  });

  it('尊重 limit 上限', () => {
    const siblings = findSiblingShareClasses(all[0]!, all, currencyOf, 1);
    expect(siblings).toHaveLength(1);
  });
});
