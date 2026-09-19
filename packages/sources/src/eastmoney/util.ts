/** 上游解析的通用小工具（属于**形状解析**，不是业务语义） */

export function num(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '--' || trimmed === '-') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function str(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' || trimmed === '--' ? null : trimmed;
}

export function int(raw: unknown): number | null {
  const value = num(raw);
  return value === null ? null : Math.trunc(value);
}

/** 剥离 JSONP 外壳：取第一个 `(` 与最后一个 `)` 之间的内容 */
export function stripJsonp(text: string): string | null {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start + 1, end);
}

/** 解析失败时用于排障的片段（不整体打日志 —— 接口 A 有 4 MB） */
export function snippet(text: string, size = 200): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= size * 2) return clean;
  return `${clean.slice(0, size)} … ${clean.slice(-size)}`;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
