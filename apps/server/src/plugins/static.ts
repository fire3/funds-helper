import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * 生产环境：由本服务同时托管 API 与前端静态资源（单容器即可部署）。
 * 开发环境前端跑在 Vite 上，此插件不生效。
 *
 * SPA 回退：非 /api 前缀且未命中文件的 GET 一律返回 index.html，
 * 否则刷新 /tools/qdii 这种前端路由会 404。
 */
export async function registerStatic(app: FastifyInstance, distPath: string): Promise<boolean> {
  const root = resolve(distPath);
  if (!existsSync(root)) return false;

  await app.register(fastifyStatic, { root, wildcard: false, index: ['index.html'] });

  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api')) {
      return reply.sendFile('index.html');
    }
    return reply
      .status(404)
      .send({ error: { code: 'NOT_FOUND', message: `未找到 ${request.method} ${request.url}` } });
  });

  app.log.info({ root }, '已托管前端构建产物');
  return true;
}
