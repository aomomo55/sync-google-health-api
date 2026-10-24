# 0029: サーバーのデプロイを、手で起動する GitHub Actions でも行えるようにする

- ステータス: 採用
- 日付: 2026-10-25

## 背景

サーバーのデプロイは、flyctl を入れた手元の環境から `fly deploy` で行ってきた。fly.io のトークンを GitHub に置かないためである。しかし、依存のセキュリティ更新は「マージ → 手元でデプロイ」の 2 手になる。手元の環境が使えないときは、マージしてもデプロイできない。

GitHub Actions でデプロイするには、fly.io のトークンを GitHub に置く必要がある。このリポジトリは公開なので、次の点を考える必要がある。

- fork からの PR や Dependabot の PR から、トークンを読まれないこと
- Actions のログは誰でも見られるので、本番のアプリ名やホスト名を出さないこと
- トークンが漏れたときの被害を、1 つのアプリのデプロイまでに抑えること

## 決定

`.github/workflows/deploy.yml` を追加する。手で起動したとき（`workflow_dispatch`）だけ、main を fly.io にデプロイする。

- **トークン**: `fly tokens create deploy` で作る、このアプリ専用で期限付きのトークンを使う。作るのも GitHub への登録も、利用者が行う
- **置き場所**: リポジトリの Environment `production` の secrets に置く。Environment は main ブランチからの実行だけに絞る。ワークフローでも `github.ref` が main であることを確かめる
- **アプリ名**: 同じ Environment の secrets（`FLY_APP`）に置く。secrets の値はログで伏せられるので、公開されるログにアプリ名とホスト名が出ない
- **flyctl**: 版を固定し、sha256 を検査してから使う。fly.io の公式の Action（superfly/flyctl-actions）は 2024 年から更新されておらず、既定では最新版の flyctl を入れるので使わない
- **ビルド**: `--remote-only` で fly.io のビルダーでイメージを作る。依存のインストールは、トークンのある GitHub の実行環境では動かない
- **起動のきっかけ**: main へのマージで自動ではデプロイしない。Dependabot の PR をマージしただけで本番が変わるのを避け、マージとデプロイの間に確認を挟めるようにする

手元からの `fly deploy` もそのまま使える。

## 検討した選択肢

| 選択肢 | 長所 | 短所 |
|---|---|---|
| 手元からだけデプロイする（今まで） | トークンを GitHub に置かない | 手元の環境が要る。マージからデプロイまでが 2 手 |
| **手で起動する Actions でもデプロイできるようにする** | 手元の環境が無くてもデプロイできる。デプロイの記録が Actions に残る | トークンを GitHub に置く。期限が来たら作り直す |
| main へのマージで自動でデプロイする | 手間が最も少ない | Dependabot の PR のマージだけで本番が変わる。確認を挟めない |
| 公式の superfly/flyctl-actions を使う | 書く量が少ない | 2024 年から更新されていない。既定では最新版の flyctl を入れるので、版の固定と検査を別に書く必要がある |

## 結果

- マージした後、`gh workflow run deploy.yml --ref main` か Actions の画面からデプロイできる
- トークンの期限が来たら、作り直して登録し直す（[deploy.md](../deploy.md#github-actions-でデプロイする)）。漏れたときは [rotate-secrets.md](../rotate-secrets.md#fly_api_tokengithub-actions-のデプロイ用) の手順で取り消す
- flyctl の版は Dependabot では上がらない。手で上げるときは、公開から 3 日以上たった版にし、sha256 も書き換える
- `/healthz` が 200 を返すことまでは確かめる。Node.js のバージョンなど、マシンの中の確認は手元から行う

## 参考

- https://fly.io/docs/launch/continuous-deployment-with-github-actions/
- https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment
- https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions
