import { createHash } from 'node:crypto';
import {
  NEWS_SECTION_LABELS,
  type NewsAiConfig,
  NewsAiConfigSchema,
  type NewsPrompt,
  NewsPromptSchema,
} from '@funds-helper/shared';
import type { AppConfig } from '../../config.ts';

/** 运行时配置键（`app_setting`）：整段 JSON 存一条，读写都过 schema */
export const NEWS_AI_CONFIG_SETTING_KEY = 'news.aiConfig';
/** 提示词库：一个模板一条，key 在界面上可见、在生成记录里留痕 */
export const NEWS_PROMPT_SETTING_PREFIX = 'news.prompt.';

/** 每日简报（默认模板） */
export const DEFAULT_SYSTEM_PROMPT = `你是中文财经编辑，为个人读者整理当天的全球英文财经要闻。

硬性规则：
1. 只依据下方条目清单作答，**禁止使用清单之外的知识**，禁止编造数字、人名、日期或引语。
2. 金融专名（机构名、产品名、人名、地名）保留英文原文，只翻译叙述部分。
3. 输出使用简体中文。
4. 引用只能写进每条要点的 refs 数组（数字对应条目编号 [n]），正文 text 里**不要出现 [12] 这样的字样**。
5. discovery 分组是 Google News 聚合条目，只能表述为「有报道称 / 有线索显示」，不能作为事实依据，也不要引用它们支撑事实断言。
6. 不同信源说法不一致时，必须在 risk 数组里点明分歧（分别说明谁怎么说），不要擅自裁决。
7. 某个分区没有对应信息时返回空数组，**不要凑字数，不要写「今日无相关消息」**。

分区口径：
- sections.macro：${NEWS_SECTION_LABELS.macro}（央行、财政、监管与国际组织动向）
- sections.markets：${NEWS_SECTION_LABELS.markets}（股指、债汇商品、资金流向）
- sections.companies：${NEWS_SECTION_LABELS.companies}（财报、并购、行业与公司事件）
- sections.asia：${NEWS_SECTION_LABELS.asia}（日本、中国香港、东南亚等亚洲市场）
- risk：风险提示与相互矛盾的说法
- watch：后续关注（0–5 条纯字符串，**不带引用**）

每条要点一句话讲完一件事，refs 只放真正支撑它的条目编号；背景性表述用空 refs。`;

export const DEFAULT_USER_TEMPLATE = `日期：{{date}}
时间窗口：{{window_label}}
送入条目：{{item_count}} 条，来自 {{source_count}} 个信源
输出语言：{{output_language}}

条目清单（每条四行：编号与元数据 / 标题 / 摘要 / 链接）：

{{items}}

{{extra}}`;

const POLICY_SYSTEM_PROMPT = `${DEFAULT_SYSTEM_PROMPT}

本模板是「政策聚焦」：清单里只会包含政策与监管分组的条目，请只输出宏观与政策、风险提示与后续关注，市场与公司分区通常留空。`;

const POLICY_USER_TEMPLATE = `${DEFAULT_USER_TEMPLATE}`;

const WEEKLY_USER_TEMPLATE = `日期：{{date}}
时间窗口：{{window_label}}（周报视角，覆盖近 7 天）
送入条目：{{item_count}} 条，来自 {{source_count}} 个信源
输出语言：{{output_language}}

这是**近 7 天**的条目，请按「本周主线」而不是「今天发生了什么」来组织：headline 写本周最重要的一条，
各分区里的要点优先保留持续性强、影响未兑现的事件。

条目清单：

{{items}}

{{extra}}`;

/** 首启写入的三个内置模板（可改、可另存，**不提供删除默认模板**） */
export const BUILTIN_PROMPTS: readonly NewsPrompt[] = [
  {
    key: 'daily',
    name: '每日简报',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userTemplate: DEFAULT_USER_TEMPLATE,
    categories: [],
    isDefault: true,
    updatedAt: '2026-09-26T00:00:00.000Z',
  },
  {
    key: 'policy',
    name: '政策聚焦',
    systemPrompt: POLICY_SYSTEM_PROMPT,
    userTemplate: POLICY_USER_TEMPLATE,
    // 只喂 policy 组：不送进去才是真正的隔离
    categories: ['policy'],
    isDefault: false,
    updatedAt: '2026-09-26T00:00:00.000Z',
  },
  {
    key: 'weekly',
    name: '周报',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userTemplate: WEEKLY_USER_TEMPLATE,
    categories: [],
    isDefault: false,
    updatedAt: '2026-09-26T00:00:00.000Z',
  },
];

/** 首启种子（写库前再过一次 schema，防止手误把坏数据写进 `app_setting`） */
export const BUILTIN_PROMPT_ROWS: readonly NewsPrompt[] = BUILTIN_PROMPTS.map((prompt) =>
  NewsPromptSchema.parse(prompt),
);

/**
 * 环境变量给的默认配置。
 *
 * **只是默认值**：运行时 `app_setting` 里有值就用运行时的（改完不重启）。
 * `baseUrl` / `model` 允许为空 —— 「还没配置」是一个明确的状态，
 * 生成时会报 400「还没有配置模型地址」，而不是拿空地址去打网络。
 */
export function defaultAiConfig(config: AppConfig): NewsAiConfig {
  return NewsAiConfigSchema.parse({
    baseUrl: config.newsAiBaseUrl,
    apiKey: config.newsAiApiKey,
    model: config.newsAiModel,
    temperature: config.newsAiTemperature,
    maxTokens: config.newsAiMaxTokens,
    // 设计文档 §5.4：默认 Http 的 60s 对长输出偏紧
    timeoutMs: 120_000,
    maxInputTokens: config.newsAiMaxInputTokens,
    dailyLimit: config.newsAiDailyLimit,
    enabled: true,
  });
}

/**
 * `prompt_hash` = system + user 的 sha256 前 8 位。
 *
 * 没有这个字段，「改了提示词但看到的还是旧结果」会变成一个查不出原因的 bug ——
 * 界面据此提示「当前简报是用旧提示词生成的」。
 */
export function promptHash(systemPrompt: string, userTemplate: string): string {
  return createHash('sha256')
    .update(`${systemPrompt}\n---\n${userTemplate}`)
    .digest('hex')
    .slice(0, 8);
}
