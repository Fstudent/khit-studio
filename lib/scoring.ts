import { TEXTURE_PROFILES } from "./yarns";
import type { Stitch } from "./stitches";

export type GuideStitch = Pick<Stitch, "x" | "y" | "color" | "texture">;

export type ScoreResult = {
  /** 0-100 の総合スコア */
  total: number;
  /** お手本のうち、近くに編まれていた割合 (0-100) */
  coverage: number;
  /** ヒットしたお手本のうち、色が一致していた割合 (0-100) */
  colorAccuracy: number;
  /** 位置の近さ (0-100)。ヒットしたお手本に対する平均距離スコア。 */
  positionAccuracy: number;
  /** お手本数 */
  guideCount: number;
  /** プレイヤーが置いた目の総数 */
  playerCount: number;
  /** 余分なはみ出し（どのお手本にも紐づかなかったプレイヤーの目）の数 */
  extraCount: number;
  /** SS / S / A / B / C / D の評価 */
  rank: "SS" | "S" | "A" | "B" | "C" | "D";
  /** プレイヤー視点の短い講評 */
  comment: string;
};

type Options = {
  /** マッチ判定の半径。未指定なら平均的なステッチサイズから自動算出。 */
  matchRadius?: number;
};

/**
 * お手本（guide）とプレイヤー（player）のステッチ列を突き合わせてスコアリングする。
 *
 * 1. 各 guide について、半径 R 以内にある「同色 / 異色」の player を最近接探索
 * 2. ヒット率 = coverage、ヒットしたうち同色率 = colorAccuracy、距離平均 = positionAccuracy
 * 3. はみ出し（どの guide にも結びつかなかった player）はペナルティ
 *
 * 計算量は O(guide × player) だが、いずれも数十〜数百なので十分軽い。
 */
export function scorePattern(
  guide: GuideStitch[],
  player: GuideStitch[],
  options: Options = {},
): ScoreResult {
  if (guide.length === 0) {
    return emptyResult(player.length);
  }

  const avgStitchSize =
    guide.reduce(
      (sum, g) => sum + TEXTURE_PROFILES[g.texture].stitchSize,
      0,
    ) / guide.length;
  const matchRadius = options.matchRadius ?? avgStitchSize * 0.9;
  const radiusSq = matchRadius * matchRadius;

  // 各 player が「どの guide に消費されたか」を記録（重複マッチを避けるためではなく、
  // はみ出し計算用に「最低 1 件の guide にヒットしたか」だけ記録する）
  const playerUsed = new Array<boolean>(player.length).fill(false);

  let hitCount = 0;
  let colorHitCount = 0;
  let positionScoreSum = 0;

  for (const g of guide) {
    let bestDistSq = Infinity;
    let bestIdx = -1;
    let bestColorMatch = false;

    for (let i = 0; i < player.length; i++) {
      const p = player[i];
      const dx = p.x - g.x;
      const dy = p.y - g.y;
      const distSq = dx * dx + dy * dy;
      if (distSq > radiusSq) continue;

      const colorMatch = sameColor(p.color, g.color);
      // 同色を優先したいので、色一致 → 距離 の優先順で best を更新
      const isBetter =
        bestIdx === -1 ||
        (colorMatch && !bestColorMatch) ||
        (colorMatch === bestColorMatch && distSq < bestDistSq);
      if (isBetter) {
        bestDistSq = distSq;
        bestIdx = i;
        bestColorMatch = colorMatch;
      }
    }

    if (bestIdx >= 0) {
      hitCount += 1;
      if (bestColorMatch) colorHitCount += 1;
      const dist = Math.sqrt(bestDistSq);
      // 距離 0 で 1.0、半径ぴったりで 0.0 になる線形スコア
      positionScoreSum += Math.max(0, 1 - dist / matchRadius);
      playerUsed[bestIdx] = true;
    }
  }

  const coverage = (hitCount / guide.length) * 100;
  const colorAccuracy = hitCount > 0 ? (colorHitCount / hitCount) * 100 : 0;
  const positionAccuracy = hitCount > 0 ? (positionScoreSum / hitCount) * 100 : 0;
  const extraCount = playerUsed.filter((u) => !u).length;

  // はみ出しペナルティ: お手本数に対するはみ出しの割合（最大 25 点まで減点）
  const extraRatio = extraCount / Math.max(guide.length, 1);
  const extraPenalty = Math.min(25, extraRatio * 60);

  // 総合: カバレッジ 50% + 色一致 25% + 位置一致 25% − はみ出し
  const totalRaw =
    coverage * 0.5 +
    colorAccuracy * 0.25 +
    positionAccuracy * 0.25 -
    extraPenalty;
  const total = Math.max(0, Math.min(100, Math.round(totalRaw)));

  const rank = rankOf(total);
  const comment = commentOf({ total, coverage, colorAccuracy, extraCount });

  return {
    total,
    coverage: round1(coverage),
    colorAccuracy: round1(colorAccuracy),
    positionAccuracy: round1(positionAccuracy),
    guideCount: guide.length,
    playerCount: player.length,
    extraCount,
    rank,
    comment,
  };
}

