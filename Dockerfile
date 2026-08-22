# Worker daemon image: runs folds, event reactors, and the job queue against
# the database configured by DATABASE_URL.
FROM node:23-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "nc", "daemon"]
