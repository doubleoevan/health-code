FROM oven/bun:1.4.3
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/health-code/package.json packages/health-code/
COPY apps/mcp/package.json apps/mcp/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY packages/health-code packages/health-code
COPY apps/web apps/web
RUN bun run --cwd packages/health-code build && bun run --cwd apps/web build
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun","run","--cwd","apps/web","start"]
