import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "編 — Knit Studio",
  description:
    "デジタルの糸で「編む」体験をシミュレーションするインタラクティブUI。Gemini 2.5 Flash があなたの糸から編み模様を提案します。",
};

export const viewport: Viewport = {
  themeColor: "#e9d8b5",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <body className="bg-linen min-h-screen text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
