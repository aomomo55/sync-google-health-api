# デプロイ

サーバーを fly.io にデプロイし、秘密情報を登録する手順。Android アプリのインストールは [android/README.md](../android/README.md)、バックアップの設定は [backup.md](backup.md) にある。

置き換える値は `<…>` で書いている。`<` `>` も含めて自分の値に置き換える。

## サーバーをデプロイする

`server/fly.toml` のアプリ名（`your-app-name`）はプレースホルダーなので、コマンドで指定する。`server/` で実行する。

```sh
fly deploy -a <アプリ名> --ha=false
```

- `--ha=false` を付けると、マシンを 1 台だけ作る（付けないと 2 台作られる）。利用者 1 人の前提なので 1 台で足りる
- `fly.toml` の `[env]` には秘密でない設定（`COUCHDB_HEALTH_DB`、`VAULT_HEALTH_PREFIX` など）を書く。秘密情報は書かない
- `fly.toml` を変えたら、main にコミットしてからデプロイする。[GitHub Actions のデプロイ](#github-actions-でデプロイする) は main の `fly.toml` を使うので、手元で書き換えて `fly deploy` しただけだと、次に Actions でデプロイしたときに元に戻る
- 使われていないときはマシンが止まり、リクエストが来ると起動する（`auto_stop_machines`）

## 秘密情報を登録する

`API_TOKEN`、`COUCHDB_*`、`OBSIDIAN_MCP_*`、`BACKUP_TOKEN` などの秘密情報は fly.io の secrets に登録する。リポジトリやログには出さない。値の規則は [server/README.md](../server/README.md#環境変数) にある。

値がシェルの履歴に残らないよう、標準入力から渡す。

```sh
fly secrets import -a <アプリ名>
```

1. `KEY=` と打ってから、値だけを貼る。これを 1 行に 1 つずつ入力する
2. 最後に Enter で空の行に移ってから、Ctrl-D で終える（終わらなければもう一度 Ctrl-D）

リポジトリの外に置いた一時ファイル（例: `~/tmp/secrets.env`）から読み込んでもよい。登録したらファイルを消す。

```sh
fly secrets import -a <アプリ名> < ~/tmp/secrets.env
```

ファイル名の前の `<` は入力の切り替えなので、そのまま打つ。

`fly secrets set KEY=value -a <アプリ名>` でも登録できるが、値がシェルの履歴に残る。

登録した secrets を変えると、サーバーは自動で再起動する。入力しなかったほかの secrets はそのまま残る。

秘密情報が漏れた（漏れたかもしれない）ときの入れ替えの手順は [rotate-secrets.md](rotate-secrets.md) にある。

## 動作を確かめる

```sh
curl -s https://<アプリ名>.fly.dev/healthz
fly logs -a <アプリ名> --no-tail
```

`/healthz` が `{"status":"ok"}` を返せば起動している。起動しないときは、ログの `環境変数が不正です` の行に、どの設定が規則に合わないかが出る（値そのものは出ない）。

## GitHub Actions でデプロイする

flyctl が無い環境からも、`.github/workflows/deploy.yml` で main をデプロイできる。手で起動したときだけ動く（理由は [ADR 0029](adr/0029-deploy-from-actions-on-demand.md)）。

```sh
gh workflow run deploy.yml --ref main
```

Actions の画面の「Deploy」→「Run workflow」からでもよい。最後に `/healthz` を確かめる。

### 最初の設定

1. リポジトリの Settings → Environments で `production` を作り、「Deployment branches and tags」を `main` だけにする
2. このアプリだけをデプロイできる、期限付きのトークンを作り、そのまま `production` の secrets に登録する。トークンは画面にもシェルの履歴にも出ない。`-x` は期限（下の例は 180 日）

   ```sh
   fly tokens create deploy -a <アプリ名> -x 4320h -n github-actions | tr -d '\r\n' | gh secret set FLY_API_TOKEN --env production
   ```

3. アプリ名も `production` の secrets に登録する。secrets にしておくと、公開されるログでアプリ名が伏せられる

   ```sh
   gh secret set FLY_APP --env production --body <アプリ名>
   ```

トークンの期限が来たら、2 をもう一度行う。古いトークンの取り消しと、漏れたときの手順は [rotate-secrets.md](rotate-secrets.md#fly_api_tokengithub-actions-のデプロイ用) にある。

## Android アプリ

デバッグ署名の APK をビルドして、手動でインストールする。手順は [android/README.md](../android/README.md)。
