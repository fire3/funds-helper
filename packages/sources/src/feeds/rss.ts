import { ParseError } from '../errors.ts';
import type { FeedFormat } from './registry.ts';

/**
 * RSS / RDF / Atom 的**条目级**解析。
 *
 * 刻意**不引 XML 库**（design §6 决策 D2）：这里只需要「一条一条地取 title/link/时间/摘要」，
 * 不需要 XPath、不需要命名空间解析、更不需要构建 DOM。用正则做切片的代价是
 * 「结构级严格」要自己把关 —— 根本不是 feed（HTML 挑战页、404 页）必须抛 `ParseError`，
 * 而单条残缺只跳过该条并计数（行级宽松、结构级严格，architecture D8）。
 *
 * 每个信源一份真实响应 fixture（`test/fixtures/feeds/`），上游改版时测试先红。
 */

export type DetectedFormat = 'rss2' | 'rdf' | 'atom';

export interface ParsedFeedEntry {
  title: string;
  link: string;
  guid: string | null;
  /** ISO8601；上游没给（Nikkei 就没有）就是 null —— **绝不伪造时间** */
  publishedAt: string | null;
  /** 已剥离 HTML、已按 400 字符截断的摘要 */
  summary: string | null;
  /** false = 只有标题（摘要剥离失败或上游没给），界面据此降级展示 */
  hasSummary: boolean;
}

export interface ParsedFeed {
  format: DetectedFormat;
  entries: ParsedFeedEntry[];
  /** 因缺 title / link 被跳过的条数（写进 `stats.skipped`，不整批失败） */
  skipped: number;
}

export interface ParseFeedOptions {
  /** 条目里的相对链接按它解析；不传则只接受绝对链接 */
  baseUrl?: string | undefined;
  /** 摘要截断长度（字符） */
  maxSummaryChars?: number;
}

/** 摘要按 400 字符截断（design §3.3：喂给模型的只有标题 + 摘要 + 元数据） */
export const SUMMARY_MAX_CHARS = 400;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  laquo: '«',
  raquo: '»',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  dagger: '†',
  permil: '‰',
  prime: '′',
  frasl: '/',
  larr: '←',
  rarr: '→',
  harr: '↔',
  infin: '∞',
  ne: '≠',
  le: '≤',
  ge: '≥',
};

/**
 * 实体解码：**单次遍历**（`&amp;lt;` 应当得到 `&lt;` 而不是 `<`）。
 * 数值实体支持十进制与十六进制。
 */
