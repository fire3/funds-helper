import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DISCLAIMER, FreshnessSchema } from './envelope.ts';
import { PurchaseStatusSchema } from './fund.ts';
import { QdiiDatasetResponseSchema } from './qdii.ts';
import { TOOL_CATALOG, TOOL_DESCRIPTORS, ToolDescriptorSchema } from './tool.ts';
import { UsdDatasetResponseSchema } from './usd.ts';

describe('工具目录', () => {
  it('每个描述符都符合 schema', () => {
    for (const descriptor of TOOL_DESCRIPTORS) {
      expect(() => ToolDescriptorSchema.parse(descriptor)).not.toThrow();
    }
  });

  it('id 全局唯一', () => {
    const ids = TOOL_DESCRIPTORS.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('qdii 工具已登记且状态为 ready', () => {
    expect(TOOL_CATALOG.qdii.id).toBe('qdii');
    expect(TOOL_CATALOG.qdii.status).toBe('ready');
    expect(TOOL_CATALOG.qdii.question).toContain('今天还能买多少');
  });

  it('usd 工具已登记且状态为 ready', () => {
    expect(TOOL_CATALOG.usd.id).toBe('usd');
    expect(TOOL_CATALOG.usd.status).toBe('ready');
    expect(TOOL_CATALOG.usd.question).toContain('美元');
  });

  it('描述符的必填字段不含空串（避免界面上出现空白卡片）', () => {
    for (const descriptor of TOOL_DESCRIPTORS) {
      expect(descriptor.name.length).toBeGreaterThan(0);
      expect(descriptor.summary.length).toBeGreaterThan(0);
      expect(descriptor.version.length).toBeGreaterThan(0);
    }
  });
});

describe('传输契约 schema', () => {
  it('申购状态只接受已知取值', () => {
    expect(PurchaseStatusSchema.safeParse('限大额').success).toBe(true);
    expect(PurchaseStatusSchema.safeParse('某个新状态').success).toBe(false);
  });

  it('数据集响应缺少必要字段时校验失败（防止服务端悄悄改变结构）', () => {
    const result = QdiiDatasetResponseSchema.safeParse({ total: 1 });
    expect(result.success).toBe(false);
  });

  it('usd 数据集响应缺少必要字段时校验失败', () => {
    expect(UsdDatasetResponseSchema.safeParse({ total: 1 }).success).toBe(false);
  });

  it('新鲜度 schema 要求 stale 字段（降级必须显式表达）', () => {
    expect(FreshnessSchema.safeParse({ dataDate: null, fetchedAt: 'x', source: 'y' }).success).toBe(
      false,
    );
    expect(
      FreshnessSchema.safeParse({ dataDate: null, fetchedAt: 'x', source: 'y', stale: false })
        .success,
    ).toBe(true);
  });

  it('免责声明非空', () => {
    expect(DISCLAIMER.length).toBeGreaterThan(0);
  });
});

describe('schema 可被推导为 zod 类型', () => {
  it('导出的是 zod schema 实例（前端用它解析响应）', () => {
    expect(ToolDescriptorSchema).toBeInstanceOf(z.ZodType);
  });
});
