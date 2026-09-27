import type { IndexRegionKey } from './model.ts';

/**
 * 国际指数的**静态符号映射表** —— 本工具最核心的资产。
 *
 * 每个指数登记：内部键（URL/API 参数）、中文名、地区、原生币种、交易所时区，
 * 以及**四个上游**的代码（见 `docs/design/global-index-data-sources.md` §10 覆盖矩阵
 * 与 §14 的 akshare 复盘勘误）。
 *
 * 改表前必读的实测铁律：
 *
 * 1. **东财缺 4 个**：纳指 100 / 罗素 2000 / VIX / 恒生科技（`em: null`，只能靠 Yahoo）。
 *    ⚠️ 2026-09-27 勘误：旧结论「东财还缺恒生国企/TSX」是**代码猜错**
 *    （`100.HSCE`/`100.GSPTSE` 不存在），正确代码是 `100.HSCEI`/`100.TSX` ——
 *    线索来自 akshare `index/cons.py` 的符号表，clist 单请求实测返回。
 * 2. **东财 `100.NDX` 是纳斯达克「综合」指数**（收盘与 Yahoo `^IXIC` 一致），
 *    不是纳指 100 —— 代码同名不同义，靠收盘价交叉验证发现的陷阱。
 * 3. **新浪要分两套接口说**：旧的实时 `hq.sinajs.cn/list=int_*` 数据陈旧（整源弃用，
 *    报告 §7.1）；akshare 新线索 `gi.finance.sina.com.cn/hq/daily` 的**日线实测新鲜**
 *    （2026-09-27 与 Yahoo 逐日一致），已实装且为**稳定性主源之一** —— `sina` 字段
 *    就是它的符号，**只覆盖欧亚/美洲/大洋洲，美股与恒指系没有**（实测 INX/DJI/NDX/HSI 均 not found）。
 *
 * 另有**腾讯稳定性主源之一**（`tencent` 字段）：2026-09-26 复测只覆盖 5 个指数
 * （标普/纳综/纳指100/道指/恒生，K 线上限 1600 行），与新浪**互补不重叠**，
 * 一起承担国内直连的主供数；Yahoo 退为最后兜底。
 * ⚠️ 已知怪癖：**腾讯 `usNDX` 的 K 线只回 1 根**（实测 1600 行请求也只给当日）——
 * 纳指100 靠腾讯只能拿到「最新价」，历史要等 Yahoo 恢复后回填（upsert 自愈）。
 *
 * 新增指数前先在调研报告的覆盖矩阵里核对各源代码，否则会静默缺数据。
 */

export interface IndexDefinition {
  /** 内部主键：API 与 URL 参数（如 `?code=SPX`），全表唯一 */
  key: string;
  /** 中文展示名 */
  name: string;
  region: IndexRegionKey;
  /** 原生计价币种（ISO 4217）——页面不做换算，只用于标注 */
  currency: string;
  /** 交易所时区（IANA）：用于「最新收盘」的时间口径提示 */
  timeZone: string;
  /** Yahoo Finance 符号（兜底源，覆盖全部指数、历史最深，但直连常 429） */
  yahoo: string;
  /** 东方财富 secid（备源；null = 东财无此指数，见铁律 1） */
  em: string | null;
  /** 腾讯行情代码（稳定性主源之一；null = 腾讯无此指数，只覆盖美/港 5 个） */
  tencent: string | null;
  /** 新浪环球市场符号（稳定性主源之一；null = 新浪无此指数 —— 美股与恒指系） */
  sina: string | null;
}

