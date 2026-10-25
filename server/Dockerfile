# ベースイメージは digest で固定する（更新は Dependabot が提案する）
# pnpm は package.json の packageManager に書いた版を corepack install で入れる。
# corepack prepare で先に入れるとキャッシュが使われ、sha512 が検査されないため使わない
# corepack は Node 25 以降に同梱されないため、Node の版に関係なく npm で固定版を入れる（ADR 0014）
# 版は .github/workflows/ci.yml と audit.yml の「pnpm を有効化」に合わせる
ARG COREPACK_VERSION=0.36.0

# ビルド用: 依存を全部入れて TypeScript をコンパイルする
FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
ARG COREPACK_VERSION
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g corepack@${COREPACK_VERSION} \
  && corepack enable && corepack install
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# 実行用: 本番の依存とビルド結果だけを持つ
FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG COREPACK_VERSION
WORKDIR /app
ENV NODE_ENV=production
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g corepack@${COREPACK_VERSION} \
  && corepack enable && corepack install \
  && pnpm install --frozen-lockfile --prod \
  && corepack disable
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
