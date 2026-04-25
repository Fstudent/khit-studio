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
  // ★甘め判定: ヒット半径を編み目サイズの 1.4 倍まで広げる
  //   （プレイヤーが少しズレてもガイドにヒットしたとみなす）
  const matchRadius = options.matchRadius ?? avgStitchSize * 1.4;
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

  const rawCoverage = (hitCount / guide.length) * 100;
  const rawColorAccuracy = hitCount > 0 ? (colorHitCount / hitCount) * 100 : 0;
  const rawPositionAccuracy = hitCount > 0 ? (positionScoreSum / hitCount) * 100 : 0;
  const extraCount = playerUsed.filter((u) => !u).length;

  // ★甘めカーブ: 中盤を持ち上げる（50% カバレッジ → 約 64 点扱い、
  //   80% → 約 86 点、100% は 100 のまま）
  const coverage = curve(rawCoverage, 0.65);
  const colorAccuracy = rawColorAccuracy; // 0/1 判定なのでカーブ不要
  const positionAccuracy = curve(rawPositionAccuracy, 0.8);

  // ★はみ出しペナルティを大幅緩和（最大 25 → 12、係数 60 → 25）。
  //   タイムアタック中のはみ出しを大目に見る。
  const extraRatio = extraCount / Math.max(guide.length, 1);
  const extraPenalty = Math.min(12, extraRatio * 25);

  // 総合: カバレッジ重視（55%）+ 色一致(20%) + 位置一致(25%) − はみ出し
  const totalRaw =
    coverage * 0.55 +
    colorAccuracy * 0.2 +
    positionAccuracy * 0.25 -
    extraPenalty;
  const total = Math.max(0, Math.min(100, Math.round(totalRaw)));

  const rank = rankOf(total);
  const comment = commentOf({
    total,
    coverage: rawCoverage,
    colorAccuracy: rawColorAccuracy,
    extraCount,
  });

  return {
    total,
    // UI 表示は「実際にお手本のうちどれだけ拾えたか」が直感的なので生値を返す
    coverage: round1(rawCoverage),
    colorAccuracy: round1(rawColorAccuracy),
    positionAccuracy: round1(rawPositionAccuracy),
    guideCount: guide.length,
    playerCount: player.length,
    extraCount,
    rank,
    comment,
  };
}

/**
 * 0–100 の値を、低めの値ほど大きく持ち上げるべき乗カーブで変換する。
 * exp < 1 で「甘め評価」になる。
 *   curve(50, 0.65) ≒ 64 / curve(70, 0.65) ≒ 80 / curve(100, *) = 100
 */
function curve(v: number, exp: number): number {
  if (v <= 0) return 0;
  return Math.pow(Math.min(100, v) / 100, exp) * 100;
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
  // ★ランク閾値を全体的に下げて、頑張りを認めやすくする
  if (total >= 87) return "SS";
  if (total >= 73) return "S";
  if (total >= 58) return "A";
  if (total >= 42) return "B";
  if (total >= 22) return "C";
  return "D";
}

function commentOf(input: {
  total: number;
  coverage: number;
  colorAccuracy: number;
  extraCount: number;
}): string {
  const { total, coverage, colorAccuracy, extraCount } = input;
  if (total >= 87) return "ほとんどお手本通り。針を持つ手が見えるよう。";
  if (total >= 73) return "見事な再現度。色も配置もよく追えています。";
  if (total >= 58) return "良いライン取り。あと少しで満点圏内です。";
  if (coverage < 25) return "まずはお手本の輪郭から、ゆっくりなぞってみましょう。";
  if (colorAccuracy < 35) return "形は近いので、お手本に近い色を選ぶともっと伸びます。";
  if (extraCount > coverage) return "はみ出しが多めです。お手本の縁を意識してみて。";
  if (total >= 42) return "輪郭は捉えられています。次はもう少し色を揃えてみよう。";
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
