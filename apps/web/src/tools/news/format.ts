/** 新闻条目的时间一律按 **Asia/Shanghai** 展示（窗口语义也是它），不依赖浏览器时区 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function shanghaiParts(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed + 8 * 3_600_000) : null;
}

/** `2026-09-25`（用于按日分组的分隔线） */
export function shanghaiDate(iso: string | null | undefined): string | null {
  return shanghaiParts(iso)?.toISOString().slice(0, 10) ?? null;
}

/** `09:03` */
export function shanghaiTime(iso: string | null | undefined): string | null {
  const date = shanghaiParts(iso);
  return date === null ? null : date.toISOString().slice(11, 16);
}

/** `2026-09-25 09:03` */
export function shanghaiDateTime(iso: string | null | undefined): string | null {
  const date = shanghaiParts(iso);
  return date === null ? null : date.toISOString().slice(0, 16).replace('T', ' ');
}

/** `2026-09-25（周四）` */
export function shanghaiDateLabel(iso: string | null | undefined): string | null {
  const date = shanghaiParts(iso);
  if (date === null) return null;
  return `${date.toISOString().slice(0, 10)}（${WEEKDAYS[date.getUTCDay()]}）`;
}
