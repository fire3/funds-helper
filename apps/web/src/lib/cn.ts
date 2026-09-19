export type ClassValue = string | false | null | undefined;

/** 极简 className 拼接（不引入 clsx 依赖） */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ');
}
