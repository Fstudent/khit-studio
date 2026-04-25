import { TEXTURE_PROFILES, type Yarn } from "./yarns";

/**
 * 1 つの編み目（V 字ループ）。
 * x, y は中心座標（CSS ピクセル, 0-1 正規化ではない実座標）。
 * orderIndex は描画順 = z-index（大きいほど手前に重なる）。
 */
export type Stitch = {
  id: string;
  x: number;
  y: number;
  color: string;
  texture: Yarn["texture"];
  /** 編み目を傾ける角度（radian）。連続編みで滑らかに変化させると編み地の流れが出る。 */
  rotation: number;
  /** 表示倍率。アニメーションでフェードインさせるときに 0 → 1 へ補間する。 */
  scale: number;
  orderIndex: number;
};

export type StrokeContext = {
  /** 直前にスタンプした座標。距離フィルタの基準。 */
  lastStamp: { x: number; y: number } | null;
  /** ストローク開始からスタンプ済みの編み目数 */
  stampCount: number;
};

export function createEmptyStrokeContext(): StrokeContext {
  return { lastStamp: null, stampCount: 0 };
}

/** ある糸種における編み目同士の最小間隔。 */
export function spacingForYarn(yarn: Yarn): number {
  const profile = TEXTURE_PROFILES[yarn.texture];
  return profile.stitchSize * 0.55;
}

/**
 * お手本（ガイド）として薄く重ねて描く専用版。
 *
 * 布の地色（暖色オフホワイト）と糸色のコントラストが低い場合
 * （例: アイボリー糸 vs リネン地）でもお手本が確実に視認できるよう、
 * 編み目の下に少し太い「ダークシルエット」を敷く。これで色相を保ったまま
 * 輪郭が常に浮かび上がる。
 */
export function drawGuideStitch(
  ctx: CanvasRenderingContext2D,
  stitch: Stitch,
  alpha = 0.4,
): void {
  const profile = TEXTURE_PROFILES[stitch.texture];
  const halfW = (profile.stitchSize * 0.55) * stitch.scale;
  const halfH = (profile.stitchSize * 0.6) * stitch.scale;
  const lineWidth = profile.lineWidth * stitch.scale;

  const drawV = () => {
    ctx.beginPath();
    ctx.moveTo(-halfW, -halfH);
    ctx.lineTo(0, halfH * 0.85);
    ctx.lineTo(halfW, -halfH);
    ctx.stroke();
  };

  ctx.save();
  ctx.translate(stitch.x, stitch.y);
  ctx.rotate(stitch.rotation);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // 1) ダーク・シルエット（少し太く、暗い茶色）
  ctx.globalAlpha = alpha * 0.55;
  ctx.strokeStyle = "#5e4a2f";
  ctx.lineWidth = Math.max(1.6, lineWidth * 0.95) + 1.6;
  drawV();

  // 2) 糸色のストローク（少し細めに、シルエットの内側に乗る）
  ctx.globalAlpha = Math.min(1, alpha * 1.15);
  ctx.strokeStyle = stitch.color;
  ctx.lineWidth = Math.max(1.2, lineWidth * 0.78);
  drawV();

  ctx.restore();
}

/**
 * 1 つの編み目を Canvas に描く。
 *
 * 編み物特有の「上に重なる」表現は、呼び出し側が orderIndex の小さい順に
 * 連続描画することで自然に表現される（古い編み目の上に新しい編み目が乗る）。
 */
export function drawStitch(
  ctx: CanvasRenderingContext2D,
  stitch: Stitch,
): void {
  const profile = TEXTURE_PROFILES[stitch.texture];
  const halfW = (profile.stitchSize * 0.55) * stitch.scale;
  const halfH = (profile.stitchSize * 0.6) * stitch.scale;
  const lineWidth = profile.lineWidth * stitch.scale;

  ctx.save();
  ctx.translate(stitch.x, stitch.y);
  ctx.rotate(stitch.rotation);

  // 1) ふんわりした下影（質感によってぼかし量を変える）
  if (profile.blur > 0) {
    ctx.shadowColor = withAlpha(stitch.color, 0.35);
    ctx.shadowBlur = profile.blur * 4;
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stitch.color;
  ctx.lineWidth = lineWidth;

  // 2) V 字（編み目本体）
  ctx.beginPath();
  ctx.moveTo(-halfW, -halfH);
  ctx.lineTo(0, halfH * 0.85);
  ctx.lineTo(halfW, -halfH);
  ctx.stroke();

  // 3) ハイライト（光が当たる側）
  ctx.shadowBlur = 0;
  ctx.strokeStyle = lightenHex(stitch.color, 0.35);
  ctx.lineWidth = Math.max(1, lineWidth * 0.35);
  ctx.beginPath();
  ctx.moveTo(-halfW * 0.85, -halfH * 0.85);
  ctx.lineTo(-halfW * 0.05, halfH * 0.5);
  ctx.stroke();

  // 4) 影（重なりに見せるためのアンダーライン）
  ctx.strokeStyle = darkenHex(stitch.color, 0.35);
  ctx.lineWidth = Math.max(1, lineWidth * 0.3);
  ctx.beginPath();
  ctx.moveTo(halfW * 0.05, halfH * 0.5);
  ctx.lineTo(halfW * 0.85, -halfH * 0.85);
  ctx.stroke();

  ctx.restore();
}

// ---- color helpers ---------------------------------------------------------

function clampChannel(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function parseHex(hex: string): [number, number, number] | null {
  const m = hex.replace("#", "");
  if (m.length !== 6) return null;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return [r, g, b];
}

function toHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) => clampChannel(v).toString(16).padStart(2, "0"))
      .join("")
  );
}

function lightenHex(hex: string, amount: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb;
  return toHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
}

function darkenHex(hex: string, amount: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb;
  return toHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}

function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
