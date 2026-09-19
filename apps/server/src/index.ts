import { buildApp } from './app.ts';

const { app, config, scheduler, db } = await buildApp();

if (config.jobsEnabled) {
  scheduler.start();
} else {
  app.log.info(
    '定时任务未启用（JOBS_ENABLED=false）。本地开发可调用 POST /api/tools/qdii/refresh 手动拉取。',
  );
}

await app.listen({ host: config.host, port: config.port });

app.log.info(
  {
    url: `http://${config.host}:${config.port}`,
    db: config.dbPath,
    timezone: config.timezone,
    jobsEnabled: config.jobsEnabled,
  },
  'funds-helper 服务已启动',
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, '正在关闭服务…');
  scheduler.stop();
  await app.close();
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
