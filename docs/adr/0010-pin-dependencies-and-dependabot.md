# 0010: CI・ビルドの依存を固定し、Dependabot で月に一度更新する

- ステータス: 採用（Node の版と corepack の入れ方は [0014](0014-node-24-and-corepack-from-npm.md) で更新）
- 日付: 2026-10-05

## 背景

CI のアクションはタグ（`@v7` など）、Docker のベースイメージは `node:22-slim`、pnpm はバージョン番号だけで指定していた。タグは後から別のコミットや別のイメージに付け替えられるため、上流が乗っ取られると、こちらが何も変えなくても CI やビルドに別のコードが入る（GitHub issue #9）。一方で、固定したままにすると更新が止まり、脆弱性の修正も入らなくなる。

## 決定

- CI のサードパーティのアクションは 40 文字のコミット SHA で固定し、行末に `# vX.Y.Z` を書く。`actions/checkout` は `persist-credentials: false` にする
- Docker のベースイメージは `node:22-slim@sha256:...`（マルチアーキテクチャのインデックスの digest）で固定する
- `server/package.json` の `packageManager` に pnpm のバージョンと sha512 を書く。pnpm 12 はこれを `pnpm-lock.yaml` の先頭（`packageManagerDependencies`）にも記録するので、ロックファイルも合わせて更新する
- CI と Dockerfile では `corepack enable` のあと `server/` で `corepack install` を実行し、`packageManager` を読んで pnpm を入れる。このとき sha512 が検査され、一致しなければ失敗する。`corepack prepare pnpm@<版> --activate` はハッシュなしで取得してキャッシュし、以後の `pnpm` はそのキャッシュを使うため検査されなくなるので使わない
- `pnpm-workspace.yaml` に `minimumReleaseAge: 1440` を入れ、公開から 1 日経っていない版は入れない。明示的に設定すると厳格に扱われる（`pnpm-workspace.yaml` のコメントを参照）
- 更新は Dependabot に任せる。対象は github-actions・docker・npm・gradle、頻度は月に一度、マイナー・パッチはエコシステムごとに 1 つの PR にまとめる
- Gradle の依存検証（`verification-metadata.xml`）は入れない

## 検討した選択肢

| 選択肢 | 長所 | 短所 |
|---|---|---|
| **SHA・digest で固定し、Dependabot で月に一度更新する** | 上流のタグの付け替えの影響を受けない。更新は PR として見える | 月に数件の PR を確認する手間がかかる |
| タグのまま使う（従来） | 手間がかからない | 上流が乗っ取られると気づかずに取り込む |
| 固定するが自動更新はしない | PR が来ない | 更新が止まり、脆弱性の修正が入らない |
| Gradle の依存検証も入れる | Android の依存の改ざんも検出できる | 依存を更新するたびにメタデータの再生成が必要で、Dependabot の PR がそのままでは通らない。個人のプロジェクトとしては手間に見合わない |

## 結果

- CI とビルドに入るアクション・イメージ・pnpm が、レビューした版に限られる
- Dependabot の PR を月に一度確認して取り込む必要がある
- pnpm のバージョンを上げるときは `packageManager`（ハッシュを含む）と `pnpm-lock.yaml` をまとめて更新する。CI と Dockerfile は `packageManager` を読むので変更しなくてよい
- GitHub の Dependabot のドキュメントが pnpm の対応を明記しているのは v10 までで、pnpm 12 のロックファイル（先頭の `packageManagerDependencies` の文書を含む）を Dependabot が正しく更新できるかは未確認。最初の実行で確かめる。npm の PR が `--frozen-lockfile` で失敗する場合は、これが原因である可能性が高い
- Android の依存はロックや検証をしていないため、Gradle のリポジトリ側の改ざんは検出できない

## 参考

- https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions
- https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference
- https://pnpm.io/settings#minimumreleaseage
- https://github.com/nodejs/corepack#corepack-install
- https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories
