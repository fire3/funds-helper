import type { ChangeItem } from '@funds-helper/shared';
import { describe, expect, it } from 'vitest';
import {
  CHANGE_FIELD_LABELS,
  type ChangeFilters,
  changesSummary,
  changeValueText,
  DEFAULT_CHANGE_FILTERS,
  directionLabel,
  filterChanges,
  groupChanges,
  refineChanges,
} from './changes-filters.ts';

function change(overrides: Partial<ChangeItem> = {}): ChangeItem {
  return {
    code: '270042',
    name: '广发纳斯达克100ETF联接人民币(QDII)A',
    dataDate: '2026-09-20',
    detectedAt: '2026-09-20T02:00:00.000Z',
    field: 'daily_limit',
    oldValue: '100',
    newValue: '2',
    direction: 'tightened',
    ...overrides,
  };
}

function filters(overrides: Partial<ChangeFilters> = {}): ChangeFilters {
  return { ...DEFAULT_CHANGE_FILTERS, ...overrides };
}

/** 270042 三次变更 / 000834 一次 / 050025 两次 */
const SAMPLE: ChangeItem[] = [
  change({ dataDate: '2026-09-12', detectedAt: '2026-09-12T02:00:00.000Z', oldValue: '1000' }),
  change({
    dataDate: '2026-09-15',
    detectedAt: '2026-09-15T02:00:00.000Z',
    field: 'status',
    oldValue: '开放申购',
    newValue: '限大额',
  }),
  change({ dataDate: '2026-09-20', detectedAt: '2026-09-20T02:00:00.000Z' }),
  change({
    code: '000834',
    name: '大成纳斯达克100ETF联接(QDII)A',
    dataDate: '2026-09-18',
    detectedAt: '2026-09-18T02:00:00.000Z',
    oldValue: null,
    newValue: '10',
  }),
  change({
    code: '050025',
    name: '博时标普500ETF联接A',
    dataDate: '2026-09-14',
    detectedAt: '2026-09-14T02:00:00.000Z',
    field: 'status',
    oldValue: '暂停申购',
    newValue: '限大额',
    direction: 'loosened',
  }),
  change({
    code: '050025',
    name: '博时标普500ETF联接A',
    dataDate: '2026-09-24',
    detectedAt: '2026-09-24T02:00:00.000Z',
    oldValue: '100',
    newValue: '1000',
    direction: 'loosened',
  }),
];

describe('filterChanges', () => {
  it('按方向筛选', () => {
    const tightened = filterChanges(SAMPLE, filters({ direction: 'tightened' }));
    expect(tightened.every((item) => item.direction === 'tightened')).toBe(true);
    expect(tightened).toHaveLength(4);

    expect(filterChanges(SAMPLE, filters({ direction: 'loosened' }))).toHaveLength(2);
  });

  it('按字段筛选', () => {
    const status = filterChanges(SAMPLE, filters({ field: 'status' }));
    expect(status.map((item) => item.code).sort()).toEqual(['050025', '270042']);

    expect(filterChanges(SAMPLE, filters({ field: 'daily_limit' }))).toHaveLength(4);
  });

  it('按代码或名称搜索，大小写不敏感', () => {
    expect(filterChanges(SAMPLE, filters({ keyword: '000834' }))).toHaveLength(1);
    expect(filterChanges(SAMPLE, filters({ keyword: 'etf' }))).toHaveLength(6);
    expect(filterChanges(SAMPLE, filters({ keyword: '  纳斯达克  ' }))).toHaveLength(4);
  });

  it('多维度取交集', () => {
    const result = filterChanges(SAMPLE, filters({ direction: 'loosened', field: 'status' }));
    expect(result.map((item) => item.code)).toEqual(['050025']);
  });
});

describe('groupChanges', () => {
  it('同基金归为一组并统计收紧/放宽次数', () => {
    const groups = groupChanges(SAMPLE);
    const target = groups.find((group) => group.code === '270042');
    expect(target?.items).toHaveLength(3);
    expect(target?.tightened).toBe(3);
    expect(target?.loosened).toBe(0);

    const loosened = groups.find((group) => group.code === '050025');
    expect(loosened).toMatchObject({ tightened: 0, loosened: 2 });
  });

  it('组内按日期倒序，最近一次在最上', () => {
    const target = groupChanges(SAMPLE).find((group) => group.code === '270042');
    expect(target?.items.map((item) => item.dataDate)).toEqual([
      '2026-09-20',
      '2026-09-15',
      '2026-09-12',
    ]);
  });

  it('组间按最近一次变更倒序', () => {
    expect(groupChanges(SAMPLE).map((group) => group.code)).toEqual([
      '050025', // 09-24
      '270042', // 09-20
      '000834', // 09-18
    ]);
  });

  it('单条变更也独立成组', () => {
    const groups = groupChanges(SAMPLE);
    expect(groups).toHaveLength(3);
    expect(groups.find((group) => group.code === '000834')?.items).toHaveLength(1);
  });

  it('空输入返回空数组', () => {
    expect(groupChanges([])).toEqual([]);
  });

  it('不修改入参数组的顺序', () => {
    const original = [...SAMPLE];
    groupChanges(SAMPLE);
    expect(SAMPLE).toEqual(original);
  });
});

describe('refineChanges', () => {
  it('multiOnly 只保留变更次数 >= 2 的基金', () => {
    const groups = refineChanges(SAMPLE, filters({ multiOnly: true }));
    expect(groups.map((group) => group.code)).toEqual(['050025', '270042']);
    expect(groups.every((group) => group.items.length >= 2)).toBe(true);
  });

  it('先过滤再分组，multiOnly 依据过滤后的条数判断', () => {
    // 只看放宽后，270042 的三条全被滤掉 → 不再是「多次变更」
    const groups = refineChanges(SAMPLE, filters({ direction: 'loosened', multiOnly: true }));
    expect(groups.map((group) => group.code)).toEqual(['050025']);
  });

  it('默认不做 multiOnly 约束', () => {
    expect(refineChanges(SAMPLE, filters())).toHaveLength(3);
  });
});

describe('changesSummary', () => {
  it('按事件数统计收紧/放宽，按基金数统计涉及与多次变更', () => {
    const summary = changesSummary(groupChanges(SAMPLE));
    expect(summary).toEqual({ tightened: 4, loosened: 2, funds: 3, multi: 2 });
  });

  it('空输入全为 0', () => {
    expect(changesSummary([])).toEqual({ tightened: 0, loosened: 0, funds: 0, multi: 0 });
  });
});

describe('changeValueText', () => {
  it('金额字段补「元」', () => {
    expect(changeValueText('daily_limit', '100')).toBe('100 元');
    expect(changeValueText('min_purchase', '10')).toBe('10 元');
  });

  it('null 按字段语义化 —— 无限额 / 不设起点', () => {
    expect(changeValueText('daily_limit', null)).toBe('无限额');
    expect(changeValueText('min_purchase', null)).toBe('不限');
  });

  it('状态类字段原样展示', () => {
    expect(changeValueText('status', '暂停申购')).toBe('暂停申购');
    expect(changeValueText('status', null)).toBe('--');
  });
});

describe('方向标签与字段标签', () => {
  it('方向映射成中文', () => {
    expect(directionLabel('tightened')).toBe('收紧');
    expect(directionLabel('loosened')).toBe('放宽');
  });

  it('字段标签覆盖全部变更字段', () => {
    for (const field of ['daily_limit', 'status', 'redeem_status', 'min_purchase']) {
      expect(CHANGE_FIELD_LABELS[field]).toBeTruthy();
    }
  });
});
