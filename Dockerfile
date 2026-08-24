# Worker daemon image: runs folds, event reactors, and the job queue against
# the database configured by DATABASE_URL.
# Dependency layer first: as long as the lockfile and package manifests are
# unchanged, `pnpm install` is a builder cache hit and rebuilds take seconds.
FROM node:23-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY kernel/log/package.json kernel/log/package.json
COPY kernel/schema/package.json kernel/schema/package.json
COPY kernel/process/package.json kernel/process/package.json
COPY userland/folds/package.json userland/folds/package.json
COPY userland/reactors/package.json userland/reactors/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/ui/package.json apps/ui/package.json
RUN pnpm install --frozen-lockfile
COPY . .
CMD ["pnpm", "nc", "daemon"]
