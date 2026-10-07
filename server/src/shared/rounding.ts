// 小数第 digits 位で四捨五入する（Math.round と同じく、.5 は正の方向へ丸める）
export function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
