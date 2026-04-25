# 編 — Knit Studio

デジタルの糸で「編む」体験をシミュレーションするインタラクティブな Web プロトタイプです。
糸玉から色と質感を選び、布の上をクリック・ドラッグすると、V 字の編み目が連なって積み重なります。
「おまかせで編む」ボタンを押すと、Google Gemini 2.5 Flash が選んだ糸からふさわしい編み模様の座標データを生成し、
布の上に少しずつアニメーションで編み広げます。

- **Framework**: Next.js 16 (App Router) + React 19
- **Language**: TypeScript
- **Styling**: Tailwind CSS v4（布テクスチャ・温かいクラフト配色）
- **Drawing**: HTML5 Canvas（描画順 = z-index で「編み物特有の重なり」を表現）
- **Animation/UI**: Framer Motion（糸玉のホバー・選択、結果のフェードイン）
- **AI**: `@google/genai` SDK / `gemini-2.5-flash`（`responseSchema` で構造化 JSON を取得）

## セットアップ

```bash
npm install
cp .env.example .env.local
# .env.local に NEXT_PUBLIC_GEMINI_API_KEY を設定
```

API キーは [Google AI Studio](https://aistudio.google.com/app/apikey) から取得できます。
本番運用ではクライアントへの露出を避けるため `GEMINI_API_KEY` に変更し、
API ルート (`app/api/generate-pattern/route.ts`) からサーバーサイドで参照する運用を推奨します。

## 開発サーバー

```bash
npm run dev
```

`http://localhost:3000` を開きます。

## 機能

### 1. 基本の編みシステム

- **糸玉の選択**: 8 種類のプリセット糸（色 × 質感: 極細 / 中細 / 極太 / モヘア）から 1 つを選び、現在の編み糸として状態管理。
- **編むキャンバス**: クリックで V 字の編み目を 1 つ配置、ドラッグで連続編み。
  - 進行方向に対して編み目の縦軸を「ほぼ垂直」に置くため、編み地らしい流れが生まれます。
  - 描画順（`orderIndex`）で z-order が決まり、後から置いた編み目が上に重なる「編み物特有の重なり」を再現。
  - 質感ごとに線幅・ぼかし量・編み目の大きさが変化（モヘアはふわっとぼけ、極太は太く重い）。
- **「ほどく」ボタン**: 全ての編み目をリセット。

### 2. Gemini 2.5 Flash による「おまかせで編む」

- パレットに最大 6 色の糸を入れ、必要に応じてヒント（例: 「横縞のグラデーション」「市松」）を添えます。
- `POST /api/generate-pattern` が Gemini を呼び出し、`{ stitches: [{ x, y, yarnId, rotation }, ...] }` の形で
  抽象的な編み目の配列を取得します。
- フロントは取得した配列を順番に `KnittingCanvas.playPattern` に流し込み、編み目が 1 つずつアニメーションで増えていきます。

### API リファレンス

```ts
POST /api/generate-pattern

// Request
{
  "yarnIds": ["ivory", "terracotta", "moss"], // YARNS の id のいずれか（最大 6 推奨）
  "hint": "横縞のグラデーション",                 // 任意
  "targetCount": 140                            // 24 〜 240（任意）
}

// Response (success)
{
  "theme": "warm horizontal striped blanket",
  "model": "gemini-2.5-flash",
  "stitches": [
    { "x": 0.08, "y": 0.12, "yarnId": "ivory", "rotation": -0.05 },
    ...
  ]
}
```

`x`, `y` はキャンバスに対する 0〜1 の正規化座標です。
配列の順序がそのまま描画順（z-order）になります。

## ディレクトリ構成

```
hen-ai/
├── app/
│   ├── api/generate-pattern/route.ts   # Gemini 2.5 Flash 呼び出し
│   ├── globals.css                     # 布テクスチャ + クラフト配色
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── knitting-studio.tsx             # 統合: 糸選択・パレット・AI生成
│   ├── knitting-canvas.tsx             # Canvas 描画 + ドラッグでの連続編み
│   └── yarn-selector.tsx               # SVG の糸玉グリッド
├── lib/
│   ├── yarns.ts                        # 糸プリセット（色 × 質感）
│   ├── stitches.ts                     # V 字編み目の Canvas 描画ロジック
│   └── utils.ts
└── ...（next.config / tsconfig / eslint / tailwind 等）
```

## 実装メモ

- `KnittingCanvas` は内部状態（編み目配列・カウンタ）を `useRef` で保持し、
  ドラッグ中の高頻度な更新で React の再レンダリングを起こさない設計にしています。
  各編み目は配列に push した直後に `drawStitch` で増分描画されるため、
  シーン全体を毎フレーム再描画するコストもありません（リサイズ時のみ全描画）。
- ドラッグ中は `spacingForYarn` で算出した最小間隔ごとに編み目を補間スタンプし、
  進行方向から `rotation` を決めることで「編み目が編み地の流れに沿って並ぶ」表現を実現しています。
- Gemini 側は `responseSchema` で出力を強制し、サーバー側でも `sanitizeStitches` により
  座標範囲・許可糸 ID・最大 320 目の上限などをガードしています。

## ライセンス

MIT
