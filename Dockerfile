# 与开发环境保持同一 Node 大版本：node:sqlite 与原生 TS strip 的行为跨版本可能有差异。
# 本机（Node 26）已验证 `node apps/server/src/index.ts` 可直接运行。
FROM node:26-alpine

WORKDIR /app

# 先只拷贝依赖清单，让 pnpm install 这一层能被有效缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/sources/package.json packages/sources/
RUN corepack enable && pnpm install --frozen-lockfile

# 再拷贝源码。服务端无需构建 —— Node 直接执行 TS 源码（见 architecture.md D7），
# 所以镜像里只有前端需要一次构建。
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm --filter @funds-helper/web build

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/app/data/funds.db \
    TZ=Asia/Shanghai \
    SERVE_STATIC=true \
    JOBS_ENABLED=true

# SQLite 落库目录（volume 挂载点），以 node 用户运行以便写入
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 8787
VOLUME ["/app/data"]

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/src/index.ts"]
