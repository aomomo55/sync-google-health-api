import { z } from "zod";

// Takeout の raw JSON 1 ファイルあたりの Data Points の上限。
// ステージ付きの睡眠を 10 年分（1 晩 60 segment 程度）入れても 20 万件余りなので、数倍の余裕を持たせる
export const MAX_DATA_POINTS_PER_FILE = 1_000_000;

// 解析中に捨てた記録の件数（取り込み結果に表示する）
export type ParseStats = {
  // 時刻が不正
  invalidTime: number;
  // 形が想定と違う（null、必要な項目が無い、型が違う）
  invalidShape: number;
};

// 上限を超えたファイル。壊れたデータを途中まで取り込まないよう、取り込みを止める
export class TakeoutLimitError extends Error {
  override name = "TakeoutLimitError";
}

// startTimeNanos などの時刻。Takeout では数値と文字列のどちらでも現れる
export const NanosSchema = z.union([z.number(), z.string()]);

export const nanosToMs = (nanos: number | string) => Number(nanos) / 1e6;

const DataPointsFileSchema = z.object({ "Data Points": z.array(z.unknown()) });

// raw JSON の Data Points から schema に合う要素だけを返し、合わない件数を stats に足す。
// Data Points が無いファイルは空として扱い、件数が上限を超えたら TakeoutLimitError を投げる
export function validDataPoints<T>(json: unknown, schema: z.ZodType<T>, stats?: ParseStats): T[] {
  const file = DataPointsFileSchema.safeParse(json);
  if (!file.success) return [];
  const points = file.data["Data Points"];
  if (points.length > MAX_DATA_POINTS_PER_FILE) {
    throw new TakeoutLimitError(
      `Data Points が多すぎます（${points.length} 件、上限 ${MAX_DATA_POINTS_PER_FILE} 件）。` +
        "Takeout のファイルが壊れていないか確かめ、書き出し直してください",
    );
  }
  const valid = points.flatMap((p) => {
    const r = schema.safeParse(p);
    return r.success ? [r.data] : [];
  });
  // 呼び出し側が複数ファイル分を合計するので、渡された stats に足し込む
  if (stats) stats.invalidShape += points.length - valid.length;
  return valid;
}
