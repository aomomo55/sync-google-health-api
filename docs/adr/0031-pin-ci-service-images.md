# 0031: CI の services のイメージも digest で固定し、Dependabot の docker の PR を取り込むときに手で更新する

- ステータス: 採用
- 日付: 2026-10-25

## 背景

[0010](0010-pin-dependencies-and-dependabot.md) で、アクションはコミット SHA、Docker のベースイメージは digest で固定し、更新は Dependabot に任せることにした。「固定するが自動更新はしない」は、更新が止まり脆弱性の修正が入らなくなるとして退けている。

一方、`.github/workflows/ci.yml` の結合テスト用の CouchDB（`services.couchdb.image`）は `couchdb:3` とタグのままだった（Issue #100）。タグは上流で付け替えられるので、0010 が避けたかった状況がここに残っている。

ただし Dependabot はこのイメージを更新しない。

- github-actions の更新の対象は、`uses:` に書いた `owner/repo@ref` のアクションだけで、Docker Hub のイメージには対応していない
- docker の更新の対象は Dockerfile と Kubernetes のマニフェスト・Helm チャートで、このリポジトリでは `directory: /server`（`server/Dockerfile`）だけを見ている

そのため、digest で固定すると、0010 が退けた「固定するが自動更新はしない」の形になる。いつ更新するかを決めておく必要がある。

## 決定

- CI の `services` のイメージにも 0010 の決定を当てはめ、マルチアーキテクチャのインデックスの digest（`couchdb:3@sha256:…`）で固定する
- 更新は手で行う。**Dependabot の docker の PR（`server/Dockerfile` のベースイメージ）を取り込むときに**、あわせて Docker Hub の `couchdb:3` の digest を確かめ、変わっていれば `ci.yml` を書き換える
- このことを `ci.yml` のコメント、ルートの AGENTS.md、REVIEW.md の確認項目に書く

## 検討した選択肢

| 選択肢 | 長所 | 短所 |
|---|---|---|
| **digest で固定し、Dependabot の docker の PR を取り込むときに手で更新する** | タグの付け替えの影響を受けない。docker の PR は [0023](0023-dependabot-docker-daily.md) で頻繁に来るので、確かめる機会が定期的にある。新しい仕組みが要らない | 手で digest を調べる手間がかかる。忘れると古いまま残る（CI の結合テストにしか使わないので、本番には影響しない） |
| 月に一度の更新の確認のときに手で更新する | 確かめる日が決まる | 月に一度だけ確かめる決まった作業が今は無く、きっかけとして当てにならない |
| タグのまま使う（従来） | 手間がかからない | 上流が乗っ取られると、気づかずに CI へ別のイメージが入る |
| CouchDB 用の Dockerfile を置き、Dependabot の docker の対象に足す | Dependabot が PR を作る | `services` は Dockerfile をビルドできないので、CI のジョブの組み方を変える必要がある。結合テストのためだけには大がかり |

## 結果

- CI に入る CouchDB のイメージが、レビューした版に限られる
- Dependabot の docker の PR を取り込むたびに、`couchdb:3` の digest を確かめる手間がかかる。digest は `https://hub.docker.com/v2/repositories/library/couchdb/tags/3` の `digest`（インデックスの digest）で確かめられる
- Dependabot が将来 `services` のイメージを更新するようになったら、この手順は要らなくなる

## 参考

- https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories
- https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions
