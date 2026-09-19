/**
 * 美元份额工具的数据源。
 *
 * 直接复用共享的东方财富数据能力（`../../data-sources/eastmoney.ts`）——
 * 全市场快照、详情、公告、净值、阶段涨幅、持仓都在那里。
 */
export type { EastmoneyFundDataSource as UsdDataSource } from '../../data-sources/eastmoney.ts';
export { createEastmoneyDataSource } from '../../data-sources/eastmoney.ts';
