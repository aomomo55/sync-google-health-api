// 検証エラー（zod の issue）の場所を "a.b.c" の形で返す。オブジェクト全体のエラーは "(root)"
export function issuePath(issue: { path: readonly PropertyKey[] }): string {
  return issue.path.map(String).join(".") || "(root)";
}
