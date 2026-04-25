export type YarnTexture = "fine" | "medium" | "bulky" | "fluffy";

export type Yarn = {
  id: string;
  name: string;
  /** 編み目の色（CSS color） */
  color: string;
  /** 質感のタイプ。Canvas で線の太さ・ぼかしの強さに反映する。 */
  texture: YarnTexture;
  /** カードや糸玉に表示する短い説明 */
  description: string;
};

export const TEXTURE_PROFILES: Record<
  YarnTexture,
  { label: string; lineWidth: number; blur: number; stitchSize: number }
> = {
  fine: { label: "極細", lineWidth: 3, blur: 0.4, stitchSize: 16 },
  medium: { label: "中細", lineWidth: 5, blur: 0.6, stitchSize: 22 },
  bulky: { label: "極太", lineWidth: 8, blur: 0.9, stitchSize: 30 },
  fluffy: { label: "モヘア", lineWidth: 6, blur: 2.4, stitchSize: 24 },
};

export const YARNS: Yarn[] = [
  {
    id: "ivory",
    name: "アイボリー",
    color: "#f3e6cf",
    texture: "medium",
    description: "生成りの羊毛",
  },
  {
    id: "terracotta",
    name: "テラコッタ",
    color: "#c8633b",
    texture: "bulky",
    description: "土の温度",
  },
  {
    id: "moss",
    name: "モスグリーン",
    color: "#5d7a3c",
    texture: "medium",
    description: "森の苔",
  },
  {
    id: "indigo",
    name: "インディゴ",
    color: "#274f7a",
    texture: "fine",
    description: "藍の水底",
  },
  {
    id: "rose",
    name: "ローズ",
    color: "#b6597a",
    texture: "fluffy",
    description: "夕暮れの花弁",
  },
  {
    id: "mustard",
    name: "マスタード",
    color: "#d39a2a",
    texture: "bulky",
    description: "陽だまりの黄",
  },
  {
    id: "charcoal",
    name: "チャコール",
    color: "#3a3733",
    texture: "fine",
    description: "炭の落ち着き",
  },
  {
    id: "sky",
    name: "スカイ",
    color: "#a7c8d8",
    texture: "fluffy",
    description: "霞んだ空",
  },
];

export const DEFAULT_YARN_ID = YARNS[0].id;

export function findYarn(id: string | undefined | null): Yarn {
  return YARNS.find((y) => y.id === id) ?? YARNS[0];
}
