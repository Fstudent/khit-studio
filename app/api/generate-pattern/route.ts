import { NextResponse } from "next/server";
import { GoogleGenAI, Type } from "@google/genai";

import { YARNS, type Yarn, type YarnTexture } from "@/lib/yarns";
import {
  resampleByDistance,
  smoothPolyline,
  type Pt,
} from "@/lib/path";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL_ID = "gemini-3-flash-preview";

/**
 * 編み目の間隔（キャンバス幅 = 1.0 を基準とする正規化スペーシング）。
 * クライアント側の `spacingForYarn` と同じく、糸が太いほど目が大きく間隔も広い。
 */
const NORMALIZED_SPACING: Record<YarnTexture, number> = {
  fine: 0.018,
  medium: 0.024,
  bulky: 0.034,
  fluffy: 0.026,
};

const MAX_TOTAL_STITCHES = 260;
const MAX_STROKES = 12;
const MAX_POINTS_PER_STROKE = 14;

type RequestBody = {
  yarnIds?: string[];
  hint?: string;
  /** 生成したい編み目のおおよその目安（24〜260）。サーバ側でクランプする。 */
  targetCount?: number;
  /**
   * "initial"（既定）= 主体の線画を新規生成。
   * "expand"  = 既に描いた `subject` の周囲に追加ディテールを描き足す。
   */
  mode?: "initial" | "expand";
  /** expand モードで使う既存題材名（例: "黒猫"）。 */
  subject?: string;
  /** expand モードでの何ラウンド目の拡張か（プロンプトの指示分岐用）。 */
  expansionRound?: number;
};

type GeneratedStroke = {
  yarnId: string;
  points: Pt[];
};

type GeneratedStitch = {
  x: number;
  y: number;
  yarnId: string;
  rotation: number;
};

export async function POST(request: Request) {
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json(
      { error: "リクエストボディの JSON が不正です。" },
      { status: 400 },
    );
  }

  const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "NEXT_PUBLIC_GEMINI_API_KEY が設定されていません。.env.local を確認してください。",
      },
      { status: 500 },
    );
  }

  const yarnIds =
    Array.isArray(body.yarnIds) && body.yarnIds.length > 0
      ? body.yarnIds
      : [YARNS[0].id];
  const yarns = yarnIds
    .map((id) => YARNS.find((y) => y.id === id))
    .filter((y): y is Yarn => Boolean(y));

  if (yarns.length === 0) {
    return NextResponse.json(
      { error: "選択された糸が見つかりません。" },
      { status: 400 },
    );
  }

  const mode: "initial" | "expand" = body.mode === "expand" ? "expand" : "initial";
  const defaultTarget = mode === "expand" ? 70 : 200;
  const targetCount = clampInt(
    body.targetCount ?? defaultTarget,
    24,
    MAX_TOTAL_STITCHES,
  );
  const hint = body.hint?.trim() ?? "";
  const subject = body.subject?.trim() ?? "";
  const expansionRound = clampInt(body.expansionRound ?? 0, 0, 5);

  const palette = yarns
    .map(
      (y) =>
        `- id: ${y.id}, name: ${y.name}, color: ${y.color}, texture: ${y.texture} (${y.description})`,
    )
    .join("\n");

  const prompt =
    mode === "expand"
      ? buildExpandPrompt({ palette, subject, targetCount, expansionRound, hint })
      : buildInitialPrompt({ palette, targetCount, hint });

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: MODEL_ID,
      contents: prompt,
      config: {
        temperature: 0.85,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            subject: { type: Type.STRING },
            theme: { type: Type.STRING },
            strokes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  yarnId: { type: Type.STRING },
                  points: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        x: { type: Type.NUMBER },
                        y: { type: Type.NUMBER },
                      },
                      required: ["x", "y"],
                    },
                  },
                },
                required: ["yarnId", "points"],
              },
            },
          },
          required: ["strokes"],
        },
      },
    });

    const text = response.text;
    if (!text) {
      return NextResponse.json(
        {
          error: "Gemini からテキストが返りませんでした。",
          diagnostics: shapeDiagnostics(response),
        },
        { status: 502 },
      );
    }

    const parsed = safeParse(text);
    if (!parsed) {
      return NextResponse.json(
        {
          error: "Gemini の出力を JSON としてパースできませんでした。",
          raw: text.slice(0, 500),
        },
        { status: 502 },
      );
    }

    const allowed = new Map(yarns.map((y) => [y.id, y]));
    const strokes = sanitizeStrokes(parsed.strokes, allowed);
    if (strokes.length === 0) {
      return NextResponse.json(
        { error: "Gemini から有効なストロークが得られませんでした。" },
        { status: 502 },
      );
    }

    const stitches = expandStrokesToStitches(strokes, allowed);
    if (stitches.length === 0) {
      return NextResponse.json(
        { error: "ストロークから編み目を生成できませんでした。" },
        { status: 502 },
      );
    }

    return NextResponse.json({
      subject: typeof parsed.subject === "string" ? parsed.subject : null,
      theme: typeof parsed.theme === "string" ? parsed.theme : null,
      stitches,
      strokeCount: strokes.length,
      model: MODEL_ID,
    });
  } catch (error) {
    console.error("[generate-pattern] error:", error);
    const message = error instanceof Error ? error.message : "不明なエラー";
    return NextResponse.json(
      { error: `編みパターンの生成に失敗しました: ${message}` },
      { status: 500 },
    );
  }
}

