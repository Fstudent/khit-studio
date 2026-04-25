import { NextResponse } from "next/server";
import {
  GoogleGenAI,
  type GenerateContentResponse,
} from "@google/genai";

export const runtime = "nodejs";
// Lyria 3 Clip は 30〜60 秒程度で返るが、混雑時の余裕を取って長めに。
export const maxDuration = 120;

const ALLOWED_MODELS = new Set(["lyria-3-clip-preview", "lyria-3-pro-preview"]);
const DEFAULT_MODEL = "lyria-3-clip-preview";

type RequestBody = {
  prompt?: string;
  model?: string;
};

/**
 * Lyria 3 Clip / Pro による BGM 生成。30 秒のお手本ゲーム用に、
 * 緊張アーク（calm → warming → tense → panic）を 1 本のクリップに
 * 詰め込んでもらう前提のエンドポイント。
 *
 * 出力: base64 エンコードされた MP3（Lyria 3 のデフォルト出力フォーマット）。
 * クライアントでは AudioContext.decodeAudioData → BufferSource で再生する。
 */
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

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return NextResponse.json(
      { error: "BGM のプロンプトが空です。" },
      { status: 400 },
    );
  }

  const requested = body.model?.trim();
  const model =
    requested && ALLOWED_MODELS.has(requested) ? requested : DEFAULT_MODEL;

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

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseModalities: ["AUDIO", "TEXT"],
      },
    });

    const extracted = extractAudio(response);
    if (!extracted.audioBase64) {
      return NextResponse.json(
        {
          error:
            "音声データが返されませんでした。プロンプトのセーフティ違反や課金切れの可能性があります。",
          diagnostics: {
            finishReason: response.candidates?.[0]?.finishReason,
            blockReason: response.promptFeedback?.blockReason,
            model,
          },
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      audio: extracted.audioBase64,
      mimeType: extracted.mimeType,
      model,
    });
  } catch (error) {
    console.error("[generate-bgm] error:", error);
    const raw = error instanceof Error ? error.message : "不明なエラー";
    const parsed = tryExtractApiError(raw);
    if (parsed?.code === 429) {
      return NextResponse.json(
        {
          error:
            "Gemini API のクレジットが不足しています（プリペイド残高 0）。Lyria 3 は有料モデルのため、AI Studio で課金設定を確認してください。",
          link: "https://ai.studio/projects",
        },
        { status: 429 },
      );
    }
    if (parsed?.code === 403 || parsed?.code === 401) {
      return NextResponse.json(
        {
          error:
            "API キーが無効か、Lyria 3 へのアクセス権がありません。AI Studio で API キーと請求設定を確認してください。",
        },
        { status: parsed.code },
      );
    }
    return NextResponse.json(
      {
        error: `BGM の生成に失敗しました: ${parsed?.message ?? raw}`,
      },
      { status: parsed?.code && parsed.code >= 400 && parsed.code < 600 ? parsed.code : 500 },
    );
  }
}

// ---- helpers ---------------------------------------------------------------

function extractAudio(response: GenerateContentResponse): {
  audioBase64: string | null;
  mimeType: string;
} {
  let audioBase64: string | null = null;
  let mimeType = "audio/mpeg";
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (!audioBase64 && part.inlineData?.data) {
        audioBase64 = part.inlineData.data;
        if (part.inlineData.mimeType) mimeType = part.inlineData.mimeType;
      }
    }
  }
  return { audioBase64, mimeType };
}

function tryExtractApiError(
  message: string,
): { code?: number; message?: string } | null {
  const jsonStart = message.indexOf("{");
  if (jsonStart === -1) return null;
  try {
    const json = JSON.parse(message.slice(jsonStart));
    const err = (json as { error?: { code?: number; message?: string } }).error;
    if (!err) return null;
    return { code: err.code, message: err.message };
  } catch {
    return null;
  }
}
