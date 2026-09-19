import { TOOL_DESCRIPTORS, type ToolDescriptor } from '@funds-helper/shared';
import type { FastifyInstance } from 'fastify';
import type { ServerTool } from '../tools/types.ts';

/** 工具清单：前端据此渲染侧边栏与首页卡片墙 */
export function registerToolRoutes(app: FastifyInstance, tools: readonly ServerTool[]): void {
  app.get('/api/tools', () => {
    // 以注册表为准（服务端才是真相），同时校验与 shared 目录的一致性
    const registered = new Map<string, ToolDescriptor>(
      tools.map((tool) => [tool.descriptor.id, tool.descriptor]),
    );

    return {
      tools: TOOL_DESCRIPTORS.map((descriptor) => registered.get(descriptor.id) ?? descriptor),
    };
  });
}
