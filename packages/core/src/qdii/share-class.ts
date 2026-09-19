/**
 * QDII 切片的份额类别转发。
 *
 * 份额家族识别是**通用基金概念**，已上移到 `../fund/share-class.ts`（美元份额工具共用）。
 * 这里保留转发，使 QDII 内部与既有测试的 `./share-class.ts` 引用无需改动。
 */
export * from '../fund/share-class.ts';
