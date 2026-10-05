# 0014: サーバーの Node を 24 にし、corepack は npm で固定版を入れる

- ステータス: 採用
- 日付: 2026-10-06

## 背景

Dependabot から Node 22 → 26 のベースイメージ更新が提案された（PR #15、Issue #26）。そのまま取り込めなかった理由は次のとおり。

- Node 25 以降は corepack が同梱されない（Node の TSC が 2025-03 に決定）。[0010](0010-pin-dependencies-and-dependabot.md) では、Node に同梱の corepack で `corepack enable && corepack install` を実行し、`packageManager` の sha512 を検査させて pnpm を入れている。`node:26-slim` ではこの手順が失敗し、`fly deploy` ができなくなる
- CI は Docker イメージをビルドしていなかった。そのため、この失敗が CI で見えなかった（PR #15 の CI は成功していた）
- 2026-10 時点で Node 26 は Current で、LTS ではない。Node 24 は LTS で、EOL は 2028-04-30
- Dependabot はメジャー更新を LTS かどうかに関係なく提案する。#17 では `@types/node` だけが 26 になり、実行環境（22）と食い違っていた

## 決定

- サーバーの Node を 24 にする。Dockerfile の `FROM`（digest 固定）、CI の `node-version`、`engines.node`（`>=24`）、`@types/node`（`^24`）をそろえる
- corepack は Node の同梱版を使わず、`npm install -g corepack@<固定版>` で入れる。版は Dockerfile の `ARG COREPACK_VERSION` と CI の `pnpm を有効化` のステップに書き、手で合わせる。その後の `corepack enable && corepack install` で sha512 を検査する手順は 0010 のまま
- CI に、本番と同じ Dockerfile でイメージをビルドするジョブ（push しない）を追加する
- Dependabot では、Docker の `node` と npm の `@types/node` のメジャー更新を対象から外す。Node のメジャー更新は、LTS の時期に合わせて Issue を立てて手で行う

## 検討した選択肢

| 選択肢 | 長所 | 短所 |
|---|---|---|
| **npm で corepack の固定版を入れる** | `packageManager` の sha512 検査をそのまま使える。Docker と CI で同じ手順。Node の版に依存しない | corepack 自体の完全性は npm レジストリの integrity に頼る。corepack の版は Dependabot で更新されないので手で上げる |
| Node 24 同梱の corepack を使い続ける | 変更が最小 | Node 25 以降に上げるときに同じ問題が起きる |
| pnpm/action-setup・pnpm/setup | Actions では手軽 | Docker では使えない。`packageManager` の sha512 とは照合しない |
| `npm install -g pnpm@<版>`・スタンドアロンのインストーラ | corepack が要らない | `packageManager` の sha512 と照合しない。版を 2 か所で管理することになる |
| pnpm 自身のバージョン管理（`pmOnFail` など） | ロックファイルに版とハッシュが残る | 最初の pnpm を別の方法で入れる必要があり、問題が解決しない |

## 結果

- 同じ Dockerfile で `node:24-slim` と `node:26-slim` のどちらもビルドでき、コンテナが起動することを手元で確かめた。今後 Node を上げるときに、pnpm の入れ方は変えなくてよい
- `packageManager` の sha512 を書き換えると、`corepack install` が `Mismatch hashes` で失敗することを確かめた（npm で入れた corepack 0.36.0）
- Dockerfile の誤りが CI で見つかるようになる。ビルドキャッシュは GitHub Actions のキャッシュに置く。書き込めない場合もビルドは失敗させない
- corepack の版は Dependabot の対象外なので、Node のメジャー更新のときなどに合わせて見直す
- Node のメジャー更新の PR は来なくなるので、LTS の切り替わりを自分で追う必要がある。Node 24 は 2028-04-30 まで

## 参考

- https://nodejs.org/en/about/previous-releases
- https://nodejs.org/docs/latest-v24.x/api/corepack.html
- https://github.com/nodejs/corepack/issues/688
- https://github.com/nodejs/corepack#corepack-install
- https://docs.docker.com/build/ci/github-actions/cache/
- https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference#ignore--