// ---- prompt builders -------------------------------------------------------

function buildInitialPrompt(args: {
  palette: string;
  targetCount: number;
  hint: string;
}): string {
  const { palette, targetCount, hint } = args;
  return `あなたは、編み針を持って布の上をなぞり「何かの絵」を一筆書きに近い線画で描こうとする手の動きを設計するジェネレータです。
描かれたストロークはサーバ側でなめらかな曲線に補間され、糸の太さに合わせて等間隔の編み目に展開されます。
プレイヤーは表示された薄いお手本をマウスドラッグでなぞって遊ぶので、
**抽象的な模様ではなく、見て「これは○○だ」と分かる線画の絵** にしてください。
ただし「ぱっと見の単純な絵」ではなく、輪郭＋目鼻立ちや葉脈・装飾までしっかり描き込んだ
**やや複雑な線画**を狙ってください。

# 利用できる糸（このセットだけを使うこと）
${palette}

# あなたのタスク
1. 与えられた糸の色と雰囲気から、線画にしたい題材を **1 つ** 選ぶ。
   候補例（必ずしもこの中でなくてよい）:
   猫 / うさぎ / 犬 / 鳥 / 魚 / 葉 / 桜 / 椿 / リンゴ / 葡萄 /
   月 / 星 / 雲 / 雪の結晶 / 家 / 傘 / コーヒーカップ / ティーポット /
   舟 / 富士山 / 湯のみ / 椅子 / 帽子 / 靴 / ハート / 月とうさぎ / 鯨
2. その題材を **「線画の輪郭 + 顔や中身のディテール + 周囲の装飾」** の 3 層で描けるよう、
   ストロークに分解する。

# ストロークの規則
- "strokes" は ${6} 〜 ${MAX_STROKES} 本（最低 6 本以上にしてしっかり描き込むこと）。
- 各ストロークは { "yarnId": <上記id>, "points": [{x, y}, ...] }。
- "points" は ${4} 〜 ${MAX_POINTS_PER_STROKE} 個の制御点（サーバが補間する）。
- x, y は 0.0〜1.0 の正規化座標（左上 0,0 / 右下 1,1）。0.05〜0.95 の範囲に収める。
- 題材は **画面の中央付近** にまとまるよう構図を取る（おおむね x: 0.15〜0.85, y: 0.15〜0.85 に主体が収まる）。
- 主体（題材の輪郭・顔のパーツなど）と装飾（葉脈・ヒゲ・しっぽ・水玉・星屑など）で
  yarnId を分けると映える。ただし主体は基本 1 色で揃え、装飾だけ別の色を使う。
- ストロークは「実際に手で描く順番」で並べる（輪郭 → 中の線・パーツ → 装飾）。
- "strokes" 配列の順序がそのまま描画順（後のストロークが上に重なる）。
- 全ストロークの "points" 数の合計は ${Math.round(targetCount / 5)} 〜 ${Math.round(
    targetCount / 2.5,
  )} 個を目安に（しっかり多めに）。
${hint ? `- 追加のヒント: ${hint}` : ""}

# 出力フィールド
- subject: 題材の名前（日本語、最大 12 文字、例 "黒猫" / "リンゴ" / "月とうさぎ"）
- theme: その絵に添える短い一言（最大 24 文字、例 "丸まって眠る黒猫"）
- strokes: 上記ルールのストローク列

抽象パターン（横じま、市松、波だけ等）は禁止。
何かの絵に見えることを最優先してください。
JSON だけを返してください。`;
}

