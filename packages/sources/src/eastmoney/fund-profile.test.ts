import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError } from '../errors.ts';
import { parseFundProfile } from './fund-profile.ts';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../test/fixtures/eastmoney/etf-profile/${name}`, import.meta.url),
    'utf8',
  );
}

describe('parseFundProfile —— 接口 C（基金概况）', () => {
  it('解析跟踪指数 / 费率 / 规模 / 管理人（510300）', () => {
    const profile = parseFundProfile(fixture('detail-510300.json'));
    expect(profile).toMatchObject({
      code: '510300',
      fullName: '华泰柏瑞沪深300交易型开放式指数证券投资基金',
      shortName: '沪深300ETF华泰柏瑞',
      fundType: '指数型-股票',
      indexCode: '000300',
      indexName: '沪深300指数',
      managementFee: '0.15%',
      custodyFee: '0.05%',
      netAssetsDate: '2026-06-30',
      establishedDate: '2012-05-04',
      company: '华泰柏瑞基金',
      custodian: '工商银行',
      manager: '柳军',
      benchmark: '沪深300指数',
      riskLevel: '5',
    });
    expect(profile?.netAssets).toBeCloseTo(94_872_183_996.4, 0);
  });

  it('销售服务费为「--」时归一化为 null（不是字符串 --）', () => {
    expect(parseFundProfile(fixture('detail-510300.json'))?.salesServiceFee).toBeNull();
  });

  it('货币 ETF 没有跟踪指数（INDEXNAME = --）', () => {
    const profile = parseFundProfile(fixture('detail-511990.json'));
    expect(profile).toMatchObject({ code: '511990', indexName: null, indexCode: null });
    expect(profile?.salesServiceFee).toBe('0.01%');
  });

  it('跨境 ETF 的指数与类型照实解析（513100）', () => {
    const profile = parseFundProfile(fixture('detail-513100.json'));
    expect(profile).toMatchObject({ code: '513100', fundType: '指数型-海外股票' });
    expect(profile?.indexName).toContain('纳斯达克');
  });

  it('未知代码（Datas: null）→ null，而不是解析错误', () => {
    expect(parseFundProfile(fixture('detail-missing.json'))).toBeNull();
  });

  it('缺少 FCODE → ParseError', () => {
    expect(() => parseFundProfile('{"Datas":{"SHORTNAME":"x"}}')).toThrow(ParseError);
  });

  it('非 JSON → ParseError', () => {
    expect(() => parseFundProfile('<html>502</html>')).toThrow(ParseError);
  });
});
