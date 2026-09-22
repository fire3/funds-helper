/**
 * 场外联接基金的**名称判定**（纯函数）。
 *
 * 用途：反查「ETF → 场外联接基金」时，必须先从全市场基金里挑出候选池
 * （接口 I 只能按代码查，见 `docs/design/etf-tool.md` §11）。
 *
 * 口径是「名称含**联接**」，**不是**「含 ETF 联接」——
 * 实测 2319 只含「联接」的基金里有 50 只名称不含「ETF」，但它们同样是 ETF 联接基金
 * （简称省略了 ETF）：如 `000942 广发信息技术联接A` → `159939 信息技术ETF广发`、
 * `011608 易方达上证科创50联接A` → `588080 科创50ETF易方达`。
 * 反过来说，用「含 ETF 联接」筛会漏掉这 50 只，而它们对应的 ETF 在目录里是存在的。
 *
 * 这是**候选池**判定而不是最终结论：是否是联接基金由上游（接口 I 的目标 ETF 字段）确认，
 * 名称判定只决定「值不值得多打一个请求」。
 */

/** 联接基金名称里必然出现的字样 */
export const FEEDER_FUND_NAME_MARK = '联接';

export function isFeederFundName(name: string): boolean {
  return name.includes(FEEDER_FUND_NAME_MARK);
}
