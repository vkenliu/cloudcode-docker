import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";

export const metadata: Metadata = {
  title: "CloudCode",
  description: "Claude Code instance manager",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col">
        {/* Top nav */}
        <header className="border-b border-slate-700 bg-slate-900 px-6 py-3 flex items-center gap-6">
          <Link
            href="/"
            className="text-blue-400 font-bold text-lg tracking-tight hover:text-blue-300"
          >
            CloudCode
          </Link>
          <nav className="flex gap-4 text-sm">
            <Link
              href="/"
              className="text-slate-300 hover:text-white transition-colors"
            >
              Instances
            </Link>
            <Link
              href="/settings"
              className="text-slate-300 hover:text-white transition-colors"
            >
              Settings
            </Link>
          </nav>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </body>
    </html>
  );
}
