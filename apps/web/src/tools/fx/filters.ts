import {
  FX_DEFAULT_RANGE,
  FX_DIRECTIONS,
  FX_RANGE_KEYS,
  type FxDirection,
  type FxRangeKey,
} from '@funds-helper/core';

/**
 * 汇率页的视图状态（区间 + 报价方向）。
 *
 * 与其它工具一致：可分享的视图状态放 URL，而不是组件内部 state ——
 * 「近 10 年的美元兑人民币走势」是一个应该能发给别人的链接。
 */
export interface FxView {
  range: FxRangeKey;
  direction: FxDirection;
}

export const DEFAULT_VIEW: FxView = {
  range: FX_DEFAULT_RANGE,
  direction: FX_DIRECTIONS.UsdCny,
};

const RANGE_SET = new Set<string>(FX_RANGE_KEYS);

/** 非法值回落默认（手改 URL 不该让页面变空白） */
export function fromSearchParams(params: URLSearchParams): FxView {
  const range = params.get('range');
  const direction = params.get('direction');

  return {
    range: range !== null && RANGE_SET.has(range) ? (range as FxRangeKey) : DEFAULT_VIEW.range,
    direction: direction === FX_DIRECTIONS.CnyUsd ? FX_DIRECTIONS.CnyUsd : DEFAULT_VIEW.direction,
  };
}

/** 只写入与默认不同的项，让分享链接尽量短 */
export function toSearchParams(view: FxView): URLSearchParams {
  const params = new URLSearchParams();
  if (view.range !== DEFAULT_VIEW.range) params.set('range', view.range);
  if (view.direction !== DEFAULT_VIEW.direction) params.set('direction', view.direction);
  return params;
}
