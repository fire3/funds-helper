import { dedupeForPrompt } from './dedupe.ts';
import { NEWS_CATEGORIES, type NewsCategory, type NewsItemLike } from './model.ts';
import { estimateItemTokens } from './prompt.ts';

/**
 * 预算与配额：把「窗口内几百条」压进「一次调用」（design §5.2）。
 *
 * 这是整个管线里唯一需要算法的地方，因此是**纯函数 + 确定性**：
 * 同样的输入必得同样的输出（配额是保底 + 封顶，不是硬切；某类不足时余额自动让给别的类）。
 *
 * `policy` 保底 20% 的理由：政策与监管是**事实核验层** ——
 * 二手报道再多，也不能盖过央行与证监会的一手公告（调研文档 §3.1）。
 */

/** 各分组的**保底**比例（discovery 只有封顶没有保底） */
export const NEWS_CATEGORY_FLOORS: Record<NewsCategory, number> = {
  policy: 0.2,
  media: 0.45,
  opinion: 0.1,
  discovery: 0,
};

/** 各分组的**封顶**比例：聚合器条目最多占送入模型额度的 10% */
export const NEWS_CATEGORY_CAPS: Record<NewsCategory, number> = {
  policy: 1,
  media: 1,
  opinion: 1,
  discovery: 0.1,
};

/** 保底分配的先后：政策 → 媒体 → 观点（先保证事实核验层） */
const FLOOR_ORDER: readonly NewsCategory[] = ['policy', 'media', 'opinion'];

export interface PromptBudgetInput {
  items: NewsItemLike[];
  /** 目标 token 数（服务端取 `maxInputTokens × 0.6`，留 40% 给输出与估算误差） */
  targetInputTokens: number;
  /** `sourceId → 注册表权重`：组内排序用；不传则只按时间排 */
  weights?: Record<string, number> | undefined;
}

export interface PromptBudgetResult {
  /** 最终清单（渲染时按数组顺序编号 `[1]…[n]`） */
  selected: NewsItemLike[];
  /** **窗口内未送入模型的条数**（含同标题合并的），`selected.length + dropped = 输入条数` */
  dropped: number;
  droppedByCategory: Record<NewsCategory, number>;
  /** 其中因标题完全相同而被合并掉的条数（只用于日志，不参与 dropped 的口径） */
  deduped: number;
  /** 实际占用的估算 token 数 */
  usedTokens: number;
}

function emptyDroppedByCategory(): Record<NewsCategory, number> {
  return { media: 0, opinion: 0, policy: 0, discovery: 0 };
}

/** 时间倒序（`publishedAt` 缺失时按 `fetchedAt` 兜底 —— 绝不伪造时间，但排序要有依据） */
function compareTimeDesc(a: NewsItemLike, b: NewsItemLike): number {
  const left = a.publishedAt ?? a.fetchedAt;
  const right = b.publishedAt ?? b.fetchedAt;
  if (left === right) return a.id - b.id;
  return left < right ? 1 : -1;
}

export function buildPromptBudget(input: PromptBudgetInput): PromptBudgetResult {
  const unique = dedupeForPrompt(input.items);
  const target = Math.max(0, Math.floor(input.targetInputTokens));
  const weightOf = (item: NewsItemLike): number => input.weights?.[item.sourceId] ?? 0;

  const queues = Object.fromEntries(
    NEWS_CATEGORIES.map((category) => [category, [] as NewsItemLike[]]),
  ) as Record<NewsCategory, NewsItemLike[]>;
  for (const item of unique) queues[item.category].push(item);

  // 组内排序：weight 降序 → 时间降序（稳定：最后按 id 兜底，保证确定性）
  for (const category of NEWS_CATEGORIES) {
    queues[category].sort((a, b) => {
      const weightDiff = weightOf(b) - weightOf(a);
      if (weightDiff !== 0) return weightDiff;
      return compareTimeDesc(a, b);
    });
  }

  const tokens = new Map<NewsItemLike, number>();
  for (const item of unique) tokens.set(item, estimateItemTokens(item));

  const selected: NewsItemLike[] = [];
  const selectedSet = new Set<NewsItemLike>();
  const catTokens = emptyDroppedByCategory();
  let used = 0;

  const take = (item: NewsItemLike): void => {
    selected.push(item);
    selectedSet.add(item);
    catTokens[item.category] += tokens.get(item) ?? 0;
    used += tokens.get(item) ?? 0;
  };

  // 1) 保底配额：某类条目不足时**余额自然让给后面的填充阶段**
  for (const category of FLOOR_ORDER) {
    const floorBudget = target * NEWS_CATEGORY_FLOORS[category];
    for (const item of queues[category]) {
      if (catTokens[category] >= floorBudget) break;
      const cost = tokens.get(item) ?? 0;
      if (used + cost > target) break;
      take(item);
    }
  }

  // 2) 填充：全局按 weight → 时间 排序后逐条累加；超预算即停
  const rest = NEWS_CATEGORIES.flatMap((category) =>
    queues[category].filter((item) => !selectedSet.has(item)),
  ).sort((a, b) => {
    const weightDiff = weightOf(b) - weightOf(a);
    if (weightDiff !== 0) return weightDiff;
    return compareTimeDesc(a, b);
  });

  for (const item of rest) {
    const cost = tokens.get(item) ?? 0;
    // 分组封顶：跳过这一条继续看别的（封顶是分组规则，不是排序规则）
    if (catTokens[item.category] + cost > target * NEWS_CATEGORY_CAPS[item.category]) continue;
    if (used + cost > target) break;
    take(item);
  }

  // 统计口径：以**输入条数**为分母，保证 selected + dropped === 输入条数
  const droppedByCategory = emptyDroppedByCategory();
  for (const item of input.items) droppedByCategory[item.category] += 1;
  for (const item of selected) droppedByCategory[item.category] -= 1;

  const dropped = input.items.length - selected.length;
  return {
    selected,
    dropped,
    droppedByCategory,
    deduped: input.items.length - unique.length,
    usedTokens: used,
  };
}
