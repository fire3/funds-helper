/**
 * 国际行情工具的数据源。
 *
 * 四源编排（Yahoo 主、东财 K 线备、腾讯应急、新浪 gi 第四源）+ 批量实时缺失兜底
 * 在 `../../data-sources/indices.ts` —— 与 fx 一样，工具切片只负责编排用例，
 * 不关心上游细节。
 */
export type { IndexBarFetch, IndicesDataSource } from '../../data-sources/indices.ts';
export { createIndicesDataSource } from '../../data-sources/indices.ts';