/**
 * ゲーム中の軽量チェック用：プレイヤーがお手本のうちどれだけを覆ったかだけを返す。
 * scorePattern と違い色や位置精度は計算しない（毎秒呼ばれるので O(G×P) のうち
 * ヒット 1 件で early-break する）。
 */
export function computeCoverage(
  guide: GuideStitch[],
  player: GuideStitch[],
  options: Options = {},
): { coverage: number; hits: number; guideCount: number } {
  if (guide.length === 0) {
    return { coverage: 0, hits: 0, guideCount: 0 };
  }
  const avgStitchSize =
    guide.reduce(
      (sum, g) => sum + TEXTURE_PROFILES[g.texture].stitchSize,
      0,
    ) / guide.length;
  const matchRadius = options.matchRadius ?? avgStitchSize * 0.9;
  const radiusSq = matchRadius * matchRadius;

  let hits = 0;
  for (const g of guide) {
    for (let i = 0; i < player.length; i++) {
      const p = player[i];
      const dx = p.x - g.x;
      const dy = p.y - g.y;
      if (dx * dx + dy * dy <= radiusSq) {
        hits += 1;
        break;
      }
    }
  }
  return {
    coverage: (hits / guide.length) * 100,
    hits,
    guideCount: guide.length,
  };
}

function sameColor(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function rankOf(total: number): ScoreResult["rank"] {
  if (total >= 92) return "SS";
  if (total >= 82) return "S";
  if (total >= 70) return "A";
  if (total >= 55) return "B";
  if (total >= 35) return "C";
  return "D";
}

function commentOf(input: {
  total: number;
  coverage: number;
  colorAccuracy: number;
  extraCount: number;
}): string {
  const { total, coverage, colorAccuracy, extraCount } = input;
  if (total >= 92) return "ほとんどお手本通り。針を持つ手が見えるよう。";
  if (total >= 82) return "見事な再現度。色も配置もよく追えています。";
  if (coverage < 30) return "もう少しお手本の場所を意識して編んでみましょう。";
  if (colorAccuracy < 40) return "形は近いけれど、色選びがお手本と違うようです。";
  if (extraCount > input.coverage) return "はみ出しが多めです。お手本の縁に注意して。";
  if (total >= 70) return "良い再現度。あと少しで満点圏内です。";
  if (total >= 55) return "輪郭は捉えられています。色を揃えるとぐっと伸びます。";
  return "落ち着いて、お手本の塊を 1 つずつ追いかけてみましょう。";
}

function emptyResult(playerCount: number): ScoreResult {
  return {
    total: 0,
    coverage: 0,
    colorAccuracy: 0,
    positionAccuracy: 0,
    guideCount: 0,
    playerCount,
    extraCount: playerCount,
    rank: "D",
    comment: "お手本がありません。先に「お手本を生成」してください。",
  };
}
