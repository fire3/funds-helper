/**
 * 国际指数数据源适配器。
 *
 * Yahoo（主）、东财 K 线（备）、腾讯（应急）、新浪 gi 日线（第四源）
 * 各自独立成模块，外加东财 clist 批量实时（概览缺失兜底）；
 * **谁主谁备的编排在服务端**（`apps/server/src/data-sources/indices.ts`）——
 * sources 只负责「把一个上游的响应变成结构化对象」，与 `fx` 的分层一致。
 */

export * from './eastmoney.ts';
export * from './eastmoney-clist.ts';
export * from './sina.ts';
export * from './tencent.ts';
export * from './yahoo.ts';
