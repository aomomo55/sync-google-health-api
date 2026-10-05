# ベースイメージは digest で固定する（更新は Dependabot が提案する）
# pnpm は package.json の packageManager に書いた版を corepack install で入れる。
# corepack prepare で先に入れるとキャッシュが使われ、sha512 が検査されないため使わない
# ビルド用: 依存を全部入れて TypeScript をコンパイルする
FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack install
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# 実行用: 本番の依存とビルド結果だけを持つ
FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
WORKDIR /app
ENV NODE_ENV=production
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack install \
  && pnpm install --frozen-lockfile --prod \
  && corepack disable
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
