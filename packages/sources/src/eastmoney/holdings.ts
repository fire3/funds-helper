import { ParseError } from '../errors.ts';
import type { HttpClient } from '../http.ts';
import { array, num, record, snippet, str } from './util.ts';

/**
 * 接口 I：重仓股 / 债券 / 底层 ETF。
 *
 * 两个易错点：
 * 1. **报告期 `Expansion` 在响应顶层**，不在 `Datas` 内
 * 2. **联接基金 `fundStocks` 为空**（它只持有 ETF），必须回退展示 `ETFCODE`
 */

export interface RawHoldingStock {
  code: string | null;
  name: string | null;
  /** 占净值比 % */
  weight: number | null;
  /** 较上期变动方向：增持 / 减持 / 新增 */
  action: string | null;
  delta: number | null;
}

export interface RawHoldingBond {
  code: string | null;
  name: string | null;
  weight: number | null;
}

export interface HoldingsData {
  stocks: RawHoldingStock[];
  bonds: RawHoldingBond[];
  /** 联接基金持有的底层 ETF */
  etf: { code: string; name: string | null } | null;
  reportDate: string | null;
}

/** 接口 I 的地址（`feeder-funds.ts` 反查目标 ETF 时复用同一次请求） */
export const HOLDINGS_URL = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition';

export function parseHoldings(text: string): HoldingsData {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ParseError('持仓响应不是合法 JSON', { detail: snippet(text) });
  }

  const root = record(payload);
  const datas = record(root?.Datas);
  if (!datas) {
    throw new ParseError('持仓响应缺少 Datas 字段', { detail: snippet(text) });
  }

  const stocks: RawHoldingStock[] = [];
  for (const raw of array(datas.fundStocks)) {
    const item = record(raw);
    if (!item) continue;
    stocks.push({
      code: str(item.GPDM),
      name: str(item.GPJC),
      weight: num(item.JZBL),
      action: str(item.PCTNVCHGTYPE),
      delta: num(item.PCTNVCHG),
    });
  }

  const bonds: RawHoldingBond[] = [];
  for (const raw of array(datas.fundboods)) {
    const item = record(raw);
    if (!item) continue;
    bonds.push({
      code: str(item.ZQDM),
      name: str(item.ZQMC),
      weight: num(item.ZJZBL),
    });
  }

  const etfCode = str(datas.ETFCODE);

  return {
    stocks,
    bonds,
    etf: etfCode ? { code: etfCode, name: str(datas.ETFSHORTNAME) } : null,
    // 报告期在响应顶层，不在 Datas 内
    reportDate: str(root?.Expansion),
  };
}

export async function fetchHoldings(client: HttpClient, code: string): Promise<HoldingsData> {
  const params = new URLSearchParams({
    FCODE: code,
    deviceid: 'funds-helper',
    plat: 'Android',
    product: 'EFund',
    version: '6.2.8',
  });
  const text = await client.getText(`${HOLDINGS_URL}?${params.toString()}`);
  return parseHoldings(text);
}
