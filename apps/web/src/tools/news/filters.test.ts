import {
  NEWS_CATEGORIES,
  NEWS_CATEGORY_LABELS,
  NEWS_RANGE_LABELS,
  NEWS_RANGES,
  NEWS_WINDOW_LABELS,
  type NewsCategory,
} from '@funds-helper/shared';
import { describe, expect, it } from 'vitest';
import {
  buildFeedQuery,
  DEFAULT_NEWS_FILTERS,
  fromSearchParams,
  NEWS_TABS,
  type NewsFilters,
  toggleValue,
  toSearchParams,
} from './filters.ts';

function roundTrip(filters: NewsFilters): NewsFilters {
  return fromSearchParams(toSearchParams(filters));
}

describe('news 筛选：URL 往返', () => {
  it('默认值不写进 URL（分享链接尽量短）', () => {
    expect(toSearchParams(DEFAULT_NEWS_FILTERS).toString()).toBe('');
    expect(fromSearchParams(new URLSearchParams())).toEqual(DEFAULT_NEWS_FILTERS);
  });

  it('非默认项全部往返一致', () => {
    const filters: NewsFilters = {
      tab: 'feed',
      window: 'yesterday',
      range: '7d',
      categories: ['policy', 'media'],
      sources: ['ft.home', 'ecb'],
      keyword: 'fed',
    };
    const restored = roundTrip(filters);
    expect(restored).toEqual(filters);
    expect(toSearchParams(filters).toString()).toBe(
      'tab=feed&window=yesterday&range=7d&cat=policy%2Cmedia&src=ft.home%2Cecb&q=fed',
    );
  });

  it('非法取值被丢弃（分享链接里的笔误不该让页面空掉）', () => {
    const params = new URLSearchParams('tab=nope&window=forever&range=x&cat=bogus,media&q=abc');
    const filters = fromSearchParams(params);
    expect(filters.tab).toBe(DEFAULT_NEWS_FILTERS.tab);
    expect(filters.window).toBe(DEFAULT_NEWS_FILTERS.window);
    expect(filters.range).toBe(DEFAULT_NEWS_FILTERS.range);
    expect(filters.categories).toEqual(['media']);
    expect(filters.keyword).toBe('abc');
  });

  it('不存在的信源 id 被丢弃（否则服务端会回 400 把信息流打死）', () => {
    const filters = fromSearchParams(new URLSearchParams('src=ft.home,not-a-source'));
    expect(filters.sources).toEqual(['ft.home']);
  });

  it('关键词回车提交：首尾空白被吃掉，空串不写进 URL', () => {
    expect(toSearchParams({ ...DEFAULT_NEWS_FILTERS, keyword: '  fed  ' }).get('q')).toBe('fed');
    expect(toSearchParams({ ...DEFAULT_NEWS_FILTERS, keyword: '   ' }).has('q')).toBe(false);
  });

  it('每个 tab 都能往返', () => {
    for (const tab of NEWS_TABS) {
      expect(roundTrip({ ...DEFAULT_NEWS_FILTERS, tab }).tab).toBe(tab);
    }
  });
});

describe('信息流接口 query', () => {
  it('把全部筛选维度交给服务端（筛选不做在前端）', () => {
    const query = buildFeedQuery(
      {
        ...DEFAULT_NEWS_FILTERS,
        range: '7d',
        categories: ['policy'],
        sources: ['fed'],
        keyword: ' rates ',
      },
      'abc|42',
      50,
    );
    const params = new URLSearchParams(query);
    expect(params.get('range')).toBe('7d');
    expect(params.get('cat')).toBe('policy');
    expect(params.get('src')).toBe('fed');
    expect(params.get('q')).toBe('rates');
    expect(params.get('cursor')).toBe('abc|42');
    expect(params.get('limit')).toBe('50');
  });

  it('没选的维度不出现（服务端按「没传 = 不筛」处理）', () => {
    const params = new URLSearchParams(buildFeedQuery(DEFAULT_NEWS_FILTERS));
    expect(params.has('cat')).toBe(false);
    expect(params.has('src')).toBe(false);
    expect(params.has('q')).toBe(false);
    expect(params.has('cursor')).toBe(false);
  });
});

describe('选项表', () => {
  it('窗口 / 分组选项与 shared 契约同源', () => {
    expect(NEWS_RANGES).toContain('3d');
    expect(NEWS_RANGES).toContain('all');
    expect(NEWS_WINDOW_LABELS.last7d).toBe('近 7 日');
    expect(NEWS_RANGE_LABELS.all).toBe('全部');
    expect(Object.keys(NEWS_CATEGORY_LABELS)).toEqual([...NEWS_CATEGORIES]);
  });

  it('toggleValue 支持多选 chips', () => {
    expect(toggleValue(['media'], 'policy')).toEqual(['media', 'policy']);
    expect(toggleValue(['media', 'policy'], 'media')).toEqual(['policy']);
  });

  it('分组多选取并集', () => {
    let selected: NewsCategory[] = [];
    selected = toggleValue(selected, 'media') as NewsCategory[];
    selected = toggleValue(selected, 'policy') as NewsCategory[];
    expect(selected.sort()).toEqual(['media', 'policy']);
  });
});
