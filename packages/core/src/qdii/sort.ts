/**
 * QDII 切片的排序转发。
 *
 * 额度排序与分档是**通用基金概念**，已上移到 `../fund/sort.ts`（美元份额工具共用）。
 * 这里保留转发，使 QDII 内部与既有测试的 `./sort.ts` 引用无需改动。
 */
export * from '../fund/sort.ts';
