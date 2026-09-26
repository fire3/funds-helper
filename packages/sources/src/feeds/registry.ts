/**
 * 信源注册表 —— **硬编码，不接受外部传入 URL**（防 SSRF，见 architecture.md §13）。
 *
 * 信源是长期资产而不是用户输入：要加信源就改这里，这也天然保留了
 * 「一个信源一组 fixture」的测试前提。UI 上**不提供**「新增信源」表单。
 *
 * 名单与 cadence/weight 取自 `docs/design/global-financial-news-sources.md`（2026-09-25 实测）
 * 的 §5「最小可用配置」与 `docs/design/news-tool.md` §3.1。
 *
 * 关于「16 个信源」：设计文档的请求量估算行（media 8 + policy 4 + opinion/discovery 6）
 * 与它自己的名单表（6 + 4 + 5 = 15）对不上，这里以**名单表**为准启用 15 个 ——
 * 估算本来就是量级参考，少一个信源不影响任何结论。
 */

/**
 * 信源分组。
 *
 * **与 `@funds-helper/shared` 的 `NEWS_CATEGORIES` 各自维护一份字面量**（本仓库的既有约定：
 * `core`/`sources` 不依赖 `shared`，靠 `apps/server/src/contract.test.ts` 断言两边逐字相同）。
 */
export const FEED_CATEGORIES = ['media', 'opinion', 'policy', 'discovery'] as const;
export type FeedCategory = (typeof FEED_CATEGORIES)[number];

/** `auto` 按根元素探测（`<rss>` / `<rdf:RDF>` / `<feed>`），只有明确知道格式时才写死 */
export type FeedFormat = 'rss2' | 'rdf' | 'atom' | 'auto';

export interface FeedDefinition {
  /** 'ft.home' —— 也是 `news_source.id` */
  id: string;
  /** 展示名（信息流与信源页用） */
  name: string;
  /** 信源主页，展示用；跳转原文时用条目自己的 `link` */
  homeUrl: string;
  /** RSS 地址（**只从这里取，绝不来自请求参数**） */
  url: string;
  category: FeedCategory;
  /** 该信源自己的轮询间隔 */
  cadenceSec: number;
  format: FeedFormat;
  /** 总结配额里的权重（政策一手公告更高） */
  weight: number;
  /** `test/fixtures/feeds/` 下的真实响应快照文件名（一个信源一组 fixture 是测试前提） */
  fixture: string;
}

/** 媒体类：30 分钟一跳（新闻有时效，但也只是标题级） */
const MEDIA_CADENCE = 30 * 60;
/** 观点 / 政策 / 发现：60 分钟一跳（公告与专栏不需要更密） */
const LONGFORM_CADENCE = 60 * 60;

const MEDIA_WEIGHT = 3;
const POLICY_WEIGHT = 5;
const LOW_WEIGHT = 1;

/**
 * 首版启用的 15 个英文信源（全部为 2026-09-25 实测可直接解析的 A 类入口）。
 * Reuters / AP / Bloomberg 等受限源只通过 Google News 发现层进入（`discovery`）。
 */
