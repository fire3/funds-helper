/**
 * QDII 切片的数据源转发。
 *
 * 上游能力本身与 QDII 无关，已上移到 `../../data-sources/eastmoney.ts`
 * （「美元份额」工具共用同一份）。这里保留转发与旧别名，使 QDII 内部与既有测试
 * 的 `./data-source.ts` / `QdiiDataSource` 引用无需改动。
 */

export type { EastmoneyFundDataSource as QdiiDataSource } from '../../data-sources/eastmoney.ts';
export * from '../../data-sources/eastmoney.ts';