export const INDEX_REGISTRY: readonly IndexDefinition[] = [
  // 美国（新浪 gi 无美股代码，兜底靠腾讯/东财）
  {
    key: 'SPX',
    name: '标普500',
    region: 'us',
    currency: 'USD',
    timeZone: 'America/New_York',
    yahoo: '^GSPC',
    em: '100.SPX',
    tencent: 'usINX', // 实测 param=usINX → data["us.INX"]
    sina: null,
  },
  {
    key: 'IXIC',
    name: '纳斯达克综合',
    region: 'us',
    currency: 'USD',
    timeZone: 'America/New_York',
    yahoo: '^IXIC',
    em: '100.NDX', // ⚠ 东财代码叫 NDX 但值是综合指数（铁律 2）
    tencent: 'usIXIC',
    sina: null,
  },
  {
    key: 'NDX',
    name: '纳斯达克100',
    region: 'us',
    currency: 'USD',
    timeZone: 'America/New_York',
    yahoo: '^NDX',
    em: null, // 铁律 1：东财无纳指 100 现货
    tencent: 'usNDX',
    sina: null,
  },
  {
    key: 'DJI',
    name: '道琼斯',
    region: 'us',
    currency: 'USD',
    timeZone: 'America/New_York',
    yahoo: '^DJI',
    em: '100.DJIA',
    tencent: 'usDJI',
    sina: null,
  },
  {
    key: 'RUT',
    name: '罗素2000',
    region: 'us',
    currency: 'USD',
    timeZone: 'America/New_York',
    yahoo: '^RUT',
    em: null,
    tencent: null,
    sina: null,
  },
  {
    key: 'VIX',
    name: 'VIX恐慌指数',
    region: 'us',
    currency: 'USD',
    timeZone: 'America/Chicago',
    yahoo: '^VIX',
    em: null,
    tencent: null,
    sina: null,
  },

  // 中国香港（新浪 gi 无恒指系代码）
  {
    key: 'HSI',
    name: '恒生指数',
    region: 'hk',
    currency: 'HKD',
    timeZone: 'Asia/Hong_Kong',
    yahoo: '^HSI',
    em: '100.HSI',
    tencent: 'hkHSI',
    sina: null,
  },
  {
    key: 'HSCE',
    name: '恒生国企',
    region: 'hk',
    currency: 'HKD',
    timeZone: 'Asia/Hong_Kong',
    yahoo: '^HSCE',
    em: '100.HSCEI', // 2026-09-27 勘误：不是 100.HSCE（rc=100），akshare cons 表 + clist 实测
    tencent: null,
    sina: null,
  },
  {
    key: 'HSTECH',
    name: '恒生科技',
    region: 'hk',
    currency: 'HKD',
    timeZone: 'Asia/Hong_Kong',
    yahoo: 'HSTECH.HK', // ⚠ `^HSTECH` 是错误写法，实测 404（用搜索接口发现的）
    em: null,
    tencent: null,
    sina: null,
  },

  // 亚太
  {
    key: 'N225',
    name: '日经225',
    region: 'apac',
    currency: 'JPY',
    timeZone: 'Asia/Tokyo',
    yahoo: '^N225',
    em: '100.N225',
    tencent: null,
    sina: 'NKY',
  },
  {
    key: 'KS11',
    name: '韩国KOSPI',
    region: 'apac',
    currency: 'KRW',
    timeZone: 'Asia/Seoul',
    yahoo: '^KS11',
    em: '100.KS11',
    tencent: null,
    sina: 'KOSPI',
  },
  {
    key: 'TWII',
    name: '台湾加权',
    region: 'apac',
    currency: 'TWD',
    timeZone: 'Asia/Taipei',
    yahoo: '^TWII',
    em: '100.TWII',
    tencent: null,
    sina: 'TWJQ',
  },
  {
    key: 'SENSEX',
    name: '印度SENSEX',
    region: 'apac',
    currency: 'INR',
    timeZone: 'Asia/Kolkata',
    yahoo: '^BSESN',
    em: '100.SENSEX',
    tencent: null,
    sina: 'SENSEX',
  },
  {
    key: 'AS51',
    name: '澳大利亚ASX200',
    region: 'apac',
    currency: 'AUD',
    timeZone: 'Australia/Sydney',
    yahoo: '^AXJO',
    em: '100.AS51', // ⚠ 东财是 AS51 不是 AXJO（AXJO 实测 rc=100）
    tencent: null,
    sina: 'AS51',
  },
  {
    key: 'STI',
    name: '新加坡海峡时报',
    region: 'apac',
    currency: 'SGD',
    timeZone: 'Asia/Singapore',
    yahoo: '^STI',
    em: '100.STI',
    tencent: null,
    sina: 'STI',
  },
  {
    key: 'JKSE',
    name: '印尼综合',
    region: 'apac',
    currency: 'IDR',
    timeZone: 'Asia/Jakarta',
    yahoo: '^JKSE',
    em: '100.JKSE',
    tencent: null,
    sina: 'JCI',
  },
  {
    key: 'NZ50',
    name: '新西兰NZX50',
    region: 'apac',
    currency: 'NZD',
    timeZone: 'Pacific/Auckland',
    yahoo: '^NZ50', // 2026-09-27 实测：^NZ55/NZ50.NZ 均无数据，^NZ50 才是 S&P/NZX 50
    em: '100.NZ50',
    tencent: null,
    sina: 'NZ250', // 新浪符号是 NZSE 50 的老代码
  },

  // 欧洲（2026-09-27 依 akshare 线索扩充：斯托克50/SMI/MIB/IBEX/AEX 实测三源齐备）
  {
    key: 'FTSE',
    name: '英国富时100',
    region: 'europe',
    currency: 'GBP',
    timeZone: 'Europe/London',
    yahoo: '^FTSE',
    em: '100.FTSE',
    tencent: null,
    sina: 'UKX',
  },
  {
    key: 'GDAXI',
    name: '德国DAX',
    region: 'europe',
    currency: 'EUR',
    timeZone: 'Europe/Berlin',
    yahoo: '^GDAXI',
    em: '100.GDAXI',
    tencent: null,
    sina: 'DAX',
  },
  {
    key: 'FCHI',
    name: '法国CAC40',
    region: 'europe',
    currency: 'EUR',
    timeZone: 'Europe/Paris',
    yahoo: '^FCHI',
    em: '100.FCHI',
    tencent: null,
    sina: 'CAC',
  },
  {
    key: 'STOXX50',
    name: '欧洲斯托克50',
    region: 'europe',
    currency: 'EUR',
    timeZone: 'Europe/Zurich', // Yahoo meta 实测（^STOXX50E 挂所时区）
    yahoo: '^STOXX50E',
    em: '100.SX5E',
    tencent: null,
    sina: 'SX5E',
  },
  {
    key: 'SMI',
    name: '瑞士SMI',
    region: 'europe',
    currency: 'CHF',
    timeZone: 'Europe/Zurich',
    yahoo: '^SSMI',
    em: '100.SSMI',
    tencent: null,
    sina: 'SWI20', // 新浪是老代码 SWI20，不是 SMI
  },
  {
    key: 'MIB',
    name: '意大利MIB',
    region: 'europe',
    currency: 'EUR',
    timeZone: 'Europe/Rome',
    yahoo: 'FTSEMIB.MI', // ⚠ ^FTMIB 实测无数据，MIL 交易所原生符号才有效
    em: '100.MIB',
    tencent: null,
    sina: 'FTSEMIB',
  },
  {
    key: 'IBEX',
    name: '西班牙IBEX35',
    region: 'europe',
    currency: 'EUR',
    timeZone: 'Europe/Madrid',
    yahoo: '^IBEX',
    em: '100.IBEX',
    tencent: null,
    sina: 'IBEX',
  },
  {
    key: 'AEX',
    name: '荷兰AEX',
    region: 'europe',
    currency: 'EUR',
    timeZone: 'Europe/Amsterdam',
    yahoo: '^AEX',
    em: '100.AEX',
    tencent: null,
    sina: 'AEX',
  },

  // 美洲
  {
    key: 'TSX',
    name: '加拿大TSX',
    region: 'americas',
    currency: 'CAD',
    timeZone: 'America/Toronto',
    yahoo: '^GSPTSE',
    em: '100.TSX', // 2026-09-27 勘误：不是 100.GSPTSE（那是 Yahoo/新浪的代码），clist 实测
    tencent: null,
    sina: 'GSPTSE',
  },
  {
    key: 'MXX',
    name: '墨西哥IPC',
    region: 'americas',
    currency: 'MXN',
    timeZone: 'America/Mexico_City',
    yahoo: '^MXX',
    em: '100.MXX',
    tencent: null,
    sina: 'MXX',
  },
  {
    key: 'BVSP',
    name: '巴西IBOV',
    region: 'americas',
    currency: 'BRL',
    timeZone: 'America/Sao_Paulo',
    yahoo: '^BVSP',
    em: '100.BVSP',
    tencent: null,
    sina: 'IBOV',
  },
];

export function getIndexDefinition(key: string): IndexDefinition | undefined {
  return INDEX_REGISTRY.find((entry) => entry.key === key);
}

/** 按地区分组（保持注册表内的先后顺序），服务端概览与前端测试共用 */
export function groupRegistryByRegion(): Map<IndexRegionKey, IndexDefinition[]> {
  const groups = new Map<IndexRegionKey, IndexDefinition[]>();
  for (const entry of INDEX_REGISTRY) {
    const list = groups.get(entry.region);
    if (list) list.push(entry);
    else groups.set(entry.region, [entry]);
  }
  return groups;
}
