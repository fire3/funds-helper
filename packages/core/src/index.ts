/**
 * @funds-helper/core —— 领域逻辑（纯函数）。
 *
 * 本包**不得**依赖数据库、HTTP 框架或任何 IO。它是「一个口径」的唯一保证：
 * 服务端任务、API、前端与测试都以完全相同的方式调用这些规则。
 */
export * from './etf/index.ts';
export * from './fund/code.ts';
export * from './fund/nav.ts';
export * from './fx/index.ts';
export * from './news/index.ts';
export * from './qdii/index.ts';
export * from './usd/index.ts';
