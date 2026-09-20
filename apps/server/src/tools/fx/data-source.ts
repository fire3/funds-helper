/**
 * 汇率工具的数据源。
 *
 * 直接复用共享的新浪财经数据能力（`../../data-sources/sina.ts`）——
 * 汇率日线的抓取与解析都在那里，工具切片只负责编排。
 */
export type { SinaFxDataSource as FxDataSource } from '../../data-sources/sina.ts';
export { createSinaFxDataSource } from '../../data-sources/sina.ts';
