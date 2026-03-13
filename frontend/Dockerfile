FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .

# Override .env.local for Docker build.
# All env vars are empty so the browser derives the backend URL at runtime
# from window.location.hostname + NEXT_PUBLIC_BACKEND_PORT (default 8080).
# No Next.js rewrite proxying — the browser talks directly to the backend.
RUN printf 'NEXT_PUBLIC_API_BASE=\nNEXT_PUBLIC_WS_BASE=\nNEXT_PUBLIC_BACKEND_URL=\n' > .env.local

ENV NEXT_OUTPUT=standalone

RUN bun run build

# ── Production stage ──────────────────────────────────────────────────────────
FROM oven/bun:1-slim

WORKDIR /app

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

EXPOSE 3000

CMD ["bun", "run", "server.js"]
