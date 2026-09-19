import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError } from '../errors.ts';
import { parsePurchaseSnapshot } from './purchase-snapshot.ts';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../test/fixtures/eastmoney/purchase-snapshot/${name}`, import.meta.url),
    'utf8',
  );
}

describe('parsePurchaseSnapshot —— 接口 A（主数据源）', () => {
  it('从 JS 对象字面量中截取 datas 数组并解析', () => {
    const snapshot = parsePurchaseSnapshot(fixture('normal.js.txt'));
    expect(snapshot.rows).toHaveLength(8);
  });

  it('映射 13 列到具名字段', () => {
    const snapshot = parsePurchaseSnapshot(fixture('normal.js.txt'));
    const target = snapshot.rows.find((row) => row.code === '270042');
    expect(target).toMatchObject({
      code: '270042',
      name: '广发纳斯达克100ETF联接人民币(QDII)A',
      fundType: '指数型-海外股票',
      nav: '8.1177',
      navDate: '09-11',
      purchaseStatus: '限大额',
      redeemStatus: '开放赎回',
      minPurchase: '2.0',
      dailyLimit: '2.0',
      fee: '0.13%',
    });
  });

  it('空字符串归一化为 null（下一开放日 / 无费率）', () => {
    const snapshot = parsePurchaseSnapshot(fixture('normal.js.txt'));
    const openFund = snapshot.rows.find((row) => row.code === '000001');
    expect(openFund?.nextOpenDate).toBeNull();

    const etf = snapshot.rows.find((row) => row.code === '513100');
    expect(etf?.fee).toBeNull();
    expect(etf?.dailyLimit).toBe('0');
  });

  it('解析尾部 meta，showday[0] 即数据日期', () => {
    const snapshot = parsePurchaseSnapshot(fixture('normal.js.txt'));
    expect(snapshot.meta.record).toBe(27538);
    expect(snapshot.meta.pages).toBe('1');
    expect(snapshot.meta.curpage).toBe('1');
    expect(snapshot.meta.showday).toEqual(['2026-09-14', '2026-09-11']);
  });

  it('保留 QDII 两类标签（指数型-海外股票 不含 "QDII" 字样）', () => {
    const snapshot = parsePurchaseSnapshot(fixture('normal.js.txt'));
    const types = new Set(snapshot.rows.map((row) => row.fundType));
    expect(types.has('指数型-海外股票')).toBe(true);
    expect(types.has('QDII-普通股票')).toBe(true);
  });
});

describe('parsePurchaseSnapshot —— 美元份额行（币种口径的回归资产）', () => {
  it('覆盖各类美元份额写法，且「人民币」优先的反例一并保留', () => {
    const snapshot = parsePurchaseSnapshot(fixture('usd-rows.js.txt'));
    expect(snapshot.rows).toHaveLength(8);

    const names = snapshot.rows.map((row) => row.name);
    for (const marker of ['美元现汇', '美元现钞', '美汇', '美钞', '现汇', '美元']) {
      expect(names.some((name) => name.includes(marker))).toBe(true);
    }
    // 美元债主题是「人民币份额」的反例（名称含「美元」但不是美元份额）
    expect(names.filter((name) => name.includes('人民币') && name.includes('美元'))).toHaveLength(
      2,
    );
  });

  it('保留原始限额值（美元份额常为 0 或极小值，由 core 决定语义）', () => {
    const snapshot = parsePurchaseSnapshot(fixture('usd-rows.js.txt'));
    const reits = snapshot.rows.find((row) => row.code === '005615');
    expect(reits).toMatchObject({
      name: '摩根富时发达市场REITs指数(QDII)美汇',
      purchaseStatus: '限大额',
      dailyLimit: '0',
    });
  });
});

describe('parsePurchaseSnapshot —— 字段残缺的真实行', () => {
  it('个别脏行不会让整个数据集失败（实测：028912 的基金类型为空串）', () => {
    const snapshot = parsePurchaseSnapshot(fixture('sparse-rows.js.txt'));

    // 3 行里有 1 行没有基金代码 → 跳过并计数
    expect(snapshot.rows).toHaveLength(2);
    expect(snapshot.meta.skippedRows).toBe(1);
  });

  it('缺少基金类型的行照常保留（由 QDII 口径过滤，而不是解析阶段丢弃）', () => {
    const snapshot = parsePurchaseSnapshot(fixture('sparse-rows.js.txt'));
    const sparse = snapshot.rows.find((row) => row.code === '028912');
    expect(sparse).toBeDefined();
    expect(sparse?.fundType).toBe('');
    expect(sparse?.name).toBe('工银中证A500增强策略ETF发起式联接A');
    expect(sparse?.purchaseStatus).toBeNull();
  });

  it('正常响应里 skippedRows 为 0', () => {
    expect(parsePurchaseSnapshot(fixture('normal.js.txt')).meta.skippedRows).toBe(0);
  });
});

describe('parsePurchaseSnapshot —— 结构校验（上游改版必须显式暴露）', () => {
  it('缺少 datas 数组 → ParseError', () => {
    expect(() => parsePurchaseSnapshot(fixture('missing-datas.js.txt'))).toThrow(ParseError);
  });

  it('列数变更 → ParseError，并在信息里指出实际列数', () => {
    expect(() => parsePurchaseSnapshot(fixture('column-changed.js.txt'))).toThrow(/列数异常/);
  });

  it('datas 为空数组 → ParseError', () => {
    expect(() => parsePurchaseSnapshot(fixture('empty-datas.js.txt'))).toThrow(ParseError);
  });

  it('错误信息带上响应片段，便于排障', () => {
    try {
      parsePurchaseSnapshot(fixture('missing-datas.js.txt'));
      expect.unreachable('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).message).toContain('errMsg');
    }
  });
});
