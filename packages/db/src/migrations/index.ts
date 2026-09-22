import { SQL as INIT } from './0001-init.ts';
import { SQL as USD } from './0002-usd.ts';
import { SQL as USD_CHANNEL_NOT_SOLD } from './0003-usd-channel-not-sold.ts';
import { SQL as FX_RATE } from './0004-fx-rate.ts';
import { SQL as ETF } from './0005-etf.ts';
import { SQL as ETF_SPOT_SOURCE } from './0006-etf-spot-source.ts';
import { SQL as APP_SETTING } from './0007-app-setting.ts';

export interface Migration {
  id: string;
  sql: string;
}

/**
 * 迁移注册表（按 id 升序执行）。
 *
 * **约定**：已发布的迁移不可修改，只能追加新文件 —— 否则已有数据库无法收敛。
 * 新增一个工具的 schema 时，在这里追加一条。
 */
export const MIGRATIONS: readonly Migration[] = [
  { id: '0001-init', sql: INIT },
  { id: '0002-usd', sql: USD },
  { id: '0003-usd-channel-not-sold', sql: USD_CHANNEL_NOT_SOLD },
  { id: '0004-fx-rate', sql: FX_RATE },
  { id: '0005-etf', sql: ETF },
  { id: '0006-etf-spot-source', sql: ETF_SPOT_SOURCE },
  { id: '0007-app-setting', sql: APP_SETTING },
];
