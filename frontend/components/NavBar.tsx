"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function NavBar() {
  const pathname = usePathname();
  const router = useRouter();

  // Don't render the nav on the login page.
  if (pathname === "/login") return null;

  async function handleLogout() {
    try {
      await api.auth.logout();
    } catch {
      // ignore errors — cookie will be cleared on redirect regardless
    }
    router.push("/login");
  }

  return (
    <header className="border-b border-slate-700 bg-slate-900 px-6 py-3 flex items-center gap-6">
      <Link
        href="/"
        className="text-blue-400 font-bold text-lg tracking-tight hover:text-blue-300"
      >
        CloudCode
      </Link>
      <nav className="flex gap-4 text-sm flex-1">
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
      <button
        onClick={handleLogout}
        className="text-sm text-slate-400 hover:text-slate-200 transition-colors ml-auto"
      >
        Sign out
      </button>
    </header>
  );
}
