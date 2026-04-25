"use client";

import { motion } from "framer-motion";

import { TEXTURE_PROFILES, YARNS, type Yarn } from "@/lib/yarns";
import { cn } from "@/lib/utils";

type Props = {
  selectedId: string;
  onSelect: (yarn: Yarn) => void;
};

export function YarnSelector({ selectedId, onSelect }: Props) {
  return (
    <div className="craft-shadow rounded-2xl border border-border bg-card/80 p-4 backdrop-blur">
      <div className="mb-3 flex items-baseline justify-between">
        <h2
          className="text-sm font-semibold tracking-wide"
          style={{ fontFamily: "var(--font-display)" }}
        >
          糸玉を選ぶ
        </h2>
        <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {YARNS.length} colors
        </span>
      </div>
      <ul
        className="grid grid-cols-4 gap-3 sm:grid-cols-8"
        role="radiogroup"
        aria-label="糸の選択"
      >
        {YARNS.map((yarn) => {
          const selected = yarn.id === selectedId;
          const profile = TEXTURE_PROFILES[yarn.texture];
          return (
            <li key={yarn.id}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onSelect(yarn)}
                className={cn(
                  "group flex w-full flex-col items-center gap-1.5 rounded-xl px-1 py-2 text-center transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "bg-background-2/60"
                    : "hover:bg-background-2/40",
                )}
                title={`${yarn.name} · ${profile.label}`}
              >
                <YarnBall yarn={yarn} selected={selected} />
                <span
                  className={cn(
                    "block text-[11px] leading-tight",
                    selected ? "font-semibold text-foreground" : "text-muted-foreground",
                  )}
                >
                  {yarn.name}
                </span>
                <span className="block text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                  {profile.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 糸玉ビジュアル: SVG で巻きつけた糸を表現する。
 * fluffy 質感のときは少しぼかしてモヘア感を出す。
 */
function YarnBall({ yarn, selected }: { yarn: Yarn; selected: boolean }) {
  const profile = TEXTURE_PROFILES[yarn.texture];
  const blur = profile.blur > 1 ? 1.4 : 0;
  const lineWidth = Math.max(1.4, profile.lineWidth * 0.45);

  return (
    <motion.div
      animate={{
        scale: selected ? 1.08 : 1,
        y: selected ? -2 : 0,
      }}
      transition={{ type: "spring", stiffness: 320, damping: 22 }}
      className="relative grid size-12 place-items-center"
    >
      <motion.div
        aria-hidden
        className="absolute inset-0 rounded-full"
        animate={{
          boxShadow: selected
            ? "0 6px 18px -8px rgba(0,0,0,.35), 0 0 0 2px rgba(255,255,255,.6) inset, 0 0 0 4px var(--ring)"
            : "0 4px 10px -6px rgba(0,0,0,.25), 0 0 0 1px rgba(255,255,255,.4) inset",
        }}
      />
      <svg viewBox="0 0 48 48" width={48} height={48} className="relative">
        <defs>
          <radialGradient id={`grad-${yarn.id}`} cx="35%" cy="30%" r="80%">
            <stop offset="0%" stopColor="rgba(255,255,255,.6)" />
            <stop offset="40%" stopColor={yarn.color} />
            <stop offset="100%" stopColor="rgba(0,0,0,.35)" />
          </radialGradient>
          {blur > 0 && (
            <filter id={`fluff-${yarn.id}`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation={blur} />
            </filter>
          )}
        </defs>

        <circle cx="24" cy="24" r="20" fill={`url(#grad-${yarn.id})`} />

        <g
          fill="none"
          stroke={yarn.color}
          strokeOpacity="0.85"
          strokeLinecap="round"
          strokeWidth={lineWidth}
          filter={blur > 0 ? `url(#fluff-${yarn.id})` : undefined}
        >
          {/* 巻き線（楕円を回転して重ねる） */}
          <ellipse cx="24" cy="24" rx="18" ry="6" transform="rotate(20 24 24)" />
          <ellipse cx="24" cy="24" rx="18" ry="6" transform="rotate(-15 24 24)" />
          <ellipse cx="24" cy="24" rx="18" ry="6" transform="rotate(55 24 24)" />
          <ellipse cx="24" cy="24" rx="18" ry="6" transform="rotate(-50 24 24)" />
        </g>

        {/* 糸端（ふわっと垂れる線） */}
        <path
          d="M40 26 C 44 30, 42 36, 46 38"
          stroke={yarn.color}
          strokeWidth={lineWidth * 0.8}
          fill="none"
          strokeLinecap="round"
          opacity={0.85}
        />
      </svg>
    </motion.div>
  );
}
