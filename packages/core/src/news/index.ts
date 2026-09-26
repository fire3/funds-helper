/**
 * `news` 工具的领域逻辑：canonical 化 / 去重 / 预算 / 提示词渲染 / 引用校验。
 *
 * 全部是纯函数 —— 抓取是 IO（sources）、编排是 server、渲染是 UI，
 * 「从 214 条里挑 187 条、每条引用必须指向真实条目」是**口径**，必须可单测。
 */
export * from './budget.ts';
export * from './canonicalize.ts';
export * from './citations.ts';
export * from './dedupe.ts';
export * from './model.ts';
export * from './prompt.ts';