export const FEEDS: readonly FeedDefinition[] = [
  // ---- media：全球财经 ----
  {
    id: 'ft.home',
    name: 'FT',
    homeUrl: 'https://www.ft.com/',
    url: 'https://www.ft.com/rss/home',
    category: 'media',
    cadenceSec: MEDIA_CADENCE,
    format: 'auto',
    weight: MEDIA_WEIGHT,
    fixture: 'ft-home.xml',
  },
  {
    id: 'ft.markets',
    name: 'FT Markets',
    homeUrl: 'https://www.ft.com/markets',
    url: 'https://www.ft.com/rss/markets',
    category: 'media',
    cadenceSec: MEDIA_CADENCE,
    format: 'auto',
    weight: MEDIA_WEIGHT,
    fixture: 'ft-markets.xml',
  },
  {
    id: 'cnbc.markets',
    name: 'CNBC Markets',
    homeUrl: 'https://www.cnbc.com/markets/',
    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    category: 'media',
    cadenceSec: MEDIA_CADENCE,
    format: 'auto',
    weight: MEDIA_WEIGHT,
    fixture: 'cnbc-markets.xml',
  },
  {
    id: 'yahoo.finance',
    name: 'Yahoo Finance',
    homeUrl: 'https://finance.yahoo.com/',
    url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC&region=US&lang=en-US',
    category: 'media',
    cadenceSec: MEDIA_CADENCE,
    format: 'auto',
    weight: MEDIA_WEIGHT,
    fixture: 'yahoo-finance.xml',
  },
  // ---- media：亚洲 ----
  {
    id: 'nikkei.asia',
    name: 'Nikkei Asia',
    homeUrl: 'https://asia.nikkei.com/',
    url: 'https://asia.nikkei.com/rss/feed/nar',
    category: 'media',
    cadenceSec: MEDIA_CADENCE,
    // RSS 1.0 / RDF，且 feed 内**没有 pubDate**（时间未知，绝不伪造）
    format: 'rdf',
    weight: MEDIA_WEIGHT,
    fixture: 'nikkei-asia.xml',
  },
  {
    id: 'scmp',
    name: 'SCMP',
    homeUrl: 'https://www.scmp.com/',
    url: 'https://www.scmp.com/rss/91/feed',
    category: 'media',
    cadenceSec: MEDIA_CADENCE,
    format: 'auto',
    weight: MEDIA_WEIGHT,
    fixture: 'scmp.xml',
  },

  // ---- opinion：观点 ----
  {
    id: 'economist.finance',
    name: 'The Economist Finance',
    homeUrl: 'https://www.economist.com/finance-and-economics',
    url: 'https://www.economist.com/finance-and-economics/rss.xml',
    category: 'opinion',
    cadenceSec: LONGFORM_CADENCE,
    format: 'auto',
    weight: LOW_WEIGHT,
    fixture: 'economist-finance.xml',
  },
  {
    id: 'project-syndicate',
    name: 'Project Syndicate',
    homeUrl: 'https://www.project-syndicate.org/',
    url: 'https://www.project-syndicate.org/rss',
    category: 'opinion',
    cadenceSec: LONGFORM_CADENCE,
    format: 'auto',
    weight: LOW_WEIGHT,
    fixture: 'project-syndicate.xml',
  },
  {
    id: 'foreign-affairs',
    name: 'Foreign Affairs',
    homeUrl: 'https://www.foreignaffairs.com/',
    url: 'https://www.foreignaffairs.com/rss.xml',
    category: 'opinion',
    cadenceSec: LONGFORM_CADENCE,
    format: 'auto',
    weight: LOW_WEIGHT,
    fixture: 'foreign-affairs.xml',
  },

  // ---- policy：政策与监管（一手公告，事实核验层） ----
  {
    id: 'ecb',
    name: 'ECB Press',
    homeUrl: 'https://www.ecb.europa.eu/press/html/index.en.html',
    url: 'https://www.ecb.europa.eu/rss/press.html',
    category: 'policy',
    cadenceSec: LONGFORM_CADENCE,
    format: 'auto',
    weight: POLICY_WEIGHT,
    fixture: 'ecb-press.xml',
  },
  {
    id: 'boe',
    name: 'Bank of England',
    homeUrl: 'https://www.bankofengland.co.uk/news',
    url: 'https://www.bankofengland.co.uk/rss/news',
    category: 'policy',
    cadenceSec: LONGFORM_CADENCE,
    format: 'auto',
    weight: POLICY_WEIGHT,
    fixture: 'boe-news.xml',
  },
  {
    id: 'fed',
    name: 'Federal Reserve',
    homeUrl: 'https://www.federalreserve.gov/newsevents/pressreleases.htm',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    category: 'policy',
    cadenceSec: LONGFORM_CADENCE,
    format: 'auto',
    weight: POLICY_WEIGHT,
    fixture: 'fed-press.xml',
  },
  {
    id: 'sec',
    name: 'SEC Press',
    homeUrl: 'https://www.sec.gov/newsroom/press-releases',
    url: 'https://www.sec.gov/news/pressreleases.rss',
    category: 'policy',
    cadenceSec: LONGFORM_CADENCE,
    format: 'auto',
    weight: POLICY_WEIGHT,
    fixture: 'sec-press.xml',
  },

  // ---- discovery：发现层（聚合器，只当线索不当事实依据） ----
  {
    id: 'gnews.reuters',
    name: 'Google News · Reuters',
    homeUrl: 'https://news.google.com/',
    url: 'https://news.google.com/rss/search?q=site%3Areuters.com%20business%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen',
    category: 'discovery',
    cadenceSec: LONGFORM_CADENCE,
    format: 'auto',
    weight: LOW_WEIGHT,
    fixture: 'gnews-reuters.xml',
  },
  {
    id: 'gnews.finance',
    name: 'Google News · Finance',
    homeUrl: 'https://news.google.com/',
    url: 'https://news.google.com/rss/search?q=financial%20news%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen',
    category: 'discovery',
    cadenceSec: LONGFORM_CADENCE,
    format: 'auto',
    weight: LOW_WEIGHT,
    fixture: 'gnews-finance.xml',
  },
];

export const FEED_IDS: readonly string[] = FEEDS.map((feed) => feed.id);

export const FEED_HOSTS: readonly string[] = [
  ...new Set(FEEDS.map((feed) => new URL(feed.url).host)),
];

export function getFeed(id: string): FeedDefinition | undefined {
  return FEEDS.find((feed) => feed.id === id);
}

/**
 * 出网护栏：只有注册表里的地址才允许被请求。
 * 服务层在每次抓取前过一遍 —— 这样即使上游表被误改，也只会在本地失败，不会变成 SSRF。
 */
export function isRegistryUrl(url: string): boolean {
  return FEEDS.some((feed) => feed.url === url);
}
