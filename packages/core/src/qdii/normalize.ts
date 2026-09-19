/**
 * QDII 切片的归一化转发 + QDII 专有的类型口径判定。
 *
 * 通用归一化（哨兵值 / 0 的三义 / 份额币种）已上移到 `../fund/normalize.ts`，
 * 第二个工具「美元份额」直接复用它。这里只保留专属于 QDII 的 `isQdii`。
 */
export * from '../fund/normalize.ts';

/**
 * QDII 识别（**最容易出错的地方**）。
 *
 * 上游把 QDII 分散在两类标签中：`QDII-*`（370 只）与 `指数型-海外股票`（365 只）。
 * 后者**不含 "QDII" 字样**，用 `includes('QDII')` 会漏掉一半，
 * 包括 `270042 广发纳斯达克100ETF联接人民币(QDII)A` 这类最主流的标的。
 */
export function isQdii(fundType: string): boolean {
  return fundType.startsWith('QDII-') || fundType === '指数型-海外股票';
}
