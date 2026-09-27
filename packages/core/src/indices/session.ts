/**
 * 「该市场最近一个交易日」的轻量推导 —— 只服务概览的**缺失补齐**报价
 * （东财 clist 只给最新价与时间戳，没有交易日期字段）。
 *
 * 口径：**该时区的「今天」，若落在周末则回退到周五**。按注册表实测，
 * 全部市场的常规交易日都是周一~周五，所以这个近似在非节假日是准确的。
 *
 * 已知局限（有意接受，不引第三方交易日历 —— 见 `indices-tool.md`）：
 * - **节假日会标错日期**：休市日 clist 仍回上一交易日的价位，日期却写「今天」。
 *   只影响从未入库的缺失指数的概览卡片日期（数据日期逐条展示，误差可见），
 *   一旦日线链路恢复，落库数据立即纠正；
 * - 埃及（周日~周四交易）这类非常规周历市场不在注册表内，将来加入时需扩展本函数。
 *
 * 时区换算用 `Intl.DateTimeFormat`（formatter 按时区缓存 —— 构造成本高，
 * 与 `sources/indices/yahoo.ts` 的做法一致）。
 */

interface ZoneFormatters {
  /** en-CA 直出 YYYY-MM-DD */
  date: Intl.DateTimeFormat;
  /** 同一时刻的 parts（weekday 单独取，format 整串会带日期） */
  parts: Intl.DateTimeFormat;
}

const formatterCache = new Map<string, ZoneFormatters>();

/** 构造失败（时区名非法）会抛 RangeError —— 调用方 try/catch 回退 UTC */
function formatters(timeZone: string): ZoneFormatters {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const options = {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  } satisfies Intl.DateTimeFormatOptions;
  const pair: ZoneFormatters = {
    date: new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }),
    parts: new Intl.DateTimeFormat('en-CA', options),
  };
  formatterCache.set(timeZone, pair);
  return pair;
}

/** YYYY-MM-DD 字符串做日历减法（按 UTC 避免夏令时边界问题） */
function shiftDate(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 返回 `nowMs` 时刻在 `timeZone` 时区下的「最近交易日（周一~周五）」，格式 YYYY-MM-DD。
 *
 * 例：2026-09-27（周日）任何时区 → 2026-09-25；周五当天 → 当天。
 */
export function latestWeekdayDateInZone(nowMs: number, timeZone: string): string {
  const now = new Date(nowMs);
  let pair: ZoneFormatters;
  try {
    pair = formatters(timeZone);
  } catch {
    pair = formatters('UTC');
  }

  const date = pair.date.format(now);
  const weekday = pair.parts.formatToParts(now).find((part) => part.type === 'weekday')?.value;
  if (weekday === 'Sat') return shiftDate(date, -1);
  if (weekday === 'Sun') return shiftDate(date, -2);
  return date;
}
