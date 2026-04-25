"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import {
  createEmptyStrokeContext,
  drawGuideStitch,
  drawStitch,
  spacingForYarn,
  type Stitch,
} from "@/lib/stitches";
import {
  TEXTURE_PROFILES,
  findYarn,
  type Yarn,
  type YarnTexture,
} from "@/lib/yarns";
import { uid } from "@/lib/utils";

export type AutoStitchSpec = {
  /** 0-1 正規化座標 */
  x: number;
  y: number;
  yarnId?: string;
  color?: string;
  texture?: YarnTexture;
  rotation?: number;
};

export type KnittingCanvasHandle = {
  clear: () => void;
  getStitchCount: () => number;
  /** プレイヤーが置いた編み目を実座標で取得する。 */
  getStitches: () => Stitch[];
  /** 0-1 正規化座標で渡された編み目を、time 間隔でアニメーション描画する。 */
  playPattern: (specs: AutoStitchSpec[], options?: { intervalMs?: number }) => Promise<void>;
  /**
   * お手本パターンをガイドとしてキャンバスに重ねる（薄い半透明）。
   * 同じくアニメーションで「編まれていく」ように見せ、終わると常時表示の guide となる。
   * 渡し直すと前のガイドは置き換わる。空配列を渡すとガイドはクリアされる。
   */
  setGuide: (specs: AutoStitchSpec[], options?: { intervalMs?: number }) => Promise<void>;
  /**
   * 既存のガイドを保ったまま、追加のお手本ステッチをアニメーションで描き足す。
   * カバレッジが上がった時の動的拡張で利用する。
   */
  appendGuide: (specs: AutoStitchSpec[], options?: { intervalMs?: number }) => Promise<void>;
  /** 現在表示中のガイドをそのまま取得（採点用）。 */
  getGuide: () => Stitch[];
  /** 現在のお手本ステッチ数。 */
  getGuideCount: () => number;
};

type Props = {
  yarn: Yarn;
  onCountChange?: (count: number) => void;
};

