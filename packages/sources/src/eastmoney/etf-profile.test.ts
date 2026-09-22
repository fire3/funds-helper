import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError } from '../errors.ts';
import type { HttpClient } from '../http.ts';
import { fetchEtfProfiles, parseEtfProfilePage } from './etf-profile.ts';

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../test/fixtures/eastmoney/etf-profile/${name}`, import.meta.url),
    'utf8',
  );
}

function stubClient(handler: (url: string) => string | Error): HttpClient {
  return {
    getText: async (url: string) => {
      const result = handler(url);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as HttpClient;
}

function profileRow(code: string): string {
  return JSON.stringify({
    SECURITY_CODE: code,
    SECURITY_NAME_ABBR: `样例${code}`,
    INDEX_NAME: '上证指数',
    IS_KJETF: 1,
  });
}

describe('parseEtfProfilePage —— 接口 B（ETF 目录）', () => {
  it('解析 count / pages / 行', () => {
    const page = parseEtfProfilePage(fixture('list.json'));
    expect(page.count).toBe(1675);
    expect(page.pages).toBe(2);
    expect(page.rows).toHaveLength(8);
  });

  it('标志位 0/1 → boolean，且六类互斥 + 风格叠加', () => {
    const page = parseEtfProfilePage(fixture('list.json'));
    const byCode = new Map(page.rows.map((row) => [row.code, row]));

    // 510300 宽基、513100 跨境、511990 货币、159985 商品、512880 行业主题
    expect(byCode.get('510300')).toMatchObject({ broad: true, industry: false, money: false });
    expect(byCode.get('513100')).toMatchObject({ crossBorder: true, broad: false });
    expect(byCode.get('511990')).toMatchObject({ money: true });
    expect(byCode.get('159985')).toMatchObject({ commodity: true });
    expect(byCode.get('512880')).toMatchObject({ industry: true, broad: false });
    expect(byCode.get('158000')).toMatchObject({ crossBorder: true });
  });

  it('跟踪指数与代码（510300 → 沪深300）', () => {
    const page = parseEtfProfilePage(fixture('list.json'));
    const target = page.rows.find((row) => row.code === '510300');
    expect(target).toMatchObject({ indexCode: '000300', indexName: '沪深300' });
  });

  it('货币 ETF 的跟踪指数是「7天通知存款利率」而不是空（照实下发）', () => {
    const page = parseEtfProfilePage(fixture('list.json'));
    expect(page.rows.find((row) => row.code === '511990')?.indexName).toBe('7天通知存款利率');
  });

  it('数值字段：区间涨跌 / 最大回撤 / 规模(亿元) / 份额', () => {
    const page = parseEtfProfilePage(fixture('list.json'));
    const target = page.rows.find((row) => row.code === '510300');
    expect(target?.change1w).toBeCloseTo(1.39, 2);
    expect(target?.maxDrawdown1y).toBeCloseTo(-11.173788389897, 6);
    // DEC_NAV 单位是亿元：1093.7 亿 × 份额 237.1 亿份 ≈ 场内规模
    expect(target?.netAssetsYi).toBeCloseTo(1093.699, 3);
    expect(target?.shares).toBe(23713687700);
  });

  it('次新 ETF 的区间涨跌为 null（已按可空处理，不写成 0）', () => {
    const page = parseEtfProfilePage(fixture('list.json'));
    expect(page.rows.find((row) => row.code === '158000')?.change3m).toBeNull();
    expect(page.rows.find((row) => row.code === '158000')?.ytdChange).toBeNull();
  });

  it('result 为 null（空报表）→ 空页而不是报错', () => {
    expect(parseEtfProfilePage('{"version":"x","result":null}')).toEqual({
      count: 0,
      pages: 0,
      rows: [],
    });
  });

  it('缺少代码或名称的行被跳过', () => {
    const text = `{"result":{"count":2,"pages":1,"data":[{"SECURITY_NAME_ABBR":"没有代码"},${profileRow('510300')}]}}`;
    const page = parseEtfProfilePage(text);
    expect(page.rows.map((row) => row.code)).toEqual(['510300']);
  });

  it('缺少 result.data 数组 / 非 JSON → ParseError', () => {
    expect(() => parseEtfProfilePage('{"result":{"count":1}}')).toThrow(ParseError);
    expect(() => parseEtfProfilePage('not json')).toThrow(ParseError);
  });

  it('count 超过护栏 → ParseError', () => {
    expect(() => parseEtfProfilePage('{"result":{"count":999999,"data":[]}}')).toThrow(ParseError);
  });
});

describe('fetchEtfProfiles —— 翻页', () => {
  it('按 pages 翻完，并按代码去重', async () => {
    const page1 = `{"result":{"count":1001,"pages":2,"data":[${Array.from(
      { length: 1000 },
      (_, index) => profileRow(String(index).padStart(6, '0')),
    ).join(',')}]}}`;
    const page2 = `{"result":{"count":1001,"pages":2,"data":[${profileRow('510300')},${profileRow('510300')}]}}`;

    let calls = 0;
    const client = stubClient(() => (calls++ === 0 ? page1 : page2));
    const rows = await fetchEtfProfiles(client);

    expect(calls).toBe(2);
    expect(rows).toHaveLength(1001);
  });

  it('一页取完（不足 pageSize）就不再翻页', async () => {
    let calls = 0;
    const client = stubClient(() => {
      calls += 1;
      return fixture('list.json');
    });
    await fetchEtfProfiles(client);
    expect(calls).toBe(1);
  });

  it('完全取不到行 → ParseError', async () => {
    const client = stubClient(() => '{"result":null}');
    await expect(fetchEtfProfiles(client)).rejects.toThrow(ParseError);
  });
});
