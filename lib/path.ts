/**
 * 制御点の列を「ドラッグの軌跡」に近い、なめらかな線として補間 → 等弧長サンプリング
 * するためのユーティリティ。
 *
 * Gemini が返す制御点列はあくまで疎らなので、ここで濃密なポリラインに展開してから
 * 編み目の間隔（spacing）でリサンプリングし、編み目ごとの座標と接線角度を作る。
 */

export type Pt = { x: number; y: number };

export type SampledPoint = {
  pos: Pt;
  /** その点での接線角度（radian, atan2(dy, dx)） */
  tangent: number;
};

/**
 * 4 つの制御点から Catmull‐Rom スプライン上の 1 点を返す。
 * t は 0..1 で、t=0 のとき p1、t=1 のとき p2 になる。
 */
function catmullRom(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x:
      0.5 *
      ((2 * p1.x) +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      ((2 * p1.y) +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

/**
 * 制御点列を Catmull‐Rom スプラインでなめらかに補間したポリラインを返す。
 * 端点はゴーストポイントとして自身を複製し、両端でも素直に通るようにする。
 */
export function smoothPolyline(points: Pt[], substeps = 16): Pt[] {
  if (points.length < 2) return points.slice();
  if (points.length === 2) {
    // 2 点しかなければ単純な線分補間で十分（線形でもアーティストっぽさは出る）
    return interpolateLinear(points[0], points[1], substeps);
  }

  const ext = [points[0], ...points, points[points.length - 1]];
  const out: Pt[] = [];
  for (let i = 0; i < ext.length - 3; i++) {
    const p0 = ext[i];
    const p1 = ext[i + 1];
    const p2 = ext[i + 2];
    const p3 = ext[i + 3];
    const startStep = i === 0 ? 0 : 1; // 隣接セグメントとの重複を避ける
    for (let s = startStep; s <= substeps; s++) {
      const t = s / substeps;
      out.push(catmullRom(p0, p1, p2, p3, t));
    }
  }
  return out;
}

function interpolateLinear(a: Pt, b: Pt, steps: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

/**
 * ポリラインを等弧長 spacing 間隔でサンプリングする。
 * 各サンプル点には接線方向（atan2(dy, dx)）も付与する。
 */
export function resampleByDistance(
  pts: Pt[],
  spacing: number,
): SampledPoint[] {
  if (pts.length === 0 || spacing <= 0) return [];
  if (pts.length === 1) {
    return [{ pos: pts[0], tangent: 0 }];
  }

  const out: SampledPoint[] = [];
  // 最初の点は必ず置く。接線は次の点との差分から推定。
  out.push({ pos: pts[0], tangent: angle(pts[0], pts[1]) });

  let acc = 0; // ここまでの累積長
  let target = spacing; // 次にサンプリングしたい累積長
  let lastTangent = out[0].tangent;

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen === 0) continue;

    while (acc + segLen >= target) {
      const t = (target - acc) / segLen;
      const pos = { x: a.x + dx * t, y: a.y + dy * t };
      const tangent = Math.atan2(dy, dx);
      lastTangent = tangent;
      out.push({ pos, tangent });
      target += spacing;
    }

    acc += segLen;
  }

  // 最後の点もサンプル列に含めると、ストロークの末端が「途中で切れた」感じにならない
  const last = pts[pts.length - 1];
  const lastSample = out[out.length - 1].pos;
  const tail = Math.hypot(last.x - lastSample.x, last.y - lastSample.y);
  if (tail > spacing * 0.4) {
    out.push({ pos: last, tangent: lastTangent });
  }

  return out;
}

function angle(a: Pt, b: Pt): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}