function buildExpandPrompt(args: {
  palette: string;
  subject: string;
  targetCount: number;
  expansionRound: number;
  hint: string;
}): string {
  const { palette, subject, targetCount, expansionRound, hint } = args;
  const decorationsByRound = [
    "周囲の小さな装飾（星屑・水玉・葉・しずく・点描・短い線など）を散らす",
    "背景や周辺のサブモチーフ（雲・波線・蕾・小花・小さな鳥や魚など）を控えめに足す",
    "更に細かい点描やキラキラ装飾、絵の余白を埋めるアクセントを加える",
  ];
  const focus = decorationsByRound[Math.min(expansionRound, decorationsByRound.length - 1)];

  return `あなたは、すでに線画で「${subject || "ある題材"}」を描いた布の上に、
**さらに装飾ストロークを描き足す** ジェネレータです。
プレイヤーは追加された薄いお手本をなぞって編むので、絵がより豊かに見えるよう、
中央の主体の周囲に **空白を埋めるディテール** を散らしてください。

# 今回のフォーカス
${focus}

# 利用できる糸（このセットだけを使うこと）
${palette}

# ストロークの規則
- "strokes" は ${2} 〜 ${4} 本だけ（多すぎないこと）。
- 各ストロークは { "yarnId": <上記id>, "points": [{x, y}, ...] }。
- "points" は ${3} 〜 ${MAX_POINTS_PER_STROKE} 個の制御点。
- x, y は 0.0〜1.0 の正規化座標（左上 0,0 / 右下 1,1）。
- **主体（${subject || "中央の絵"}）に重ねず、周辺の余白に小さく散らすこと**
  （主体はおおむね x: 0.15〜0.85, y: 0.15〜0.85 にあるとして、外周や隙間に置く）。
- ストロークの長さは短め（点描・小さな装飾モチーフ）。
- 全ストロークの "points" 数の合計は ${Math.round(targetCount / 4)} 〜 ${Math.round(
    targetCount / 2,
  )} 個程度に。
${hint ? `- 追加のヒント: ${hint}` : ""}

# 出力フィールド
- subject: 既存題材と同じ「${subject || ""}」（変更しないでよい）
- theme: 装飾を一言で（最大 16 文字、例 "舞い散る雪片"）
- strokes: 上記ルールのストローク列

JSON だけを返してください。`;
}

// ---- helpers ---------------------------------------------------------------

function safeParse(
  text: string,
): { subject?: string; theme?: string; strokes?: unknown } | null {
  try {
    return JSON.parse(text.trim());
  } catch {
    const fenced = text.match(/\{[\s\S]*\}/);
    if (!fenced) return null;
    try {
      return JSON.parse(fenced[0]);
    } catch {
      return null;
    }
  }
}

function sanitizeStrokes(
  raw: unknown,
  allowed: Map<string, Yarn>,
): GeneratedStroke[] {
  if (!Array.isArray(raw)) return [];
  const out: GeneratedStroke[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as { yarnId?: unknown; points?: unknown };
    const yarnId = typeof r.yarnId === "string" ? r.yarnId : undefined;
    if (!yarnId || !allowed.has(yarnId)) continue;

    if (!Array.isArray(r.points)) continue;
    const points: Pt[] = [];
    for (const p of r.points) {
      if (!p || typeof p !== "object") continue;
      const pp = p as { x?: unknown; y?: unknown };
      const x = Number(pp.x);
      const y = Number(pp.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      points.push({ x: clamp(x, 0, 1), y: clamp(y, 0, 1) });
      if (points.length >= MAX_POINTS_PER_STROKE) break;
    }
    if (points.length < 2) continue;

    out.push({ yarnId, points });
    if (out.length >= MAX_STROKES) break;
  }
  return out;
}

/**
 * ストロークを「なめらかなポリライン → 等弧長サンプリング」して編み目に展開する。
 * 接線方向から rotation を計算し、編み目の縦軸を進行方向にほぼ垂直に置く
 * （= ドラッグでの連続編みと同じロジック）。
 */
function expandStrokesToStitches(
  strokes: GeneratedStroke[],
  allowed: Map<string, Yarn>,
): GeneratedStitch[] {
  const stitches: GeneratedStitch[] = [];

  for (const stroke of strokes) {
    const yarn = allowed.get(stroke.yarnId);
    if (!yarn) continue;

    const spacing = NORMALIZED_SPACING[yarn.texture];
    const smooth = smoothPolyline(stroke.points, 18);
    const samples = resampleByDistance(smooth, spacing);

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      // 進行方向に対して編み目の縦軸を「ほぼ垂直」に置く（クライアント側と同じ方針）
      const jitter = (pseudoRandom(stitches.length) - 0.5) * 0.12;
      const rotation = s.tangent - Math.PI / 2 + jitter;
      stitches.push({
        x: clamp(s.pos.x, 0, 1),
        y: clamp(s.pos.y, 0, 1),
        yarnId: stroke.yarnId,
        rotation,
      });
      if (stitches.length >= MAX_TOTAL_STITCHES) return stitches;
    }
  }

  return stitches;
}

/** 同じ index で同じ値を返す決定的擬似乱数（0..1）。 */
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
function clampInt(v: number, min: number, max: number): number {
  const n = Math.round(v);
  return n < min ? min : n > max ? max : n;
}

function shapeDiagnostics(response: unknown): Record<string, unknown> {
  const r = response as {
    promptFeedback?: unknown;
    candidates?: { finishReason?: unknown; finishMessage?: unknown }[];
  };
  return {
    promptFeedback: r.promptFeedback,
    finishReason: r.candidates?.[0]?.finishReason,
    finishMessage: r.candidates?.[0]?.finishMessage,
  };
}
