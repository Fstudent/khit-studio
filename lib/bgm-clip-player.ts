/**
 * Lyria 3 Clip / Pro が返す MP3 を Web Audio でフェード付き再生するクライアント側プレイヤー。
 *
 * Lyria RealTime（WebSocket）と違い、Lyria 3 はバッチ生成型で 1 本の完成済み
 * 楽曲（既定 ~30 秒）が返ってくるため、生成開始は早めに行い（prefetch）、
 * 用意ができたタイミングで `play()` する設計にしている。
 *
 * 設計のポイント
 *  - `prefetch` は `/api/generate-bgm` を叩いて MP3 base64 を受け取り、
 *    `decodeAudioData` で AudioBuffer に変換しておく。
 *  - `play()` で BufferSource → GainNode → destination を組んで、1.5 秒フェードイン。
 *  - `setMuted(true)` で 250ms ランプで無音、解除でターゲット音量に戻す。
 *  - `stop()` で 500ms フェードアウトしてから `BufferSource.stop()`。
 *  - エラーやステータス遷移は `onStatusChange(listener)` でアプリ側に通知。
 */

export type BgmStatus =
  | "idle"
  | "fetching"
  | "ready"
  | "playing"
  | "stopped"
  | "error";

type Listener = (status: BgmStatus, error?: string) => void;

const TARGET_VOLUME = 0.55;
const FADE_IN_SEC = 1.5;
const FADE_OUT_SEC = 0.5;
const MUTE_RAMP_SEC = 0.25;

export class BgmClipPlayer {
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private muted = false;
  private status: BgmStatus = "idle";
  private listeners = new Set<Listener>();
  private lastError: string | null = null;

  getStatus(): BgmStatus {
    return this.status;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  isReady(): boolean {
    return this.status === "ready" || this.status === "playing";
  }

  isMuted(): boolean {
    return this.muted;
  }

  onStatusChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.gainNode && this.audioCtx) {
      const now = this.audioCtx.currentTime;
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
      this.gainNode.gain.linearRampToValueAtTime(
        muted ? 0 : TARGET_VOLUME,
        now + MUTE_RAMP_SEC,
      );
    }
  }

  /**
   * Lyria 3 にクリップ生成を投げ、デコードまで済ませて再生可能状態にする。
   * 生成は数秒〜十数秒かかるので、ゲーム開始前に呼び出して並列に進めるのが想定。
   */
  async prefetch(
    prompt: string,
    opts: { model?: "lyria-3-clip-preview" | "lyria-3-pro-preview" } = {},
  ): Promise<void> {
    if (this.status === "fetching") return;
    if (this.status === "ready" || this.status === "playing") return;
    this.setStatus("fetching");

    try {
      const res = await fetch("/api/generate-bgm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          model: opts.model ?? "lyria-3-clip-preview",
        }),
      });
      const data = (await res.json()) as {
        audio?: string;
        mimeType?: string;
        error?: string;
      };
      if (!res.ok || !data.audio) {
        throw new Error(data.error ?? `BGM 生成エラー (${res.status})`);
      }

      const bytes = base64ToBytes(data.audio);
      const ctx = this.ensureAudioContext();
      // decodeAudioData は ArrayBuffer を消費するのでコピーして渡す
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const buffer = await ctx.decodeAudioData(ab);
      this.buffer = buffer;
      this.setStatus("ready");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[bgm] prefetch failed:", e);
      this.lastError = message;
      this.setStatus("error", message);
      throw e;
    }
  }

  /**
   * 用意済みクリップを再生開始。1.5 秒フェードイン。
   * すでに再生中なら何もしない。
   */
  async play(): Promise<void> {
    if (this.status === "playing") return;
    if (!this.buffer) {
      // fetch がまだ終わっていないなら呼び出し側で待つ責務
      throw new Error("BGM がまだ準備できていません。");
    }
    const ctx = this.ensureAudioContext();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // ignore: ユーザー操作後の resume は通常成功する
      }
    }

    // 既存ソースがあれば破棄
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // ignore
      }
      try {
        this.source.disconnect();
      } catch {
        // ignore
      }
      this.source = null;
    }

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);

    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = false;
    src.connect(gain);

    this.gainNode = gain;
    this.source = src;

    src.start(0);

    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(
      this.muted ? 0 : TARGET_VOLUME,
      now + FADE_IN_SEC,
    );

    this.setStatus("playing");
  }

  /**
   * フェードアウトしてから BufferSource を停止し、AudioContext を片付ける。
   */
  async stop(): Promise<void> {
    const ctx = this.audioCtx;
    const gain = this.gainNode;
    const src = this.source;

    if (gain && ctx) {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + FADE_OUT_SEC);
    }

    // フェード分待ってから物理的に止めて context を閉じる
    const audioCtxToClose = ctx;
    this.source = null;
    this.gainNode = null;
    this.audioCtx = null;
    this.buffer = null;
    this.setStatus("stopped");

    window.setTimeout(() => {
      try {
        src?.stop();
      } catch {
        // ignore
      }
      try {
        src?.disconnect();
      } catch {
        // ignore
      }
      audioCtxToClose?.close().catch(() => {});
    }, FADE_OUT_SEC * 1000 + 100);
  }

  // ---- internal ----------------------------------------------------------

  private ensureAudioContext(): AudioContext {
    if (this.audioCtx) return this.audioCtx;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.audioCtx = new Ctor();
    return this.audioCtx;
  }

  private setStatus(status: BgmStatus, error?: string) {
    this.status = status;
    if (status !== "error") this.lastError = null;
    for (const l of this.listeners) {
      try {
        l(status, error);
      } catch {
        // ignore listener error
      }
    }
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
