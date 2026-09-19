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
