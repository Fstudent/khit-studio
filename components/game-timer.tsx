"use client";

import { useMemo } from "react";

import type { BgmStatus } from "@/lib/bgm-clip-player";
import { tensionLabel, tensionStage } from "@/lib/tension-prompts";

type Props = {
  remainingMs: number;
  totalMs: number;
  /** ミュートしている場合はサブテキストを音楽連動表現にしない */
  musicMuted?: boolean;
  /** Lyria 3 Clip の取得状況（fetching / ready / playing / error）。 */
  bgmStatus?: BgmStatus;
};

/**
 * カウントダウンの帯。残量バー + 残り秒数 + 緊張度ラベル + BGM 取得状態を表示する。
 * 進捗バーは赤に近づくにつれ色と発光が強くなり、視覚にも緊迫感を載せる。
 */
export function GameTimer({
  remainingMs,
  totalMs,
  musicMuted,
  bgmStatus,
}: Props) {
  const safeTotal = Math.max(1, totalMs);
  const elapsed = Math.max(0, Math.min(safeTotal, safeTotal - remainingMs));
  const t = elapsed / safeTotal;
  const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));

  const stage = tensionStage(t);
  const subLabel = useMemo(() => {
    if (musicMuted) {
      if (stage === "panic") return "ラストスパート！";
      if (stage === "tense") return "残りわずか";
      if (stage === "warming") return "そろそろ巻きで";
      return "落ち着いて編んで";
    }
    return tensionLabel(stage);
  }, [stage, musicMuted]);

  const progress = Math.min(100, Math.max(0, t * 100));
  const palette = stagePalette(stage);

  return (
    <div className="rounded-xl border border-border/70 bg-background-2/60 px-3 py-3 craft-shadow">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          残り時間
        </p>
        <p
          className="font-mono text-2xl font-semibold leading-none tabular-nums"
          style={{ color: palette.text, textShadow: palette.glow }}
        >
          {String(remainingSec).padStart(2, "0")}
          <span className="ml-1 text-[11px] font-medium tracking-[0.2em] text-muted-foreground">
            sec
          </span>
        </p>
      </div>

      <div className="mt-2 h-2 overflow-hidden rounded-full bg-background-2/80">
        <div
          className="h-full rounded-full transition-[width,background-color] duration-200 ease-out"
          style={{
            width: `${progress}%`,
            background: palette.bar,
            boxShadow: palette.glow,
          }}
        />
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px] tracking-wide text-muted-foreground">
        <span>{subLabel}</span>
        <span className="font-mono tabular-nums">
          {Math.round(progress)}%
        </span>
      </div>

      {bgmStatus && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] tracking-wide text-muted-foreground">
          <span
            className="rounded-full border border-border/60 bg-background/60 px-2 py-[2px]"
            style={
              bgmStatus === "playing" && !musicMuted
                ? { color: "oklch(0.45 0.18 145)", borderColor: "oklch(0.7 0.15 145 / 0.5)" }
                : bgmStatus === "error"
                  ? { color: "oklch(0.45 0.22 25)", borderColor: "oklch(0.7 0.2 25 / 0.5)" }
                  : undefined
            }
          >
            {bgmStatusLabel(bgmStatus, musicMuted)}
          </span>
        </div>
      )}
    </div>
  );
}

function bgmStatusLabel(status: BgmStatus, muted?: boolean): string {
  switch (status) {
    case "fetching":
      return "BGM 生成中…(Lyria 3 Clip)";
    case "ready":
      return "BGM 準備完了";
    case "playing":
      return muted ? "BGM ミュート中" : "BGM 再生中";
    case "stopped":
      return "BGM 停止";
    case "error":
      return "BGM エラー";
    case "idle":
    default:
      return "BGM 待機";
  }
}

type StagePalette = {
  text: string;
  bar: string;
  glow: string;
};

function stagePalette(stage: ReturnType<typeof tensionStage>): StagePalette {
  switch (stage) {
    case "calm":
      return {
        text: "var(--foreground)",
        bar: "linear-gradient(90deg, oklch(0.78 0.09 75), oklch(0.7 0.12 75))",
        glow: "0 0 0 rgba(0,0,0,0)",
      };
    case "warming":
      return {
        text: "oklch(0.55 0.16 65)",
        bar: "linear-gradient(90deg, oklch(0.75 0.13 75), oklch(0.66 0.17 55))",
        glow: "0 0 6px oklch(0.66 0.17 55 / 0.35)",
      };
    case "tense":
      return {
        text: "oklch(0.5 0.2 35)",
        bar: "linear-gradient(90deg, oklch(0.7 0.16 55), oklch(0.55 0.21 30))",
        glow: "0 0 10px oklch(0.55 0.21 30 / 0.55)",
      };
    case "panic":
      return {
        text: "oklch(0.45 0.24 28)",
        bar: "linear-gradient(90deg, oklch(0.62 0.21 35), oklch(0.45 0.25 25))",
        glow: "0 0 14px oklch(0.5 0.25 28 / 0.7)",
      };
  }
}
