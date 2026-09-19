import type { ToolDescriptor } from '@funds-helper/shared';
import { type ComponentType, type LazyExoticComponent, lazy } from 'react';

export interface WebTool {
  descriptor: ToolDescriptor;
  /** 懒加载页面。框架统一挂在 /tools/{id}/* 下（与后端 /api/tools/{id} 对齐） */
  page: LazyExoticComponent<ComponentType>;
}

/**
 * 前端工具注册表 —— 新增工具只加一行。
 *
 * 描述符来自 `@funds-helper/shared` 的 TOOL_CATALOG（与服务端同源），
 * 而不是各自手写一份，避免两处漂移。
 */
export const WEB_TOOLS: WebTool[] = [
  {
    descriptor: {
      id: 'qdii',
      name: 'QDII 额度',
      summary: '限购现状 · 额度排序 · 场内溢价',
      question: '我想买的这只 QDII，今天还能买多少？',
      status: 'ready',
      version: '0.1.0',
      dataFreshness: 'daily',
      tags: ['QDII', '限购', '额度', '场内溢价'],
    },
    page: lazy(() => import('./qdii/page.tsx')),
  },
];

export function findWebTool(id: string | undefined): WebTool | undefined {
  return WEB_TOOLS.find((tool) => tool.descriptor.id === id);
}