export const KnittingCanvas = forwardRef<KnittingCanvasHandle, Props>(
  function KnittingCanvas({ yarn, onCountChange }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);

    // 描画状態は ref で持ち、再レンダリングを起こさず軽量に扱う
    const stitchesRef = useRef<Stitch[]>([]);
    const guideRef = useRef<Stitch[]>([]);
    const strokeRef = useRef(createEmptyStrokeContext());
    const draggingRef = useRef(false);
    const yarnRef = useRef<Yarn>(yarn);
    const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
    const orderCounterRef = useRef(0);

    const [isReady, setIsReady] = useState(false);

    useEffect(() => {
      yarnRef.current = yarn;
    }, [yarn]);

    const repaint = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { width, height, dpr } = sizeRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // 1) ガイドを最初に薄く敷く（プレイヤーの目はその上に重なる）
      const guide = guideRef.current;
      for (let i = 0; i < guide.length; i++) {
        drawGuideStitch(ctx, guide[i]);
      }

      // 2) orderIndex 昇順 = 古い順で描画 → 新しい編み目が上に重なる
      const stitches = stitchesRef.current;
      for (let i = 0; i < stitches.length; i++) {
        drawStitch(ctx, stitches[i]);
      }
    }, []);

    /** Canvas を DPR 含めてリサイズして再描画する。 */
    const resizeCanvas = useCallback(() => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = container.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width));
      const height = Math.max(320, Math.floor(rect.height));
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      sizeRef.current = { width, height, dpr };
      repaint();
      setIsReady(true);
    }, [repaint]);

    useEffect(() => {
      resizeCanvas();
      const ro = new ResizeObserver(() => resizeCanvas());
      if (containerRef.current) ro.observe(containerRef.current);
      return () => ro.disconnect();
    }, [resizeCanvas]);

    const notifyCount = useCallback(() => {
      onCountChange?.(stitchesRef.current.length);
    }, [onCountChange]);

    /** 1 つの編み目を実座標に追加する */
    const stamp = useCallback(
      (x: number, y: number, opts?: { yarn?: Yarn; rotation?: number }) => {
        const activeYarn = opts?.yarn ?? yarnRef.current;
        const rotation =
          opts?.rotation ?? (Math.random() - 0.5) * 0.18; // ほんの少し傾ける
        const stitch: Stitch = {
          id: uid("stitch"),
          x,
          y,
          color: activeYarn.color,
          texture: activeYarn.texture,
          rotation,
          scale: 1,
          orderIndex: orderCounterRef.current++,
        };
        stitchesRef.current.push(stitch);

        // 増分描画: 直前の状態に新しい 1 目を上書き
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (ctx) drawStitch(ctx, stitch);

        notifyCount();
      },
      [notifyCount],
    );

    /** ドラッグ中: 直前のスタンプから一定距離離れたら新しい編み目を置く */
    const stampAlong = useCallback(
      (x: number, y: number) => {
        const activeYarn = yarnRef.current;
        const minSpacing = spacingForYarn(activeYarn);
        const ctxState = strokeRef.current;
        const last = ctxState.lastStamp;

        if (!last) {
          stamp(x, y);
          ctxState.lastStamp = { x, y };
          ctxState.stampCount += 1;
          return;
        }

        const dx = x - last.x;
        const dy = y - last.y;
        const dist = Math.hypot(dx, dy);
        if (dist < minSpacing) return;

        // 移動方向に沿って等間隔に補間スタンプ
        const steps = Math.floor(dist / minSpacing);
        const ux = dx / dist;
        const uy = dy / dist;
        const angleAlong = Math.atan2(dy, dx);
        // 編み目の縦軸を進行方向に「ほぼ垂直」に置くと、編み地らしい流れが出る
        const rotation = angleAlong - Math.PI / 2 + (Math.random() - 0.5) * 0.1;

        for (let i = 1; i <= steps; i++) {
          const sx = last.x + ux * minSpacing * i;
          const sy = last.y + uy * minSpacing * i;
          stamp(sx, sy, { rotation });
          ctxState.stampCount += 1;
        }

        ctxState.lastStamp = {
          x: last.x + ux * minSpacing * steps,
          y: last.y + uy * minSpacing * steps,
        };
      },
      [stamp],
    );

    const localPoint = useCallback((e: PointerEvent | React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    }, []);

    const handlePointerDown = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (e.button !== 0 && e.pointerType !== "touch" && e.pointerType !== "pen")
          return;
        const pt = localPoint(e);
        if (!pt) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        draggingRef.current = true;
        strokeRef.current = createEmptyStrokeContext();
        // 初回タップ: その場に 1 目置く
        stamp(pt.x, pt.y);
        strokeRef.current.lastStamp = { x: pt.x, y: pt.y };
        strokeRef.current.stampCount = 1;
      },
      [localPoint, stamp],
    );

    const handlePointerMove = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!draggingRef.current) return;
        const pt = localPoint(e);
        if (!pt) return;
        stampAlong(pt.x, pt.y);
      },
      [localPoint, stampAlong],
    );

    const handlePointerUp = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        draggingRef.current = false;
        strokeRef.current = createEmptyStrokeContext();
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      },
      [],
    );

    /**
     * ガイド描画（差し替え or 追記）を共通化したアニメーター。
     * - replace=true なら既存ガイドを破棄してアニメで描き直し（setGuide）
     * - replace=false なら現在のガイドに追記（appendGuide）
     */
    const animateGuide = useCallback(
      (
        specs: AutoStitchSpec[],
        options: { intervalMs?: number; replace: boolean },
      ): Promise<void> =>
        new Promise<void>((resolve) => {
          const intervalMs = options.intervalMs ?? 16;
          const { width, height } = sizeRef.current;
          if (options.replace) {
            guideRef.current = [];
            repaint();
          }
          if (width === 0 || height === 0 || specs.length === 0) {
            resolve();
            return;
          }

          const canvas = canvasRef.current;
          const ctx = canvas?.getContext("2d");
          if (!ctx) {
            resolve();
            return;
          }

          let i = 0;
          const baseIndex = guideRef.current.length;
          const tick = () => {
            if (i >= specs.length) {
              resolve();
              return;
            }
            const spec = specs[i];
            const y = spec.yarnId ? findYarn(spec.yarnId) : yarnRef.current;
            const stitch: Stitch = {
              id: `guide-${baseIndex + i}`,
              x: clamp01(spec.x) * width,
              y: clamp01(spec.y) * height,
              color: spec.color ?? y.color,
              texture: spec.texture ?? y.texture,
              rotation: spec.rotation ?? 0,
              scale: 1,
              orderIndex: baseIndex + i,
            };
            guideRef.current.push(stitch);
            drawGuideStitch(ctx, stitch);
            i += 1;

            if (intervalMs <= 0) {
              requestAnimationFrame(tick);
            } else {
              window.setTimeout(tick, intervalMs);
            }
          };
          tick();
        }),
      [repaint],
    );

    useImperativeHandle(
      ref,
      () => ({
        clear: () => {
          stitchesRef.current = [];
          orderCounterRef.current = 0;
          repaint();
          notifyCount();
        },
        getStitchCount: () => stitchesRef.current.length,
        getStitches: () => stitchesRef.current.slice(),
        getGuide: () => guideRef.current.slice(),
        playPattern: (specs, options) =>
          new Promise<void>((resolve) => {
            const intervalMs = options?.intervalMs ?? 22;
            const { width, height } = sizeRef.current;
            if (width === 0 || height === 0 || specs.length === 0) {
              resolve();
              return;
            }

            let i = 0;
            const tick = () => {
              if (i >= specs.length) {
                resolve();
                return;
              }
              const spec = specs[i++];
              const yarnFromSpec = spec.yarnId ? findYarn(spec.yarnId) : null;
              const overrideYarn: Yarn | null =
                yarnFromSpec ??
                (spec.color
                  ? {
                      id: "ai-custom",
                      name: "AI",
                      color: spec.color,
                      texture: spec.texture ?? "medium",
                      description: "",
                    }
                  : null);
              const px = clamp01(spec.x) * width;
              const py = clamp01(spec.y) * height;
              stamp(px, py, {
                yarn: overrideYarn ?? yarnRef.current,
                rotation: spec.rotation,
              });

              // 連続実行: 適度な間隔でブラウザに描画させる
              if (intervalMs <= 0) {
                requestAnimationFrame(tick);
              } else {
                window.setTimeout(tick, intervalMs);
              }
            };
            tick();
          }),
        setGuide: (specs, options) =>
          animateGuide(specs, { ...options, replace: true }),
        appendGuide: (specs, options) =>
          animateGuide(specs, { ...options, replace: false }),
        getGuideCount: () => guideRef.current.length,
      }),
      [animateGuide, notifyCount, repaint, stamp],
    );

    return (
      <div
        ref={containerRef}
        className="bg-canvas-cloth craft-shadow relative aspect-[5/4] w-full overflow-hidden rounded-2xl border border-border"
      >
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="absolute inset-0 cursor-crosshair touch-none"
          aria-label="編むキャンバス。クリックまたはドラッグで編み目を配置できます。"
          role="img"
        />

        {!isReady && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            布を広げています…
          </div>
        )}

        {/* キャンバスの隅にヒント */}
        <div
          className="pointer-events-none absolute bottom-3 left-3 rounded-full border border-border bg-card/80 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-muted-foreground backdrop-blur"
          aria-hidden
        >
          {`針: ${TEXTURE_PROFILES[yarn.texture].label} · ${yarn.name}`}
        </div>
      </div>
    );
  },
);

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
