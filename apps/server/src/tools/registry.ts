import { type CreateEtfToolOptions, createEtfTool } from './etf/index.ts';
import { type CreateFxToolOptions, createFxTool } from './fx/index.ts';
import { type CreateQdiiToolOptions, createQdiiTool } from './qdii/index.ts';
import type { ServerTool } from './types.ts';
import { type CreateUsdToolOptions, createUsdTool } from './usd/index.ts';

/**
 * 工具注册表 —— 唯一需要手改的「框架文件」。
 *
 * 刻意不使用 `import.meta.glob` 之类的自动发现：显式注册能获得完整的类型检查
 * 与「这个工具被谁引用」的可追踪性，代价只是每次加一行。
 */
export function createServerTools(
  options: {
    qdii?: CreateQdiiToolOptions;
    usd?: CreateUsdToolOptions;
    fx?: CreateFxToolOptions;
    etf?: CreateEtfToolOptions;
  } = {},
): ServerTool[] {
  return [
    createQdiiTool(options.qdii ?? {}),
    createUsdTool(options.usd ?? {}),
    createFxTool(options.fx ?? {}),
    createEtfTool(options.etf ?? {}),
  ];
}
