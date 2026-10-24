# 0023: Docker のベースイメージの更新だけ Dependabot で毎日確かめる

- ステータス: 採用
- 日付: 2026-10-24

## 背景

[0010](0010-pin-dependencies-and-dependabot.md) で、依存の更新は Dependabot で月に一度まとめて提案させることにした。脆弱性の修正は、リポジトリの設定で有効にしているセキュリティ更新が `schedule` と関係なく PR にするので、月に一度でも遅れないと考えていた。

2026-10-21 に Node.js のセキュリティリリース（24.x などで最高 HIGH）が出て、Docker Hub の `node:24-slim` も同じ日に更新された。しかし Dependabot のセキュリティ更新は来なかった。セキュリティ更新が対象にするのは GitHub Advisory Database に載ったパッケージの脆弱性で、Node.js 本体（ベースイメージの中身）の脆弱性はそこに載らないためである。ベースイメージの digest の更新に気づける経路は月に一度のバージョン更新だけで、最長で 1 か月近く古いイメージのまま動くことになる。この時は手で digest を調べて更新した（PR #65）。

## 決定

- `dependabot.yml` の docker（`/server`）だけ、`schedule.interval` を `monthly` から `daily` にする
- github-actions・npm・gradle は `monthly` のままにする。これらの脆弱性はセキュリティ更新が `schedule` と関係なく PR にする
- Node のメジャー更新を除外する設定（[0014](0014-node-24-and-corepack-from-npm.md)）と、`open-pull-requests-limit: 2` は変えない

## 検討した選択肢

| 選択肢 | 長所 | 短所 |
|---|---|---|
| **docker だけ毎日にする** | Node.js 本体の修正を含むイメージが出た翌日に PR が来る。ほかの依存の PR の数は増えない | ベースイメージは Node のパッチ版だけでなく土台の Debian の更新でも digest が変わるので、docker の PR が週に何回か来る |
| すべてのエコシステムを 2 日に 1 回にする | 確認の間隔がそろう | npm・gradle・Actions の脆弱性はセキュリティ更新ですでに早く来るので、増えるのは急ぎでない PR だけ。2 日おきの指定は `daily` / `weekly` / `monthly` では書けない |
| docker を週に一度にする | PR の数が毎日より少ない | 修正の入ったイメージに気づくまで最長で 1 週間かかる |
| 月に一度のまま、Node.js のセキュリティリリースを見て手で更新する（従来） | PR が増えない | 気づくかどうかが人に依存する。digest を調べる手間が毎回かかる |

## 結果

- Node.js のセキュリティリリースのあと、ベースイメージが更新された翌日には digest を書き換えた PR が来る。手で digest を調べる作業が無くなる
- docker の PR を取り込んでも、fly.io へのデプロイは自動では行われない。マージしたら `docs/deploy.md` の手順でデプロイし、`fly ssh console -C "node --version"` で版を確かめる
- docker の PR が週に何回か来る。急ぎでないものは、溜まった分を次の PR でまとめて取り込んでよい（新しい PR が来ると古い PR は閉じられる）

## 参考

- https://docs.github.com/en/code-security/dependabot/dependabot-security-updates/about-dependabot-security-updates
- https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference#schedule-
- https://nodejs.org/en/blog/vulnerability
