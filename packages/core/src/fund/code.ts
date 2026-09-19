/** 基金代码：6 位数字 */
const FUND_CODE = /^\d{6}$/;

export function isFundCode(value: string): boolean {
  return FUND_CODE.test(value);
}
