/**
 * `news` 工具的领域模型（纯类型与字面量）。
 *
 * 取值字面量必须与 `@funds-helper/shared` 的传输契约保持一致 ——
 * `apps/server/src/contract.test.ts` 会逐项比对，防止两边漂移。
 *
 * 本包**不依赖 shared**（core 是纯计算，依赖方向见 architecture §2.2），
 * 所以这里的条目类型写成结构化的 `NewsItemLike`：shared 的 `NewsItem` 结构相同，天然可赋值。
 */

/** 信息流分组：媒体 / 观点 / 政策与监管 / 发现（聚合器） */
export const NEWS_CATEGORIES = ['media', 'opinion', 'policy', 'discovery'] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export const NEWS_CATEGORY_LABELS: Record<NewsCategory, string> = {
  media: '全球财经',
  opinion: '观点',
  policy: '政策与监管',
  discovery: '发现',
};

/** 送入提示词的四个固定分区 + 风险段（与 shared 的 `NEWS_SECTION_KEYS` 同步） */
export const NEWS_SECTION_KEYS = ['macro', 'markets', 'companies', 'asia'] as const;
export type NewsSectionKey = (typeof NEWS_SECTION_KEYS)[number];

/** 信息流条目（与 shared 的 `NewsItem` 结构一致） */
export interface NewsItemLike {
  id: number;
  sourceId: string;
  sourceName: string;
  category: NewsCategory;
  title: string;
  summary: string | null;
  url: string;
  publishedAt: string | null;
  fetchedAt: string;
  discovery: boolean;
}

/** 提示词里的一条要点 */
export interface SummaryPointLike {
  text: string;
  refs: number[];
}

/** 模型应当输出的结构化结果（与 shared 的 `NewsSummaryPayload` 结构一致） */
export interface SummaryPayloadLike {
  headline: string;
  sections: Record<NewsSectionKey, SummaryPointLike[]>;
  risk: SummaryPointLike[];
  watch: string[];
}
