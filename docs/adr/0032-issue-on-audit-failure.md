# 0032: 週次の脆弱性監査が失敗したら Issue を立てる

- ステータス: 採用
- 日付: 2026-10-26

## 背景

`server/pnpm-lock.yaml` は pnpm 12 の 2 文書形式（先頭の文書が pnpm の版を記録する boot document、最後の文書が依存の一覧）で、`server/package.json` の `packageManager` で pnpm の版を固定している。GitHub の依存グラフはこの形式を読めない（「When pnpm writes `pnpm-lock.yaml` as two YAML documents, the dependency graph does not detect the dependencies in that file.」）。そのため Dependabot alerts は 0 件のままで、body-parser 2.3.0 の high の脆弱性にも警告が出なかった。

脆弱性を見つけられるのは `.github/workflows/audit.yml`（週次・手動・PR で `pnpm audit --prod --audit-level=high`）だけだが、失敗しても Actions の失敗通知しか出ず、見落としやすい。

## 決定

- `audit.yml` に `notify` ジョブを足し、定期実行（schedule）と手動（workflow_dispatch）で audit が失敗したときだけ Issue を立てる。PR では立てない（PR には失敗がチェックとして表示される）
- 同じタイトルの Issue が開いていれば、新しく立てずにコメントを足す。毎週の重複を防ぎ、直るまで毎週コメントが付く
- 本文には失敗した run の URL と `pnpm audit` の出力の先頭 3000 バイトを載せる。出力は `server` ジョブの job outputs で渡す
- `gh` CLI（ランナーに入っている）を使い、外部のアクションは増やさない。`issues: write` は `notify` ジョブにだけ与え、ほかのジョブは `contents: read` のまま。ラベルは使わない
- 依存グラフに読ませる方法（lockfile の形式を変える、dependency submission API で送る）は、今は採らない。下の「検討した選択肢」を参照

## 検討した選択肢

| 選択肢 | 長所 | 短所 |
|---|---|---|
| **A: audit が失敗したら Issue を立てる** | 新しい依存が要らない。今ある audit の結果をそのまま通知にできる | Dependabot alerts や Dependabot security updates の自動 PR は引き続き出ない。通知は週に一度で、`pnpm audit` が見る脆弱性データベースに依存する |
| B1: lockfile を 1 文書形式にする | 依存グラフが読める | 下記のとおり、pnpm には 1 文書形式で書かせる設定が無い。`packageManager` の固定をやめる必要があり、版の固定（[0010](0010-pin-dependencies-and-dependabot.md)・[0014](0014-node-24-and-corepack-from-npm.md)）と食い違う |
| B2: dependency submission API で依存を送る | 依存グラフに載り、alerts が出る | pnpm の lockfile を読んで送る公式の Action は見つからなかった。自作するか、新しい外部のアクションを `contents: write` 付きで入れることになる |
| 何もしない | 手間が無い | 脆弱性に気づけない（今回の実例） |

案 B2 の調査（2026-10-26）:

- pnpm の lockfile の公式ドキュメントには、1 文書で書かせる設定が書かれていない。2 文書になるのは、config dependencies があるとき、または `devEngines.packageManager` か pnpm 12 以上を固定した `packageManager` があるとき。設定に近いのは `pmOnFail=ignore`（pnpm の版を強制せず記録しない）だけで、版の固定をやめることになる。config dependencies があれば、それでも 2 文書になる
- ドキュメントは、依存の更新を行うツールは最後の文書を読み、脆弱性スキャナーや SBOM を作るツールは全部の文書を読むよう求めている。GitHub の依存グラフ側の対応は、確認できていない
- dependency submission API（スナップショットの送信）は存在する。GitHub が紹介する Action に pnpm 用のものは無い。Component Detection の Action は pnpm の対応を確認できなかった。Dependency Submission Toolkit（TypeScript）で自作する道はある

## 結果

- 脆弱性が見つかると、週に一度 Issue が立つ（または既存の Issue にコメントが付く）。Issue は通知先として GitHub の通知メールに乗る
- Issue は自動では閉じない。直したら手で閉じる
- 依存グラフと Dependabot alerts は引き続き使えない。GitHub が pnpm 12 の 2 文書形式を読めるようになったら、この ADR を見直す。そのときは alerts と Issue が二重にならないか確かめる
- audit が失敗した理由が脆弱性とは限らない（レジストリの障害など）。本文の出力が空のときは、run の URL から確かめる
- 公開リポジトリでは、60 日間リポジトリに動きが無いと定期実行のワークフローが自動で止まる（[schedule の注記](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)）。この Issue が `server/` の脆弱性の唯一の通知なので、止まったという通知が来たら Actions の画面で有効に戻す
- 通知メールが届くかは、リポジトリの Watch の設定しだい。「All Activity」なら新しい Issue も既存の Issue へのコメントも届く。それ以外の設定では届かないことがあるので、最初の Issue が立ったら、その Issue を購読しておく
- 既存の Issue は、タイトルが一致し、作成者が `app/github-actions` のものだけを探す（公開リポジトリで、第三者が同じタイトルの Issue を立ててもそちらへ流れないようにするため）。作成者の名前の形は最初の実行で確かめる
- 失敗したジョブの job outputs が後続のジョブに渡ることは、ドキュメントに明記が無い。導入時に、脆弱な依存が残るブランチで `workflow_dispatch` を実行し、本文に出力が載ることを確かめる

## 参考

- https://docs.github.com/en/code-security/reference/supply-chain-security/dependency-graph-supported-package-ecosystems
- https://pnpm.io/lockfile
- https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/using-the-dependency-submission-api
- https://github.com/advanced-security/component-detection-dependency-submission-action
