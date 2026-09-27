import {
  INDEX_DEFAULT_CODE,
  INDEX_DEFAULT_RANGE,
  INDEX_RANGE_KEYS,
  type IndexRangeKey,
} from '@funds-helper/core';

/**
 * 国际行情页的视图状态（选中指数 + 展示区间 + 概览排序）。
 *
 * 与其它工具一致：可分享的视图状态放 URL，而不是组件内部 state ——
 * 「近 3 年的恒生科技走势」是一个应该能发给别人的链接；
 * 排序同理：「今天领涨的市场」也值得能被分享。
 */
export type IndexSortKey = 'default' | 'chg';

export interface IndicesView {
  code: string;
  range: IndexRangeKey;
  /** 概览排序：default = 注册表顺序；chg = 各地区内按涨跌幅降序（缺失值垫底） */
  sort: IndexSortKey;
}

export const DEFAULT_VIEW: IndicesView = {
  code: INDEX_DEFAULT_CODE,
  range: INDEX_DEFAULT_RANGE,
  sort: 'default',
};

const RANGE_SET = new Set<string>(INDEX_RANGE_KEYS);

/**
 * 未知 code **回落默认指数**而不是报错 —— 服务端同样是这个语义，
 * 前后端必须一致，否则会出现「URL 一个指数、页面另一个指数」的错位。
 */
export function fromSearchParams(params: URLSearchParams): IndicesView {
  const code = params.get('code');
  const range = params.get('range');
  const sort = params.get('sort');

  return {
    code: code !== null && code !== '' ? code.toUpperCase() : DEFAULT_VIEW.code,
    range: range !== null && RANGE_SET.has(range) ? (range as IndexRangeKey) : DEFAULT_VIEW.range,
    sort: sort === 'chg' ? 'chg' : 'default',
  };
}

/** 只写入与默认不同的项，让分享链接尽量短 */
export function toSearchParams(view: IndicesView): URLSearchParams {
  const params = new URLSearchParams();
  if (view.code !== DEFAULT_VIEW.code) params.set('code', view.code);
  if (view.range !== DEFAULT_VIEW.range) params.set('range', view.range);
  if (view.sort !== DEFAULT_VIEW.sort) params.set('sort', view.sort);
  return params;
}
