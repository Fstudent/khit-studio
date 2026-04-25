/**
 * Lyria 3 Clip / Pro 用の BGM プロンプト生成。
 *
 * Lyria 3 はバッチ生成（1 リクエストで完成済み楽曲が返る）なので、リアルタイムに
 * "緊張度" を steer することはできない。代わりに 1 本のクリップ内で
 *   calm → warming → tense → panic
 * のアークが時間とともに進行するよう、構造化したプロンプトで指示する。
 *
 * Lyria 3 Clip の出力は概ね指定 30 秒前後（既定）なので、ゲーム制限時間と
 * クリップ長を揃えると BGM の最後と時間切れがほぼ同時に決まり気持ちいい。
 *
 * UI のサブラベル（「落ち着いて編んで」「ラストスパート！」など）は
 * クライアント側のタイマーが現在の経過率から決定する（モデル出力には依存しない）。
 */

export type TensionStage = "calm" | "warming" | "tense" | "panic";

/**
 * 30 秒程度の "緊張アーク BGM" を 1 本生成するためのプロンプト。
 * Lyria 3 はジャンル・テンポ・楽器構成・進行を構造化して指示すると追従度が高い。
 */
export function bgmClipPrompt(durationSec = 30): string {
  const phase1End = Math.round(durationSec * 0.33);
  const phase2End = Math.round(durationSec * 0.66);
  const total = Math.round(durationSec);
  return `A ${total}-second cinematic instrumental BGM for a quick reaction-based knitting mini-game.
The track must build a sense of urgency over time, in three seamlessly connected phases. No vocals, no silence between phases, continuous flow.

Phase 1 (0–${phase1End}s) — Calm crafting:
Soft acoustic guitar fingerpicking and gentle harp arpeggios, very light hand percussion (shaker, soft brush). Cozy, warm, lo-fi crafting cafe atmosphere. Slow tempo around 80 BPM, major key.

Phase 2 (${phase1End}–${phase2End}s) — Tension rising:
Sustained strings enter underneath. A subtle ticking percussion (woodblock or rim-click clock pattern) suggests time slipping away. Tempo creeps up to about 110 BPM. Mood shifts to anticipation and slight unease, harmonic minor coloring.

Phase 3 (${phase2End}–${total}s) — Panic climax:
Frantic staccato strings with tremolo, fast aggressive percussion (kick, snare, hi-hat 16ths), racing-heartbeat low pulse. Tempo around 140 BPM. Strong dramatic finish landing on the final downbeat at ${total}s.

Style: cinematic film-score quality underscore, tight stereo image, no vocals, no fade out (end on a strong hit).`;
}

/** UI 用：経過率 t から段階を判定（タイマーの色やサブラベルに使う）。 */
export function tensionStage(t: number): TensionStage {
  const x = clamp01(t);
  if (x < 0.33) return "calm";
  if (x < 0.66) return "warming";
  if (x < 0.9) return "tense";
  return "panic";
}

export function tensionLabel(stage: TensionStage): string {
  switch (stage) {
    case "calm":
      return "落ち着いて編んで";
    case "warming":
      return "そろそろ巻きで";
    case "tense":
      return "急いで！";
    case "panic":
      return "ラストスパート！";
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
