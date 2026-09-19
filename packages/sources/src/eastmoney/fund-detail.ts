import { ParseError } from '../errors.ts';
import type { HttpClient } from '../http.ts';
import { record, snippet, str } from './util.ts';

/**
 * 接口 B：单基金实时信息（移动端）。
 * `FSRQ` 带完整年份（优于接口 A 的 MM-DD），且含公司/经理/费率/风险等级。
 * 只在用户下钻单只基金时按需调用。
 */

export interface FundDetailData {
  code: string;
  name: string | null;
  fundType: string | null;
  purchaseStatus: string | null;
  redeemStatus: string | null;
  minPurchase: string | null;
  maxPurchase: string | null;
  nav: string | null;
  navDate: string | null;
  nextOpenDate: string | null;
  sourceRate: string | null;
  rate: string | null;
  company: string | null;
  manager: string | null;
  riskLevel: string | null;
}

const BASE_URL = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation';

export function parseFundDetail(text: string): FundDetailData {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ParseError('基金详情响应不是合法 JSON', { detail: snippet(text) });
  }

  const datas = record(record(payload)?.Datas);
  if (!datas) {
    throw new ParseError('基金详情响应缺少 Datas 字段', { detail: snippet(text) });
  }

  return {
    code: str(datas.FCODE) ?? '',
    name: str(datas.SHORTNAME),
    fundType: str(datas.FTYPE),
    purchaseStatus: str(datas.SGZT),
    redeemStatus: str(datas.SHZT),
    minPurchase: str(datas.MINSG),
    maxPurchase: str(datas.MAXSG),
    nav: str(datas.DWJZ),
    navDate: str(datas.FSRQ),
    // 上游用 "--" 表示无下一开放日，str() 会归一化为 null
    nextOpenDate: str(datas.DUEDATE),
    sourceRate: str(datas.SOURCERATE),
    rate: str(datas.RATE),
    company: str(datas.JJGS),
    manager: str(datas.JJJL),
    riskLevel: str(datas.RISKLEVEL),
  };
}

export async function fetchFundDetail(client: HttpClient, code: string): Promise<FundDetailData> {
  const params = new URLSearchParams({
    FCODE: code,
    deviceid: 'funds-helper',
    plat: 'Android',
    product: 'EFund',
    version: '6.2.8',
  });
  const url = `${BASE_URL}?${params.toString()}`;
  const text = await client.getText(url, {
    headers: { Referer: 'https://fund.eastmoney.com/' },
  });
  return parseFundDetail(text);
}
