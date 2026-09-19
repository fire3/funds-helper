/**
 * @funds-helper/sources —— 上游数据源适配器（IO 层）。
 *
 * 只负责「把上游响应变成结构化对象」，**不负责业务语义归一化**
 * （例如「1e11 是无限额」属于 @funds-helper/core 的职责）。
 *
 * 每个接口都拆成两个函数：
 * - `parseX(text)` —— 纯函数，可用 fixture 脱离网络测试
 * - `fetchX(client, ...)` —— IO，内部调用 parseX
 */

export * from './eastmoney/index.ts';
export * from './errors.ts';
export * from './http.ts';
