/**
 * ETF 工具的数据源。
 *
 * 直接复用共享的东方财富数据能力（`../../data-sources/eastmoney.ts`）——
 * ETF 行情（接口 A）、ETF 目录（接口 B）、基金概况（接口 C）都在那里，
 * 工具切片只负责编排。
 */
export type { EastmoneyFundDataSource as EtfDataSource } from '../../data-sources/eastmoney.ts';
export { createEastmoneyDataSource } from '../../data-sources/eastmoney.ts';
