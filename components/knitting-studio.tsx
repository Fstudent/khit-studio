"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Brush,
  Eraser,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Swords,
  Target,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import { GameTimer } from "@/components/game-timer";
import { KnittingCanvas, type KnittingCanvasHandle } from "@/components/knitting-canvas";
import { YarnSelector } from "@/components/yarn-selector";
import { BgmClipPlayer, type BgmStatus } from "@/lib/bgm-clip-player";
import { findYarn, YARNS, type Yarn } from "@/lib/yarns";
import { scorePattern, type ScoreResult } from "@/lib/scoring";
import { bgmClipPrompt } from "@/lib/tension-prompts";
import { cn } from "@/lib/utils";

type GeneratePatternResponse = {
  subject: string | null;
  theme: string | null;
  stitches: {
    x: number;
    y: number;
    yarnId: string;
    rotation?: number;
  }[];
  error?: string;
};

type Mode = "free" | "copy";

type GameState = "idle" | "playing" | "finished";

const GAME_DURATION_MS = 30_000;
const GAME_DURATION_SEC = Math.round(GAME_DURATION_MS / 1000);
const TICK_MS = 100;

export function KnittingStudio() {
  const canvasRef = useRef<KnittingCanvasHandle | null>(null);

  const [mode, setMode] = useState<Mode>("free");
  const [activeYarnId, setActiveYarnId] = useState<string>(YARNS[0].id);
  const [paletteIds, setPaletteIds] = useState<string[]>(() =>
    YARNS.slice(0, 3).map((y) => y.id),
  );
  const [hint, setHint] = useState("");
  const [count, setCount] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [theme, setTheme] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // --- copy 用の状態 ---
  const [hasGuide, setHasGuide] = useState(false);
  const [guideCount, setGuideCount] = useState(0);
  const [questSubject, setQuestSubject] = useState<string | null>(null);
  const [questTheme, setQuestTheme] = useState<string | null>(null);
  const [score, setScore] = useState<ScoreResult | null>(null);

  // --- ゲーム進行・BGM ---
  const [gameState, setGameState] = useState<GameState>("idle");
  const [remainingMs, setRemainingMs] = useState(GAME_DURATION_MS);
  const [musicMuted, setMusicMuted] = useState(false);
  const [bgmStatus, setBgmStatus] = useState<BgmStatus>("idle");
  const [bgmError, setBgmError] = useState<string | null>(null);

  const bgmRef = useRef<BgmClipPlayer | null>(null);
  const tickIntervalRef = useRef<number | null>(null);
  const gameEndedAtRef = useRef<number | null>(null);
  const judgeRef = useRef<() => void>(() => {});

  const activeYarn = useMemo(() => findYarn(activeYarnId), [activeYarnId]);

  const handleSelectYarn = useCallback((yarn: Yarn) => {
    setActiveYarnId(yarn.id);
    setPaletteIds((prev) =>
      prev.includes(yarn.id) ? prev : [...prev, yarn.id].slice(-6),
    );
  }, []);

  const togglePalette = useCallback((id: string) => {
    setPaletteIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id].slice(-6),
    );
  }, []);

  const handleClear = useCallback(() => {
    canvasRef.current?.clear();
    setTheme(null);
    setError(null);
    setScore(null);
  }, []);

  // --- ゲーム制御（タイマー + Lyria 3 Clip BGM） ---

  /** 進行中のタイマーと音楽を完全に停止する（BGM プレイヤーも破棄）。 */
  const stopGame = useCallback(async () => {
    if (tickIntervalRef.current != null) {
      window.clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = null;
    }
    // 次戦の prefetch リスナが「前戦の値」を見て前倒し再生してしまうのを防ぐ
    gameEndedAtRef.current = null;
    const bgm = bgmRef.current;
    bgmRef.current = null;
    setBgmStatus("idle");
    if (bgm) {
      try {
        await bgm.stop();
      } catch (e) {
        console.warn("[bgm] stop error", e);
      }
    }
  }, []);

  /**
   * Lyria 3 Clip にゲーム用 BGM の生成だけを開始させる（事前取得）。
   * **再生はここでは行わない**（タイマー開始と音を揃えるため）。
   * 生成完了は `bgmRef.current.isReady()` で startGame 側からチェックする。
   */
  const prefetchBgm = useCallback(() => {
    setBgmError(null);
    const player = new BgmClipPlayer();
    player.setMuted(musicMuted);
    bgmRef.current = player;
    setBgmStatus("idle");

    const unsub = player.onStatusChange((s, err) => {
      setBgmStatus(s);
      if (s === "error") {
        setBgmError(`BGM 生成に失敗しました（${err ?? "不明なエラー"}）。タイマーは続行します。`);
      }
    });

    player
      .prefetch(bgmClipPrompt(GAME_DURATION_SEC), { model: "lyria-3-clip-preview" })
      .catch(() => {
        // 詳細メッセージは onStatusChange("error") 経由で表示済み
      })
      .finally(() => {
        unsub();
      });
  }, [musicMuted]);

  /**
   * 30 秒カウントダウン開始と同時に BGM を再生（タイマーと音を完全同期）。
   * - クリップが既に ready なら即時再生
   * - まだ生成中なら、ready になった瞬間に再生する一回限りの listener を張る
   * - クリップが間に合わなくてもタイマーは止めない
   */
  const startGame = useCallback(async () => {
    setGameState("playing");
    setRemainingMs(GAME_DURATION_MS);

    const startedAt = performance.now();
    gameEndedAtRef.current = startedAt + GAME_DURATION_MS;

    const bgm = bgmRef.current;
    if (bgm) {
      if (bgm.isReady()) {
        try {
          await bgm.play();
        } catch (e) {
          console.warn("[bgm] play failed", e);
        }
      } else {
        // まだ生成中 → ready になったら再生（ゲーム終了済みなら捨てる）
        const stop = bgm.onStatusChange((s) => {
          if (bgmRef.current !== bgm) {
            stop();
            return;
          }
          if (s === "ready" && gameEndedAtRef.current != null) {
            bgm.play().catch((e) =>
              console.warn("[bgm] deferred play failed", e),
            );
            stop();
          } else if (s === "error" || s === "stopped") {
            stop();
          }
        });
      }
    }

    if (tickIntervalRef.current != null) window.clearInterval(tickIntervalRef.current);
    tickIntervalRef.current = window.setInterval(() => {
      const now = performance.now();
      const remaining = Math.max(0, (gameEndedAtRef.current ?? now) - now);
      setRemainingMs(remaining);
      if (remaining <= 0) {
        if (tickIntervalRef.current != null) {
          window.clearInterval(tickIntervalRef.current);
          tickIntervalRef.current = null;
        }
        judgeRef.current();
      }
    }, TICK_MS);
  }, []);

  /** 自由モード: AI がパレットから模様を編む */
  const handleGenerate = useCallback(async () => {
    setError(null);
    setGenerating(true);
    try {
      const yarnIds = paletteIds.length > 0 ? paletteIds : [activeYarn.id];
      const res = await fetch("/api/generate-pattern", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yarnIds,
          hint: hint.trim() || undefined,
          targetCount: 140,
        }),
      });
      const data = (await res.json()) as GeneratePatternResponse;
      if (!res.ok) {
        setError(data.error ?? "生成に失敗しました。");
        return;
      }
      setTheme(data.theme);
      await canvasRef.current?.playPattern(
        data.stitches.map((s) => ({
          x: s.x,
          y: s.y,
          yarnId: s.yarnId,
          rotation: s.rotation,
        })),
        { intervalMs: 14 },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "ネットワークエラーが発生しました。");
    } finally {
      setGenerating(false);
    }
  }, [activeYarn.id, hint, paletteIds]);

  /** コピーモード: お手本を生成してガイド表示 → BGM 並列取得 → ゲーム開始 */
  const handleGenerateGuide = useCallback(async () => {
    setError(null);
    setScore(null);
    await stopGame();
    setGameState("idle");
    setRemainingMs(GAME_DURATION_MS);
    setGenerating(true);
    canvasRef.current?.clear();

    // BGM の生成を先回りで開始（パターン生成と並列）
    prefetchBgm();

    try {
      // アイボリーは背景（リネン地）と同化するためお手本では使わない
      const candidates = YARNS.filter((y) => y.id !== "ivory");
      const seed = pickRandom(candidates, 3).map((y) => y.id);
      const res = await fetch("/api/generate-pattern", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yarnIds: seed,
          mode: "initial",
          targetCount: 200,
        }),
      });
      const data = (await res.json()) as GeneratePatternResponse;
      if (!res.ok) {
        setError(data.error ?? "お手本の生成に失敗しました。");
        return;
      }
      const usedIds = Array.from(new Set(data.stitches.map((s) => s.yarnId)));
      setQuestSubject(data.subject ?? null);
      setQuestTheme(data.theme ?? null);
      const first = usedIds[0] ?? activeYarnId;
      setActiveYarnId(first);
      setHasGuide(true);
      setGuideCount(data.stitches.length);
      await canvasRef.current?.setGuide(
        data.stitches.map((s) => ({
          x: s.x,
          y: s.y,
          yarnId: s.yarnId,
          rotation: s.rotation,
        })),
        { intervalMs: 6 },
      );
      await startGame();
    } catch (e) {
      setError(e instanceof Error ? e.message : "ネットワークエラーが発生しました。");
    } finally {
      setGenerating(false);
    }
  }, [activeYarnId, prefetchBgm, startGame, stopGame]);

  /** コピーモード: 採点（手動 / 時間切れ自動）。BGM・タイマーも止める。 */
  const handleJudge = useCallback(async () => {
    await stopGame();
    setGameState("finished");
    const player = canvasRef.current?.getStitches() ?? [];
    const guide = canvasRef.current?.getGuide() ?? [];
    setScore(scorePattern(guide, player));
  }, [stopGame]);

  /** 同じお手本でもう一度プレイする。BGM も再取得する。 */
  const handleRetry = useCallback(async () => {
    setScore(null);
    canvasRef.current?.clear();
    // 既存の BGM プレイヤーは破棄して、新しいクリップを取り直す（毎回違う雰囲気で）
    prefetchBgm();
    await startGame();
  }, [prefetchBgm, startGame]);

  /** モード切替 */
  const handleSwitchMode = useCallback(
    (next: Mode) => {
      setMode(next);
      setError(null);
      setScore(null);
      setTheme(null);
      setHasGuide(false);
      setGuideCount(0);
      setQuestSubject(null);
      setQuestTheme(null);
      setBgmError(null);
      void stopGame();
      setGameState("idle");
      setRemainingMs(GAME_DURATION_MS);
      canvasRef.current?.clear();
      canvasRef.current?.setGuide([]);
    },
    [stopGame],
  );

  // judge を ref 経由で参照（タイマー側のクロージャ陳腐化を回避）
  useEffect(() => {
    judgeRef.current = () => {
      void handleJudge();
    };
  }, [handleJudge]);

  // ミュート切り替えを BGM プレイヤーに反映
  useEffect(() => {
    bgmRef.current?.setMuted(musicMuted);
  }, [musicMuted]);

  // アンマウント時に必ず後始末（音やタイマーが残らないように）
  useEffect(() => {
    return () => {
      void stopGame();
    };
  }, [stopGame]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      {/* === 左: キャンバス === */}
      <div className="flex flex-col gap-4">
        <ModeTabs mode={mode} onChange={handleSwitchMode} />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              aria-hidden
              className="inline-block size-3 rounded-full border border-border/70"
              style={{ backgroundColor: activeYarn.color }}
            />
            <span>
              現在の編み糸:{" "}
              <span className="font-medium text-foreground">{activeYarn.name}</span>
            </span>
            <span className="ml-3 hidden sm:inline">
              編み目: <span className="font-medium text-foreground">{count}</span>
              {mode === "copy" && hasGuide && (
                <span className="ml-3">
                  お手本: <span className="font-medium text-foreground">{guideCount}</span>
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {mode === "copy" && (
              <button
                type="button"
                onClick={() => setMusicMuted((m) => !m)}
                className="craft-shadow inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground/80 transition hover:bg-background-2"
                aria-pressed={musicMuted}
                aria-label={musicMuted ? "BGM をオン" : "BGM をオフ"}
                title={musicMuted ? "BGM をオン" : "BGM をオフ"}
              >
                {musicMuted ? (
                  <VolumeX className="size-3.5" />
                ) : (
                  <Volume2 className="size-3.5" />
                )}
              </button>
            )}
            {mode === "copy" && hasGuide && gameState === "playing" && (
              <button
                type="button"
                onClick={handleJudge}
                className="craft-shadow inline-flex items-center gap-1.5 rounded-full border border-border bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:opacity-95 disabled:opacity-50"
                disabled={generating || count === 0}
              >
                <Target className="size-3.5" />
                採点する
              </button>
            )}
            {mode === "copy" && hasGuide && gameState === "finished" && (
              <button
                type="button"
                onClick={handleRetry}
                className="craft-shadow inline-flex items-center gap-1.5 rounded-full border border-border bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:opacity-95 disabled:opacity-50"
                disabled={generating}
              >
                <RotateCcw className="size-3.5" />
                もう一度
              </button>
            )}
            <button
              type="button"
              onClick={handleClear}
              className="craft-shadow inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground/80 transition hover:bg-background-2 disabled:opacity-50"
              disabled={count === 0 || generating}
            >
              <Eraser className="size-3.5" />
              ほどく
            </button>
          </div>
        </div>

        {mode === "copy" && hasGuide && gameState !== "idle" && (
          <GameTimer
            remainingMs={remainingMs}
            totalMs={GAME_DURATION_MS}
            musicMuted={musicMuted}
            bgmStatus={bgmStatus}
          />
        )}

        {mode === "copy" && bgmError && (
          <p className="rounded-lg border border-amber-300/60 bg-amber-50/70 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
            {bgmError}
          </p>
        )}

        <KnittingCanvas
          ref={canvasRef}
          yarn={activeYarn}
          onCountChange={setCount}
        />

        <p className="text-center text-[11px] text-muted-foreground sm:text-left">
          {mode === "free"
            ? "キャンバスをクリックすると編み目が 1 つ置かれ、ドラッグすると連続して編まれます。新しい編み目は古い編み目の上に重なります。"
            : `${GAME_DURATION_SEC} 秒以内にお手本をなぞって編みきりましょう。残り時間が少なくなるほど BGM の緊張感が増していきます。`}
        </p>
      </div>

      {/* === 右: コントロール === */}
      <aside className="flex flex-col gap-4">
        <YarnSelector selectedId={activeYarnId} onSelect={handleSelectYarn} />

        {mode === "free" ? (
          <FreeModePanel
            paletteIds={paletteIds}
            togglePalette={togglePalette}
            hint={hint}
            setHint={setHint}
            generating={generating}
            onGenerate={handleGenerate}
            theme={theme}
            error={error}
          />
        ) : (
          <CopyModePanel
            generating={generating}
            hasGuide={hasGuide}
            questSubject={questSubject}
            questTheme={questTheme}
            onGenerateGuide={handleGenerateGuide}
            error={error}
          />
        )}

        <div className="rounded-2xl border border-border/70 bg-card/40 p-4 text-[11px] leading-relaxed text-muted-foreground">
          <p className="mb-1 font-semibold text-foreground/80">
            {mode === "free" ? "使い方" : "コピーゲームの遊び方"}
          </p>
          {mode === "free" ? (
            <ol className="list-decimal space-y-1 pl-4">
              <li>糸玉をクリックして、編み糸を 1 つ選びます。</li>
              <li>キャンバスをクリックまたはドラッグして編み目を置きます。</li>
              <li>「おまかせで編む」を押すと AI が編み模様を提案します。</li>
            </ol>
          ) : (
            <ol className="list-decimal space-y-1 pl-4">
              <li>「お手本を生成」を押すと、{GAME_DURATION_SEC} 秒のカウントダウンと Lyria 3 製の BGM が同時に始まります。</li>
              <li>薄く表示されたお手本を、同じ色の糸でドラッグしてなぞります。</li>
              <li>残り時間が少なくなるほど BGM が緊迫していきます。</li>
              <li>「採点する」または時間切れで、再現度が <strong>SS〜D</strong> でランク付けされます。</li>
            </ol>
          )}
        </div>
      </aside>

      <ScoreModal
        score={score}
        subject={questSubject}
        theme={questTheme}
        onClose={() => setScore(null)}
        onRetry={
          mode === "copy" && hasGuide
            ? () => {
                setScore(null);
                void handleRetry();
              }
            : undefined
        }
      />
    </div>
  );
}

// ---- mode tabs -------------------------------------------------------------

function ModeTabs({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="モード切り替え"
      className="craft-shadow inline-flex w-fit items-center rounded-full border border-border bg-card p-1"
    >
      {(
        [
          { id: "free", label: "自由に編む", Icon: Brush },
          { id: "copy", label: "お手本コピー", Icon: Swords },
        ] as const
      ).map(({ id, label, Icon }) => {
        const active = mode === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition",
              active
                ? "bg-primary text-primary-foreground"
                : "text-foreground/70 hover:bg-background-2/60",
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ---- free panel ------------------------------------------------------------

function FreeModePanel({
  paletteIds,
  togglePalette,
  hint,
  setHint,
  generating,
  onGenerate,
  theme,
  error,
}: {
  paletteIds: string[];
  togglePalette: (id: string) => void;
  hint: string;
  setHint: (s: string) => void;
  generating: boolean;
  onGenerate: () => void;
  theme: string | null;
  error: string | null;
}) {
  return (
    <div className="craft-shadow rounded-2xl border border-border bg-card/80 p-4 backdrop-blur">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="size-4 text-accent" />
        <h2
          className="text-sm font-semibold tracking-wide"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Gemini におまかせで編む
        </h2>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        下の糸玉を最大 6 色までパレットに加えると、Gemini 2.5 Flash
        がそれらの糸から連想される編み模様を考え、布の上に少しずつ編み広げます。
      </p>

      <div className="mt-3">
        <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          使う糸（タップで切替）
        </p>
        <div className="flex flex-wrap gap-2">
          {YARNS.map((y) => {
            const on = paletteIds.includes(y.id);
            return (
              <button
                key={y.id}
                type="button"
                onClick={() => togglePalette(y.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition",
                  on
                    ? "border-foreground/40 bg-background-2 text-foreground"
                    : "border-border bg-card text-muted-foreground hover:bg-background-2/50",
                )}
                aria-pressed={on}
              >
                <span
                  aria-hidden
                  className="inline-block size-2.5 rounded-full"
                  style={{ backgroundColor: y.color }}
                />
                {y.name}
              </button>
            );
          })}
        </div>
      </div>

      <label className="mt-3 block">
        <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          ヒント（任意）
        </span>
        <input
          type="text"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          placeholder="例: 横縞のグラデーション、雪の結晶、市松模様…"
          className={cn(
            "mt-1 w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm",
            "outline-none focus:border-ring focus:ring-2 focus:ring-ring/40",
            "placeholder:text-muted-foreground/60",
          )}
          maxLength={120}
        />
      </label>

      <button
        type="button"
        onClick={onGenerate}
        disabled={generating || paletteIds.length === 0}
        className={cn(
          "mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold",
          "bg-primary text-primary-foreground craft-shadow",
          "transition hover:opacity-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {generating ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            編んでいます…
          </>
        ) : (
          <>
            <Sparkles className="size-4" />
            おまかせで編む
          </>
        )}
      </button>

      <AnimatePresence>
        {theme && !generating && (
          <motion.p
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            className="mt-3 rounded-lg border border-border/70 bg-background-2/40 px-3 py-2 text-xs leading-relaxed text-foreground/80"
          >
            <span className="mr-1 font-semibold">テーマ:</span>
            {theme}
          </motion.p>
        )}
        {error && (
          <motion.p
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            className="mt-3 rounded-lg border border-red-300/60 bg-red-50/70 px-3 py-2 text-xs text-red-800"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---- copy panel ------------------------------------------------------------

function CopyModePanel({
  generating,
  hasGuide,
  questSubject,
  questTheme,
  onGenerateGuide,
  error,
}: {
  generating: boolean;
  hasGuide: boolean;
  questSubject: string | null;
  questTheme: string | null;
  onGenerateGuide: () => void;
  error: string | null;
}) {
  return (
    <div className="craft-shadow rounded-2xl border border-border bg-card/80 p-4 backdrop-blur">
      <div className="mb-3 flex items-center gap-2">
        <Swords className="size-4 text-accent" />
        <h2
          className="text-sm font-semibold tracking-wide"
          style={{ fontFamily: "var(--font-display)" }}
        >
          お絵かきコピー
        </h2>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Gemini 3 Flash が描いた線画のお手本を、Lyria 3 Clip の BGM 付き 30 秒勝負でなぞります。
        どれだけ忠実に再現できるかを SS〜D の 6 段階で評価します。
      </p>

      <button
        type="button"
        onClick={onGenerateGuide}
        disabled={generating}
        className={cn(
          "mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold",
          "bg-primary text-primary-foreground craft-shadow",
          "transition hover:opacity-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {generating ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            お手本を編んでいます…
          </>
        ) : (
          <>
            {hasGuide ? <RefreshCw className="size-4" /> : <Sparkles className="size-4" />}
            {hasGuide ? "別のお題に挑戦" : "お手本を生成"}
          </>
        )}
      </button>

      {hasGuide && (
        <div className="mt-4 space-y-3">
          {(questSubject || questTheme) && (
            <div className="rounded-xl border border-border/70 bg-background-2/40 px-3 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                お題
              </p>
              {questSubject && (
                <p
                  className="mt-1 text-lg font-semibold leading-tight tracking-tight text-foreground"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {questSubject}
                </p>
              )}
              {questTheme && (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {questTheme}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <AnimatePresence>
        {error && (
          <motion.p
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            className="mt-3 rounded-lg border border-red-300/60 bg-red-50/70 px-3 py-2 text-xs text-red-800"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---- score modal -----------------------------------------------------------

const RANK_COLOR: Record<ScoreResult["rank"], string> = {
  SS: "#c8633b",
  S: "#d39a2a",
  A: "#5d7a3c",
  B: "#274f7a",
  C: "#a7c8d8",
  D: "#3a3733",
};

function ScoreModal({
  score,
  subject,
  theme,
  onClose,
  onRetry,
}: {
  score: ScoreResult | null;
  subject: string | null;
  theme: string | null;
  onClose: () => void;
  onRetry?: () => void;
}) {
  return (
    <AnimatePresence>
      {score && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="採点結果"
          onClick={onClose}
        >
          <motion.div
            initial={{ y: 16, scale: 0.96, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 8, scale: 0.98, opacity: 0 }}
            transition={{ type: "spring", stiffness: 280, damping: 24 }}
            className="craft-shadow relative w-full max-w-md rounded-2xl border border-border bg-card p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="閉じる"
              className="absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-background-2/60"
            >
              <X className="size-4" />
            </button>

            {subject && (
              <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                お題: <span className="text-foreground/80">{subject}</span>
                {theme && (
                  <span className="ml-2 normal-case font-normal tracking-normal text-muted-foreground">
                    — {theme}
                  </span>
                )}
              </p>
            )}

            <div className="flex items-center gap-4">
              <div
                aria-hidden
                className="grid size-20 place-items-center rounded-2xl text-3xl font-bold text-white"
                style={{ backgroundColor: RANK_COLOR[score.rank] }}
              >
                {score.rank}
              </div>
              <div>
                <p
                  className="text-3xl font-semibold leading-none tracking-tight"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {score.total}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">/ 100</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  お手本 {score.guideCount} 目 / 編んだ {score.playerCount} 目
                </p>
              </div>
            </div>

            <p className="mt-4 text-sm leading-relaxed text-foreground/80">
              {score.comment}
            </p>

            <dl className="mt-5 grid grid-cols-3 gap-2 text-center">
              <Metric label="カバレッジ" value={`${score.coverage}%`} />
              <Metric label="色一致" value={`${score.colorAccuracy}%`} />
              <Metric label="位置の近さ" value={`${score.positionAccuracy}%`} />
            </dl>

            {score.extraCount > 0 && (
              <p className="mt-3 text-[11px] text-muted-foreground">
                はみ出した編み目: {score.extraCount} 目
              </p>
            )}

            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground craft-shadow transition hover:opacity-95 active:scale-[0.98]"
                >
                  <RotateCcw className="size-4" />
                  もう一度挑戦
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className={cn(
                  "inline-flex flex-1 items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold craft-shadow transition active:scale-[0.98]",
                  onRetry
                    ? "border border-border bg-card text-foreground/80 hover:bg-background-2"
                    : "bg-primary text-primary-foreground hover:opacity-95",
                )}
              >
                閉じる
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-background-2/40 px-2 py-2">
      <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}

// ---- helpers ---------------------------------------------------------------

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}
