/**
 * canonical URL 与标题标准化 —— 去重口径的第一段（design §3.4）。
 *
 * 原则：**宁可重复，不可错合并**。所以 canonical 化只做「一定等价」的变换
 * （协议无关的跟踪参数、大小写、尾斜杠），不猜、不解析跳转、不访问网络。
 */

/** 明确的跟踪参数：去掉它们不会改变文章指向 */
const TRACKING_PARAM =
  /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|igshid|yclid|wbraid|gbraid|mc_cid|mc_eid|_ga|_hsenc|_hsmi|ref_src|ref_url|cmpid|spm|from|ito)$/i;

export interface CanonicalizeOptions {
  /** Google News 之类的聚合器跳转链接原样保留（它就是「线索」本身） */
  keepQuery?: boolean;
}

/**
 * canonical URL。无法解析或不是 http(s) 时返回 null
 * （调用方退化到 `dedupKey`，绝不塞一个伪造值进唯一索引）。
 */
export function canonicalizeUrl(raw: string, options: CanonicalizeOptions = {}): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();

  if (options.keepQuery !== true) {
    const kept = [...url.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAM.test(key))
      // 参数顺序不影响指向；排序后 `?a=1&b=2` 与 `?b=2&a=1` 才会判等
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    url.search = '';
    for (const [key, value] of kept) url.searchParams.append(key, value);
  }

  // 去尾部斜杠（根路径 `/` 保留）
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  return url.toString();
}

/**
 * 标题标准化：NFKC → 小写 → 去标点 → 折叠空白。
 * 全角/半角与大小写差异不构成「两条新闻」，标点同理。
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** FNV-1a 32 位：够用且无依赖（去重键只要稳定，不需密码学强度） */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 退化去重键：`source_id|hash(标准化标题)|发布日期`（canonical 拿不到时用它） */
export function dedupKeyOf(sourceId: string, title: string, publishedAt: string | null): string {
  const date = publishedAt === null ? '' : publishedAt.slice(0, 10);
  return `${sourceId}|${fnv1a(normalizeTitle(title))}|${date}`;
}
