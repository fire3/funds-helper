/**
 * 0007 —— 通用「运行时配置」。
 *
 * 有些开关既不该写死在代码里（用户会想换），也不适合只放在环境变量里
 * （改了要重启进程）。第一个用户是 ETF 工具的**行情渠道切换**：
 * 「东财（含折溢价）↔ 新浪（无折溢价）」这件事必须能在界面上直接切。
 *
 * 用一张通用的 KV 表而不是给 ETF 单开一张：它是**框架级**能力，
 * 后续任何工具（缓存时长、默认排序、代理开关…）都能复用；
 * 值统一按 TEXT 存，解析与校验交给各工具（都能拿到 Zod schema）。
 */
export const SQL = `
CREATE TABLE IF NOT EXISTS app_setting (
  key        TEXT PRIMARY KEY,   -- 命名约定：'<tool>.<name>'，如 'etf.spotSource'
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
