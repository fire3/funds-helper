#!/usr/bin/env node
/**
 * 端到端冒烟测试：用**真实的 Node 运行时**启动服务，打真实的接口。
 *
 * 为什么必须有这一步：vitest 用 esbuild 转译 TS，而生产用 Node 原生的
 * strip-only 模式 —— 两者的语法支持不同（例如构造函数参数属性 esbuild 支持、
 * Node 不支持）。只有在真实运行时跑一次，才能发现这类「测试全绿但起不来」的问题。
 *
 * 用法：pnpm smoke            （会访问真实上游，约 1 次 4MB 请求）
 *      SMOKE_PORT=9001 pnpm smoke
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = Number(process.env.SMOKE_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = resolve(import.meta.dirname, '..');
const SERVER_ENTRY = join(ROOT, 'apps/server/src/index.ts');
const WEB_DIST = join(ROOT, 'apps/web/dist');

const checks = [];
let server;

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function getJson(path) {
  const response = await fetch(`${BASE}${path}`);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'funds-helper-smoke-'));
  const dbPath = join(dataDir, 'smoke.db');

  console.log(`启动服务：${SERVER_ENTRY}（端口 ${PORT}，临时库 ${dbPath}）\n`);

  server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DB_PATH: dbPath,
      JOBS_ENABLED: 'false',
      LOG_LEVEL: 'warn',
      TZ: 'Asia/Shanghai',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const ready = await waitForHealth();
  if (!ready) {
    console.error('服务未能在 30 秒内就绪。stderr：\n', stderr);
    return 1;
  }
  check('服务可启动并响应 /api/health', true);

  const health = await getJson('/api/health');
  check('health 状态为 ok', health.body?.status === 'ok', `status=${health.body?.status}`);
  check('工具清单包含 qdii', health.body?.tools?.some((tool) => tool.id === 'qdii') === true);
  check('工具清单包含 usd', health.body?.tools?.some((tool) => tool.id === 'usd') === true);
  check('工具清单包含 etf', health.body?.tools?.some((tool) => tool.id === 'etf') === true);

  const tools = await getJson('/api/tools');
  check('GET /api/tools 正常', tools.status === 200, `HTTP ${tools.status}`);

  // ---- 真实上游抓取 ----
  const refreshResponse = await fetch(`${BASE}/api/tools/qdii/refresh`, { method: 'POST' });
  const refresh = await refreshResponse.json().catch(() => null);
  check(
    'POST /refresh 成功拉取上游',
    refreshResponse.ok && refresh?.ok === true,
    refreshResponse.ok ? `total=${refresh?.total}` : JSON.stringify(refresh),
  );
  if (!refreshResponse.ok) {
    console.error('\n上游抓取失败，跳过后续依赖数据的检查。');
    return 1;
  }
  check('QDII 数量达到预期下限（≥500）', refresh.total >= 500, `total=${refresh.total}`);

  const dataset = await getJson('/api/tools/qdii/dataset');
  check('GET /dataset 正常', dataset.status === 200, `HTTP ${dataset.status}`);

  const data = dataset.body;
  check(
    '数据集总数与抓取一致',
    data?.total === refresh.total,
    `${data?.total} vs ${refresh.total}`,
  );

  const regionSum = (data?.categories?.regions ?? []).reduce((sum, item) => sum + item.count, 0);
  const themeSum = (data?.categories?.themes ?? []).reduce((sum, item) => sum + item.count, 0);
  check(
    '双维度归类无遗漏',
    regionSum === data?.total && themeSum === data?.total,
    `regions=${regionSum} themes=${themeSum} total=${data?.total}`,
  );

  const sample = data?.funds?.find((fund) => fund.code === '270042');
  check(
    '样例基金已归类并带可展示文案',
    Boolean(sample?.region && sample?.theme && sample?.limitText),
    sample ? `${sample.region}/${sample.theme}/${sample.limitText}` : '未找到 270042',
  );

  const detailResponse = await fetch(`${BASE}/api/tools/qdii/funds/270042`);
  const detail = await detailResponse.json().catch(() => null);
  check(
    'GET /funds/270042 正常',
    detailResponse.ok && detail?.code === '270042',
    detailResponse.ok ? `净值点 ${detail?.navTrend?.length}，公告 ${detail?.notices?.length}` : '',
  );

  const premium = await getJson('/api/tools/qdii/premium');
  check(
    'GET /premium 返回场内溢价',
    premium.status === 200 && (premium.body?.items?.length ?? 0) > 0,
    `${premium.body?.items?.length ?? 0} 只`,
  );

  const changes = await getJson('/api/tools/qdii/changes');
  check('GET /changes 正常', changes.status === 200);

  // ---- 美元份额工具（复用同一份全市场快照，按币种筛选）----
  const usdRefreshResponse = await fetch(`${BASE}/api/tools/usd/refresh`, { method: 'POST' });
  const usdRefresh = await usdRefreshResponse.json().catch(() => null);
  check(
    'POST /api/tools/usd/refresh 成功拉取上游',
    usdRefreshResponse.ok && usdRefresh?.ok === true,
    usdRefreshResponse.ok ? `total=${usdRefresh?.total}` : JSON.stringify(usdRefresh),
  );

  const usdDataset = await getJson('/api/tools/usd/dataset');
  check('GET /api/tools/usd/dataset 正常', usdDataset.status === 200, `HTTP ${usdDataset.status}`);
  check(
    '美元份额数量达到预期下限（≥100）',
    (usdDataset.body?.total ?? 0) >= 100,
    `total=${usdDataset.body?.total}`,
  );

  const usdFunds = usdDataset.body?.funds ?? [];
  const usdSample = usdFunds[0];
  check(
    '美元份额记录带份额形式与额度文案',
    Boolean(usdSample?.usdKind && usdSample?.limitText),
    usdSample ? `${usdSample.code} ${usdSample.usdKind} ${usdSample.limitText}` : '无记录',
  );
  check(
    '存在现汇/现钞份额',
    usdFunds.some((fund) => fund.usdKind === '现汇' || fund.usdKind === '现钞'),
    `${usdFunds.filter((fund) => fund.usdKind !== '未标注').length} 只`,
  );

  if (usdSample?.code) {
    const usdDetailResponse = await fetch(`${BASE}/api/tools/usd/funds/${usdSample.code}`);
    const usdDetail = await usdDetailResponse.json().catch(() => null);
    check(
      'GET /api/tools/usd/funds/:code 正常',
      usdDetailResponse.ok && usdDetail?.code === usdSample.code,
      usdDetailResponse.ok ? `净值点 ${usdDetail?.navTrend?.length}` : '',
    );
  }

  // ---- 汇率工具（独立上游：新浪财经，全量历史一次返回）----
  check('工具清单包含 fx', health.body?.tools?.some((tool) => tool.id === 'fx') === true);

  const fxRefreshResponse = await fetch(`${BASE}/api/tools/fx/refresh`, { method: 'POST' });
  const fxRefresh = await fxRefreshResponse.json().catch(() => null);
  check(
    'POST /api/tools/fx/refresh 成功拉取上游',
    fxRefreshResponse.ok && fxRefresh?.ok === true,
    fxRefreshResponse.ok ? `bars=${fxRefresh?.bars}` : JSON.stringify(fxRefresh),
  );
  check(
    '汇率日线数量达到预期下限（≥5000，实测约 8000）',
    (fxRefresh?.bars ?? 0) >= 5000,
    `bars=${fxRefresh?.bars}`,
  );

  const fxDataset = await getJson('/api/tools/fx/dataset?range=5y');
  check('GET /api/tools/fx/dataset 正常', fxDataset.status === 200, `HTTP ${fxDataset.status}`);

  const fx = fxDataset.body;
  check(
    '汇率走势点数与历史跨度合理',
    (fx?.points?.length ?? 0) > 200 && (fx?.summary?.totalBars ?? 0) >= 5000,
    `points=${fx?.points?.length} totalBars=${fx?.summary?.totalBars} ${fx?.summary?.firstDate}~${fx?.summary?.lastDate}`,
  );
  check(
    '最新汇率落在合理区间（1 美元 = 5~9 元）',
    (fx?.summary?.latest?.rate ?? 0) > 5 && (fx?.summary?.latest?.rate ?? 0) < 9,
    `latest=${fx?.summary?.latest?.rate} (${fx?.summary?.latest?.date})`,
  );
  check(
    '年度统计覆盖多年（「数年波动」的核心证据）',
    (fx?.yearly?.length ?? 0) >= 10,
    `${fx?.yearly?.length} 年`,
  );
  check(
    '区间涨跌表包含全部统计区间',
    (fx?.intervals?.length ?? 0) === 8,
    `${fx?.intervals?.length} 个区间`,
  );

  const fxReverse = await getJson('/api/tools/fx/dataset?range=5y&direction=CNY%2FUSD');
  const fxLatest = fx?.summary?.latest?.rate ?? 0;
  const fxInverse = fxReverse.body?.summary?.latest?.rate ?? 0;
  check(
    'CNY/USD 方向是倒数（涨跌幅在服务端重算，前端不取倒数）',
    fxLatest > 0 && Math.abs(fxInverse - 1 / fxLatest) < 1e-9,
    `USD/CNY=${fxLatest} CNY/USD=${fxInverse}`,
  );

  // ---- ETF 汇总 ----
  const etfRefreshResponse = await fetch(`${BASE}/api/tools/etf/refresh`, { method: 'POST' });
  const etfRefresh = await etfRefreshResponse.json().catch(() => null);
  check(
    'POST /api/tools/etf/refresh 成功拉取上游（行情 + 目录）',
    etfRefreshResponse.ok && etfRefresh?.ok === true,
    etfRefreshResponse.ok
      ? `spot=${etfRefresh?.spot} profile=${etfRefresh?.profile} ${etfRefresh?.dataDate} 渠道=${etfRefresh?.source}`
      : JSON.stringify(etfRefresh),
  );
  check(
    'ETF 刷新返回行情渠道（默认优先东财；ETF_EASTMONEY_ENABLED=0 只走新浪）',
    ['eastmoney', 'sina'].includes(etfRefresh?.source),
    `source=${etfRefresh?.source}`,
  );

  const etfDataset = await getJson('/api/tools/etf/dataset');
  check('GET /api/tools/etf/dataset 正常', etfDataset.status === 200, `HTTP ${etfDataset.status}`);

  const etf = etfDataset.body;
  // 渠道能力不同（东财有折溢价，新浪没有）：下面的断言按**实际**渠道分流
  const etfPremium = !(etf?.dataSource?.missing ?? []).includes('折溢价率');
  check(
    '数据集带行情渠道信息（无折溢价能力的渠道必须显式声明缺失字段）',
    ['eastmoney', 'sina'].includes(etf?.dataSource?.id) &&
      etfPremium === ((etf?.dataSource?.missing?.length ?? 0) === 0),
    `渠道=${etf?.dataSource?.name ?? '--'}${
      etfPremium ? '' : `（缺 ${(etf?.dataSource?.missing ?? []).join('/')}）`
    }`,
  );
  check(
    '全市场 ETF 数量与实测口径一致（>= 1500）',
    (etf?.total ?? 0) >= 1500,
    `total=${etf?.total}`,
  );
  check(
    '目录（跟踪指数）已 join（覆盖率 > 90%）',
    (etf?.stats?.coverage?.profile ?? 0) >= (etf?.total ?? 0) * 0.9,
    `profile=${etf?.stats?.coverage?.profile} spot=${etf?.stats?.coverage?.spot} unlisted=${etf?.stats?.coverage?.unlisted}`,
  );
  check(
    '分类分布覆盖宽基与行业主题（标志位解析正确）',
    (etf?.stats?.byCategory ?? []).some((item) => item.category === '宽基') &&
      (etf?.stats?.byCategory ?? []).some((item) => item.category === '行业主题'),
    (etf?.stats?.byCategory ?? []).map((item) => `${item.category}:${item.count}`).join(' '),
  );
  if (etfPremium) {
    check(
      '折溢价分布有数据且给出最贵/最便宜',
      (etf?.stats?.premium?.counts?.溢价 ?? 0) + (etf?.stats?.premium?.counts?.折价 ?? 0) > 0 &&
        etf?.stats?.premium?.maxDiscount != null,
      `最贵 ${etf?.stats?.premium?.maxPremium?.name ?? '--'} / 最便宜 ${etf?.stats?.premium?.maxDiscount?.name ?? '--'}`,
    );
  } else {
    check(
      '无折溢价能力的渠道下折溢价必须是「未知」而不是 0（不能把缺失当平价）',
      (etf?.stats?.premium?.counts?.溢价 ?? 0) === 0 &&
        (etf?.stats?.premium?.counts?.折价 ?? 0) === 0 &&
        etf?.stats?.premium?.unknown === etf?.total &&
        etf?.funds?.every((fund) => fund.premiumRate === null && fund.premiumText === '—'),
      `${etf?.dataSource?.name}：未知 ${etf?.stats?.premium?.unknown}/${etf?.total}`,
    );
  }

  const etfConfig = await getJson('/api/tools/etf/config');
  check(
    'GET /api/tools/etf/config 提供可切换的行情渠道（且「实际渠道」与数据集一致）',
    etfConfig.status === 200 &&
      ['eastmoney', 'sina'].includes(etfConfig.body?.spotSource) &&
      (etfConfig.body?.sources ?? []).length === 2 &&
      etfConfig.body?.activeSource === etf?.dataSource?.id,
    `偏好=${etfConfig.body?.spotSource} 实际=${etfConfig.body?.activeSource} 数据集=${etf?.dataSource?.id}`,
  );

  check(
    '规模合计量级合理（1 万亿 ~ 20 万亿）',
    (etf?.stats?.totalScale ?? 0) > 1e12 && (etf?.stats?.totalScale ?? 0) < 2e13,
    `${((etf?.stats?.totalScale ?? 0) / 1e12).toFixed(2)} 万亿`,
  );

  // 无折溢价能力的渠道只要求「跟踪指数 + 行情」这一半（用于后面打详情接口）
  const etfSample = (etf?.funds ?? []).find(
    (fund) => fund.indexName && (!etfPremium || fund.premiumRate !== null),
  );
  check(
    etfPremium
      ? '存在同时有跟踪指数与折溢价数据的 ETF'
      : '无折溢价能力的渠道下仍存在带跟踪指数的 ETF',
    Boolean(etfSample),
    etfSample ? `${etfSample.code} ${etfSample.indexName} ${etfSample.premiumText}` : '无',
  );

  if (etfSample?.code) {
    const etfDetailResponse = await fetch(`${BASE}/api/tools/etf/funds/${etfSample.code}`);
    const etfDetail = await etfDetailResponse.json().catch(() => null);
    check(
      'GET /api/tools/etf/funds/:code 正常（含费率与通用区块）',
      etfDetailResponse.ok &&
        etfDetail?.code === etfSample.code &&
        Boolean(etfDetail?.profile?.managementFee) &&
        (etfDetail?.navTrend?.length ?? 0) > 0,
      etfDetailResponse.ok
        ? `管理费 ${etfDetail?.profile?.managementFee} 净值点 ${etfDetail?.navTrend?.length}`
        : JSON.stringify(etfDetail),
    );
  }

  // ---- 错误处理 ----
  const badCode = await fetch(`${BASE}/api/tools/qdii/funds/abc`);
  check('非法基金代码返回 400', badCode.status === 400, `HTTP ${badCode.status}`);

  const missing = await fetch(`${BASE}/api/tools/qdii/funds/999999`);
  check('未知基金返回 404', missing.status === 404, `HTTP ${missing.status}`);

  const notFound = await fetch(`${BASE}/api/nope`);
  check('未知 API 返回 JSON 404', notFound.status === 404);

  // ---- 前端静态资源（仅在已构建时检查）----
  if (existsSync(WEB_DIST)) {
    const home = await fetch(`${BASE}/`);
    check(
      '托管前端首页',
      home.status === 200 && (home.headers.get('content-type') ?? '').includes('html'),
    );
    const spa = await fetch(`${BASE}/tools/qdii/270042`);
    check('SPA 路由回退', spa.status === 200);
  } else {
    console.log('  · 未构建前端（apps/web/dist 不存在），跳过静态资源检查');
  }

  // ---- 幂等性 ----
  const again = await fetch(`${BASE}/api/tools/qdii/refresh`, { method: 'POST' });
  const second = await again.json().catch(() => null);
  check('重复抓取幂等（inserted = 0）', second?.inserted === 0, `inserted=${second?.inserted}`);

  const fxAgain = await fetch(`${BASE}/api/tools/fx/refresh`, { method: 'POST' });
  const fxSecond = await fxAgain.json().catch(() => null);
  check(
    '汇率重复抓取幂等（inserted = 0）',
    fxSecond?.inserted === 0,
    `inserted=${fxSecond?.inserted}`,
  );

  // 场外联接基金：契约为先（反查是独立慢链路，见下）
  check(
    'ETF 数据集带场外联接基金字段（每只 ETF 都有 feederFunds 数组，覆盖度自洽）',
    typeof etf?.feeder === 'object' &&
      etf?.feeder !== null &&
      (etf.feeder.updatedAt === null || typeof etf.feeder.updatedAt === 'string') &&
      typeof etf.feeder.etfCount === 'number' &&
      typeof etf.feeder.fundCount === 'number' &&
      // 一只 ETF 至少有一个联接份额（而且大概率不止一个）→ ETF 数不该超过基金数
      etf.feeder.etfCount <= etf.feeder.fundCount &&
      (etf?.funds ?? []).every((fund) => Array.isArray(fund.feederFunds)),
    `更新于 ${etf?.feeder?.updatedAt ?? '尚未反查'}，${etf?.feeder?.etfCount} 只 ETF / ${etf?.feeder?.fundCount} 只联接基金`,
  );

  // 全量反查要打约 2300 个请求（≈4 分钟），因此默认不在冒烟里跑；
  // 显式 SMOKE_FEEDERS=1 时才验证真实链路（改了反查逻辑请跑一次）。
  if (process.env.SMOKE_FEEDERS === '1') {
    const feederResponse = await fetch(`${BASE}/api/tools/etf/feeders/refresh?full=1`, {
      method: 'POST',
    });
    const feeder = await feederResponse.json().catch(() => null);
    check(
      'POST /api/tools/etf/feeders/refresh?full=1 全量反查成功',
      feederResponse.ok && (feeder?.mapped ?? 0) >= 2000 && (feeder?.failed ?? 1) === 0,
      `scanned=${feeder?.scanned} mapped=${feeder?.mapped} empty=${feeder?.empty} failed=${feeder?.failed} ${((feeder?.durationMs ?? 0) / 1000).toFixed(1)}s`,
    );

    const after = (await getJson('/api/tools/etf/dataset')).body;
    const withFeeder = (after?.funds ?? []).filter((fund) => fund.feederFunds.length > 0);
    check(
      '反查覆盖率合理（≥900 只 ETF 有场外联接基金）',
      (after?.feeder?.etfCount ?? 0) >= 900 && withFeeder.length === (after?.feeder?.etfCount ?? 0),
      `etfCount=${after?.feeder?.etfCount} fundCount=${after?.feeder?.fundCount}`,
    );

    const hs300 = (after?.funds ?? []).find((fund) => fund.code === '510300');
    check(
      '抽样：510300 的联接份额（A/C/I/Y）都在',
      (hs300?.feederFunds?.length ?? 0) >= 3 &&
        hs300.feederFunds.every((fund) => /^\d{6}$/.test(fund.code) && fund.name.length > 0),
      (hs300?.feederFunds ?? []).map((fund) => `${fund.code} ${fund.name}`).join('，'),
    );
  } else {
    console.log('  - 跳过场外联接基金全量反查（设 SMOKE_FEEDERS=1 可开启，约 4 分钟）');
  }

  const etfAgain = await fetch(`${BASE}/api/tools/etf/refresh`, { method: 'POST' });
  const etfSecond = await etfAgain.json().catch(() => null);
  check(
    'ETF 同日重复抓取幂等（inserted = 0）',
    etfSecond?.inserted === 0,
    `inserted=${etfSecond?.inserted}`,
  );

  rmSync(dataDir, { recursive: true, force: true });
  return 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error('\n冒烟测试异常：', error);
  exitCode = 1;
} finally {
  server?.kill('SIGTERM');
}

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 项检查通过`);
if (failed.length > 0) {
  console.error('失败项：', failed.map((item) => item.name).join('、'));
  exitCode = 1;
}
process.exit(exitCode);
