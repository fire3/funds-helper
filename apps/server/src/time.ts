/**
 * 时间工具。
 *
 * 上游的数据日期是「北京时间零点」，接口 A 的 `showday` 缺失时才需要本地兜底，
 * 因此必须按 UTC+8 换算，不能依赖进程本地时区。
 */
export function todayInShanghai(now: number): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}
