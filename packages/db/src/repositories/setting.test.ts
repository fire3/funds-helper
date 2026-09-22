import { describe, expect, it } from 'vitest';
import { openDb } from '../client.ts';
import { runMigrations } from '../migrate.ts';
import { SettingRepository } from './setting.ts';

function repo(): { db: ReturnType<typeof openDb>; settings: SettingRepository } {
  const db = openDb(':memory:');
  runMigrations(db);
  return { db, settings: new SettingRepository(db) };
}

describe('SettingRepository', () => {
  it('读不到时返回 null（调用方自己决定默认值）', () => {
    const { db, settings } = repo();
    expect(settings.get('etf.spotSource')).toBeNull();
    db.close();
  });

  it('写入后能读回，重复写入是更新而不是插入', () => {
    const { db, settings } = repo();
    settings.set('etf.spotSource', 'eastmoney');
    expect(settings.get('etf.spotSource')).toBe('eastmoney');

    settings.set('etf.spotSource', 'sina');
    expect(settings.get('etf.spotSource')).toBe('sina');
    expect(settings.all()).toHaveLength(1);
    expect(settings.all()[0]).toMatchObject({ key: 'etf.spotSource', value: 'sina' });
    db.close();
  });

  it('updated_at 是 ISO 时间戳（每次写入刷新）', () => {
    const { db, settings } = repo();
    settings.set('a', '1');
    const first = settings.all()[0]?.updated_at ?? '';
    expect(Number.isNaN(Date.parse(first))).toBe(false);
    db.close();
  });

  it('delete 之后回到 null', () => {
    const { db, settings } = repo();
    settings.set('etf.spotSource', 'sina');
    settings.delete('etf.spotSource');
    expect(settings.get('etf.spotSource')).toBeNull();
    db.close();
  });

  it('多个键互不影响，按 key 排序返回', () => {
    const { db, settings } = repo();
    settings.set('etf.spotSource', 'sina');
    settings.set('app.other', 'x');
    expect(settings.all().map((row) => row.key)).toEqual(['app.other', 'etf.spotSource']);
    db.close();
  });
});
