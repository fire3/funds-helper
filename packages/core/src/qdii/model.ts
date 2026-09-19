/**
 * QDII 切片的领域模型转发。
 *
 * 模型本身是**通用基金概念**，已上移到 `../fund/model.ts`（第二个工具「美元份额」共用）。
 * 这里保留转发，使 QDII 内部与既有测试的 `./model.ts` 引用无需改动。
 */
export * from '../fund/model.ts';
