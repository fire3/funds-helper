import { NEWS_CATEGORY_LABELS, type NewsItemLike } from './model.ts';

/**
 * 提示词模板渲染与条目清单排版（纯函数，可单测）。
 *
 * 提示词是**用户可编辑的资产**（存 `app_setting`、界面可改、带 `prompt_hash`），
 * 所以这里只负责「把变量填进去」，模板本身不写死在代码里。
 */

export type TemplateVars = Record<string, string | number | undefined | null>;

/**
 * 渲染 `{{var}}` 占位符。
 *
 * **变量缺失时替换成空串而不是原样保留 `{{x}}`** ——
 * 提示词里漏出一个占位符会让模型困惑，也会让人以为是模型出错。
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

/** Asia/Shanghai（UTC+8，无夏令时）的 `YYYY-MM-DD HH:mm` */
function shanghaiMinute(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '时间未知';
  return new Date(parsed + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * 一条清单行（编号即引用号）：
 *
 * ```
 * [12] 2026-09-25 09:03 · CNBC Markets · 政策与监管
 *       Fed holds rates steady as officials signal one cut this year
 *       The Federal Reserve held its benchmark rate…
 *       https://www.cnbc.com/2026/09/25/….html
 * ```
 *
 * 上游没给发布时间（Nikkei）就写「时间未知」，**不伪造**。
 */
export function formatItemLine(index: number, item: NewsItemLike): string {
  const time = item.publishedAt === null ? '时间未知' : shanghaiMinute(item.publishedAt);
  const category = NEWS_CATEGORY_LABELS[item.category];
  const head = `[${index}] ${time} · ${item.sourceName} · ${category}`;
  const lines = [`      ${item.title}`];
  if (item.summary !== null && item.summary !== '') lines.push(`      ${item.summary}`);
  lines.push(`      ${item.url}`);
  return [head, ...lines].join('\n');
}

/** 整份清单（相邻条目空一行，模型更容易按编号定位） */
export function formatItemLines(items: readonly NewsItemLike[]): string {
  return items.map((item, index) => formatItemLine(index + 1, item)).join('\n\n');
}

/**
 * 单条的 token 估算值。
 *
 * 预算计算必须**与选中顺序无关**（同样的输入必得同样的预算决策），
 * 所以编号统一按 1 估算 —— 编号位数的差异远小于 40% 的预留余量。
 */
export function estimateItemTokens(item: NewsItemLike): number {
  return estimateTokens(formatItemLine(1, item));
}

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/;

/**
 * token 估算（**估算不是精确计数** —— 我们没有 tokenizer 依赖，D5）：
 * 英文按 `chars / 4`、中文按 `chars / 1.6` 分段计算，再留 40% 余量给输出。
 */
export function estimateTokens(text: string): number {
  let dense = 0;
  let light = 0;
  for (const char of text) {
    if (CJK.test(char)) dense += 1;
    else light += 1;
  }
  return Math.ceil(dense / 1.6) + Math.ceil(light / 4);
}