export function decodeEntities(input: string): string {
  return input.replace(
    /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith('#')) {
        const isHex = body[1] === 'x' || body[1] === 'X';
        const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

/** CDATA 外壳剥掉（FT/Economist/CNBC 的 title/description 全是 CDATA） */
function unwrapCdata(raw: string): string {
  let text = raw.trim();
  const match = text.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (match) return match[1] ?? '';
  // 只包了一半的情况（上游截断）也尽量救一下
  text = text.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
  return text;
}

/** 去标签 + 解实体 + 折叠空白（标题与单行文本用） */
function cleanInline(raw: string): string {
  const withoutCdata = unwrapCdata(raw);
  const withoutTags = withoutCdata.replace(/<[^>]*>/g, ' ');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

export interface StrippedHtml {
  text: string;
  /** false = 剥离失败（剩下的还是标签串）→ 条目降级为「只有标题」 */
  ok: boolean;
}

/**
 * RSS 的 `description` 常常是 HTML（FT/CNBC 都是）：
 * 抽纯文本 → 实体解码 → 再剥一次（对付「转义过的 HTML」）→ 折叠空白 → 截断。
 *
 * 两遍剥标签是有意的：第一遍处理真实标签，实体解码后浮出的 `&lt;p&gt;` 需要第二遍。
 */
export function stripHtml(input: string, maxChars = SUMMARY_MAX_CHARS): StrippedHtml {
  const once = unwrapCdata(input).replace(/<[^>]*>/g, ' ');
  const decoded = decodeEntities(once);
  const twice = decoded.replace(/<[^>]*>/g, ' ');
  const collapsed = twice.replace(/\s+/g, ' ').trim();

  if (collapsed === '') return { text: '', ok: false };

  let text = collapsed;
  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    // 尽量在词边界截断，别把单词劈两半
    const spaceAt = cut.lastIndexOf(' ');
    const base = spaceAt > maxChars * 0.6 ? cut.slice(0, spaceAt) : cut;
    text = `${base.trimEnd()}…`;
  }

  // 还剩标签状内容 = 没剥干净（例如上游返回的是一坨畸形标记）
  const looksLikeMarkup = /<\s*[a-zA-Z/!?]/.test(text);
  return { text, ok: !looksLikeMarkup };
}

/**
 * 根元素探测。顺序很关键：CNBC 的 RSS 里有 `<feed_asset>`，
 * 所以必须先认 `<rss`，`<feed` 也要要求后面跟空白或 `>`。
 */
export function detectFormat(text: string): DetectedFormat {
  const cleaned = text.replace(/^\uFEFF/, '');
  const find = (pattern: RegExp): number => {
    const match = pattern.exec(cleaned);
    return match?.index ?? Number.MAX_SAFE_INTEGER;
  };

  const rssAt = find(/<rss[\s>]/i);
  const rdfAt = find(/<rdf:RDF[\s>]/i);
  const atomAt = find(/<feed[\s>]/i);
  const htmlAt = Math.min(find(/<!doctype\s+html/i), find(/<html[\s>]/i), find(/<head[\s>]/i));

  const rootAt = Math.min(rssAt, rdfAt, atomAt);
  if (rootAt === Number.MAX_SAFE_INTEGER) {
    if (htmlAt < Number.MAX_SAFE_INTEGER) {
      // WAF 挑战页 / 404 页：HTTP 200 也可能不是 feed（调研文档 §1.2）
      throw new ParseError('上游返回的是 HTML 页面而不是 feed（可能是站点挑战或错误页）', {
        detail: snippet(cleaned),
      });
    }
    throw new ParseError('上游返回的不是 RSS/Atom feed', {
      detail: snippet(cleaned),
    });
  }
  if (htmlAt < rootAt) {
    throw new ParseError('上游返回的是 HTML 页面而不是 feed（可能是站点挑战或错误页）', {
      detail: snippet(cleaned),
    });
  }
  if (rssAt === rootAt) return 'rss2';
  if (rdfAt === rootAt) return 'rdf';
  return 'atom';
}

/** 错误 detail 用的原文片段（前后各 160 字符，日志纪律：不整体打日志） */
function snippet(text: string): string {
  const head = text.slice(0, 160).replace(/\s+/g, ' ').trim();
  return head === '' ? '(空响应体)' : head;
}

/**
 * 取某个标签的**文本内容**（已剥外壳，仍是原文，由调用方决定要不要再清洗）。
 *
 * 开标签用 `(?<!/)` 排除自闭合形态：`<link href="…"/>` 必须返回 null
 * （它的值在属性里，不在标签内容里），否则会把后面的兄弟标签当成它的内容。
 */
function tag(block: string, name: string): string | null {
  const open = new RegExp(`<${name}\\b([^>]*?)(?<!/)>`, 'i');
  const opening = open.exec(block);
  if (opening === null) return null;

  const rest = block.slice(opening.index + opening[0].length);
  const closing = new RegExp(`</${name}\\s*>`, 'i').exec(rest);
  if (closing === null) return null;
  return rest.slice(0, closing.index);
}

/** Atom 的 `<link href="…"/>` 是自闭合的，得从属性里取；优先 `rel="alternate"` */
function atomLink(block: string): string | null {
  const pattern = /<link\b[^>]*>/gi;
  let fallback: string | null = null;
  for (;;) {
    const match = pattern.exec(block);
    if (match === null) break;
    const attrs = match[0];
    const href = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)')/i);
    const url = href?.[2] ?? href?.[3];
    if (url === undefined || url === '') continue;
    const rel = attrs.match(/\brel\s*=\s*("([^"]*)"|'([^']*)')/i)?.[2];
    if (rel === undefined || rel === 'alternate') return url;
    fallback ??= url;
  }
  return fallback;
}

function attr(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return match?.[2] ?? match?.[3] ?? null;
}

/** RFC 822（RSS）/ ISO 8601（Atom、dc:date）都能被 Date.parse 认；认不出就 null */
function toIso(raw: string | null): string | null {
  if (raw === null) return null;
  const text = cleanInline(raw);
  if (text === '') return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const DATE_TAGS = ['pubDate', 'published', 'updated', 'dc:date', 'dcterms:date', 'date'];

function resolveLink(raw: string | null, baseUrl: string | undefined): string | null {
  if (raw === null) return null;
  const text = cleanInline(raw);
  if (text === '') return null;
  try {
    const url = baseUrl === undefined ? new URL(text) : new URL(text, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

const SUMMARY_TAGS = ['description', 'summary', 'content:encoded', 'content'];

/** 条目块（含开标签属性，RDF 的 `rdf:about` 就在那里面） */
interface ItemBlock {
  attrs: string;
  inner: string;
}

function extractBlocks(text: string, tagName: string): ItemBlock[] {
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)</${tagName}\\s*>`, 'gi');
  const blocks: ItemBlock[] = [];
  for (;;) {
    const match = pattern.exec(text);
    if (match === null) break;
    const attrs = (match[1] ?? '').trim();
    // `<item/>` 这种自闭合空条目没有内容，直接当作「残缺条目」跳过
    if (attrs.endsWith('/')) continue;
    blocks.push({ attrs, inner: match[2] ?? '' });
  }
  return blocks;
}

/**
 * 解析一份 feed 文本。
 *
 * @param format `auto` 按根元素探测；明确知道格式时传死（Nikkei 是 RDF）
 */
export function parseFeed(
  text: string,
  format: FeedFormat = 'auto',
  options: ParseFeedOptions = {},
): ParsedFeed {
  const detected: DetectedFormat = format === 'auto' ? detectFormat(text) : format;
  const maxChars = options.maxSummaryChars ?? SUMMARY_MAX_CHARS;
  const baseUrl = options.baseUrl;

  const tagName = detected === 'atom' ? 'entry' : 'item';
  const blocks = extractBlocks(text, tagName);
  if (blocks.length === 0) {
    throw new ParseError(`feed 里没有任何 <${tagName}> 条目，疑似上游改版`, {
      detail: snippet(text),
    });
  }

  const entries: ParsedFeedEntry[] = [];
  let skipped = 0;

  for (const block of blocks) {
    const titleRaw = tag(block.inner, 'title');
    const title = titleRaw === null ? '' : cleanInline(titleRaw);
    if (title === '') {
      skipped += 1;
      continue;
    }

    const linkRaw =
      detected === 'atom'
        ? atomLink(block.inner)
        : (tag(block.inner, 'link') ?? attr(block.attrs, 'rdf:about'));
    const link = resolveLink(linkRaw, baseUrl);
    if (link === null) {
      skipped += 1;
      continue;
    }

    let publishedAt: string | null = null;
    for (const name of DATE_TAGS) {
      publishedAt = toIso(tag(block.inner, name));
      if (publishedAt !== null) break;
    }

    const guidRaw = tag(block.inner, 'guid') ?? tag(block.inner, 'id');
    const guid = guidRaw === null ? null : cleanInline(guidRaw);

    let summary: string | null = null;
    for (const name of SUMMARY_TAGS) {
      const raw = tag(block.inner, name);
      if (raw === null || cleanInline(raw) === '') continue;
      const stripped = stripHtml(raw, maxChars);
      if (stripped.ok && stripped.text !== '') {
        summary = stripped.text;
        break;
      }
    }

    entries.push({
      title,
      link,
      guid: guid === '' ? null : guid,
      publishedAt,
      summary,
      hasSummary: summary !== null,
    });
  }

  return { format: detected, entries, skipped };
}
