import { ParseError } from '../errors.ts';
import type { HttpClient } from '../http.ts';
import { num, record, snippet, str } from './util.ts';

/**
 * 接口 C：单只基金的「基金概况」（移动端 `FundMNDetailInformation`）。
 *
 * 与 `fund-detail.ts`（`FundMNBasicInformation`：申购状态/费率档）互为补充：
 * 这里给的是**静态档案** —— 跟踪指数、管理费/托管费/销售服务费、净资产规模与截止日、
 * 管理人/托管人/基金经理、成立日期、业绩比较基准、风险等级。
 *
 * 只在用户下钻单只基金时调用；未知代码的形态是 **HTTP 200 + `Datas: null`**，
 * 因此 `null` 是合法结果而不是解析错误。
 */

export interface FundProfileData {
  code: string;
  fullName: string | null;
  shortName: string | null;
  fundType: string | null;
  indexCode: string | null;
  indexName: string | null;
  /** 原始百分比字符串（`0.15%`）；上游用 `--` 表示不收取，已归一化为 null */
  managementFee: string | null;
  custodyFee: string | null;
  salesServiceFee: string | null;
  /** 净资产规模（元）与规模截止日 */
  netAssets: number | null;
  netAssetsDate: string | null;
  /** 场内/份额规模（元） */
  shareNetAssets: number | null;
  establishedDate: string | null;
  company: string | null;
  custodian: string | null;
  manager: string | null;
  benchmark: string | null;
  riskLevel: string | null;
}

const BASE_URL = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNDetailInformation';

export function parseFundProfile(text: string): FundProfileData | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ParseError('基金概况响应不是合法 JSON', { detail: snippet(text) });
  }

  const datas = record(record(payload)?.Datas);
  // 未知代码：HTTP 200 + Datas: null —— 不是错误，调用方按「无档案」处理
  if (!datas) return null;

  const code = str(datas.FCODE);
  if (!code) {
    throw new ParseError('基金概况响应缺少 FCODE', { detail: snippet(text) });
  }

  return {
    code,
    fullName: str(datas.FULLNAME),
    shortName: str(datas.SHORTNAME),
    fundType: str(datas.FTYPE),
    indexCode: str(datas.INDEXCODE),
    indexName: str(datas.INDEXNAME),
    managementFee: str(datas.MGREXP),
    custodyFee: str(datas.TRUSTEXP),
    salesServiceFee: str(datas.SALESEXP),
    netAssets: num(datas.ENDNAV),
    netAssetsDate: str(datas.FEGMRQ),
    shareNetAssets: num(datas.NETNAV),
    establishedDate: str(datas.ESTABDATE),
    company: str(datas.JJGS),
    custodian: str(datas.TGYH),
    manager: str(datas.JJJL),
    benchmark: str(datas.BENCH),
    riskLevel: str(datas.RISKLEVEL),
  };
}

export async function fetchFundProfile(
  client: HttpClient,
  code: string,
): Promise<FundProfileData | null> {
  const params = new URLSearchParams({
    FCODE: code,
    deviceid: 'funds-helper',
    plat: 'Android',
    product: 'EFund',
    version: '6.2.8',
  });
  const text = await client.getText(`${BASE_URL}?${params.toString()}`, {
    headers: { Referer: 'https://fund.eastmoney.com/' },
  });
  return parseFundProfile(text);
}
