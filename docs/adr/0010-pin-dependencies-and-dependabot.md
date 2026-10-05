# 0010: CI・ビルドの依存を固定し、Dependabot で月に一度更新する

- ステータス: 採用
- 日付: 2026-10-05

## 背景

CI のアクションはタグ（`@v7` など）、Docker のベースイメージは `node:22-slim`、pnpm はバージョン番号だけで指定していた。タグは後から別のコミットや別のイメージに付け替えられるため、上流が乗っ取られると、こちらが何も変えなくても CI やビルドに別のコードが入る（GitHub issue #9）。一方で、固定したままにすると更新が止まり、脆弱性の修正も入らなくなる。

## 決定

- CI のサードパーティのアクションは 40 文字のコミット SHA で固定し、行末に `# vX.Y.Z` を書く。`actions/checkout` は `persist-credentials: false` にする
- Docker のベースイメージは `node:22-slim@sha256:...`（マルチアーキテクチャのインデックスの digest）で固定する
- `server/package.json` の `packageManager` に pnpm のバージョンと sha512 を書く。pnpm 12 はこれを `pnpm-lock.yaml` にも記録するので、ロックファイルも合わせて更新する。CI と Dockerfile の `corepack prepare` のバージョンと必ず揃える
- `pnpm-workspace.yaml` に `minimumReleaseAge: 1440` を入れ、公開から 1 日経っていない版は入れない
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
- pnpm のバージョンを上げるときは `packageManager`（ハッシュを含む）、CI と Dockerfile の `corepack prepare`、`pnpm-lock.yaml` をまとめて更新する
- Android の依存はロックや検証をしていないため、Gradle のリポジトリ側の改ざんは検出できない

## 参考

- https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions
- https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference
- https://pnpm.io/settings#minimumreleaseage
