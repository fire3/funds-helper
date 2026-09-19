import { z } from 'zod';

/**
 * 工具描述符：前后端共享的工具元数据。
 * 服务端用它生成 /api/tools，前端用它生成侧边栏导航与首页卡片墙。
 * 单一事实来源 —— 两端都从这里取，禁止各自手写一份（否则会漂移）。
 */

export const ToolStatusSchema = z.enum(['ready', 'beta', 'planned']);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

/** 数据时效性：决定顶栏如何提示用户 */
export const DataFreshnessKindSchema = z.enum(['realtime', 'daily', 'ondemand']);
export type DataFreshnessKind = z.infer<typeof DataFreshnessKindSchema>;

export const ToolDescriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().min(1),
  /** 该工具回答的用户问题，用于首页卡片 */
  question: z.string().min(1),
  status: ToolStatusSchema,
  version: z.string().min(1),
  dataFreshness: DataFreshnessKindSchema,
  tags: z.array(z.string()),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

const QDII: ToolDescriptor = {
  id: 'qdii',
  name: 'QDII 额度',
  summary: '限购现状 · 额度排序 · 场内溢价',
  question: '我想买的这只 QDII，今天还能买多少？',
  status: 'ready',
  version: '0.1.0',
  dataFreshness: 'daily',
  tags: ['QDII', '限购', '额度', '场内溢价'],
};

const USD: ToolDescriptor = {
  id: 'usd',
  name: '美元份额',
  summary: '全市场美元份额 · 可申购筛选 · 渠道提示',
  question: '我想用美元买基金，全市场有哪些美元份额、现在还能不能买？',
  status: 'ready',
  version: '0.1.0',
  dataFreshness: 'daily',
  tags: ['美元', '现汇', '现钞', 'QDII'],
};

export const TOOL_CATALOG = {
  qdii: QDII,
  usd: USD,
} as const;

export const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = Object.values(TOOL_CATALOG);

export function getToolDescriptor(id: string): ToolDescriptor | undefined {
  return TOOL_DESCRIPTORS.find((tool) => tool.id === id);
}

export const ToolListResponseSchema = z.object({
  tools: z.array(ToolDescriptorSchema),
});
export type ToolListResponse = z.infer<typeof ToolListResponseSchema>;
