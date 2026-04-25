import { KnittingStudio } from "@/components/knitting-studio";

export default function Home() {
  return (
    <main className="relative isolate flex min-h-screen flex-col">
      <header className="mx-auto w-full max-w-6xl px-6 pt-8 sm:pt-12">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="craft-shadow inline-flex size-10 items-center justify-center rounded-full border border-border bg-card text-lg font-semibold text-primary"
            style={{ fontFamily: "var(--font-display)" }}
          >
            編
          </span>
          <div className="leading-tight">
            <p
              className="text-base font-semibold tracking-wide"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Knit Studio
            </p>
            <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
              Yarn × Gemini 3 Flash × Lyria 3 Clip
            </p>
          </div>
        </div>

        <div className="mt-6 max-w-2xl space-y-2">
          <h1
            className="text-balance text-3xl font-semibold leading-snug tracking-tight sm:text-4xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            糸を選んで、画面に編む。
          </h1>
          <p className="text-pretty text-sm leading-relaxed text-muted-foreground sm:text-[15px]">
            お好みの糸玉を選び、布の上を撫でるようにドラッグすると、
            V字の編み目が連なって積み重なっていきます。
            「お絵かきコピー」モードでは、Gemini 3 Flash が描いた線画を 30 秒でなぞる
            タイムアタックに挑戦。Lyria 3 Clip 製の BGM が緊張アークを奏で、
            半分なぞれると AI がお手本にディテールを描き足します。
          </p>
        </div>
      </header>

      <section className="mx-auto mt-8 w-full max-w-6xl flex-1 px-6 pb-12">
        <KnittingStudio />
      </section>

      <footer className="mx-auto w-full max-w-6xl px-6 pb-8 text-center text-[11px] text-muted-foreground">
        Powered by Google · models:{" "}
        <code className="rounded bg-card/70 px-1.5 py-0.5 text-[10px] text-foreground/80">
          gemini-3-flash-preview
        </code>{" "}
        +{" "}
        <code className="rounded bg-card/70 px-1.5 py-0.5 text-[10px] text-foreground/80">
          lyria-3-clip-preview
        </code>
      </footer>
    </main>
  );
}
