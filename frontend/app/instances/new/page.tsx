"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, SystemResources } from "@/lib/api";

export default function NewInstancePage() {
  const router = useRouter();
  const [resources, setResources] = useState<SystemResources | null>(null);
  const [name, setName] = useState("");
  const [memoryMb, setMemoryMb] = useState(2048);
  const [cpuCores, setCpuCores] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.system.resources().then(setResources).catch(() => null);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const inst = await api.instances.create({
        name: name.trim(),
        memory_mb: memoryMb,
        cpu_cores: cpuCores,
      });
      router.push(`/instances/${inst.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto">
      {/* Breadcrumb */}
      <div className="text-sm text-slate-400 mb-6">
        <Link href="/" className="hover:text-white">
          Instances
        </Link>{" "}
        / New
      </div>

      <h1 className="text-2xl font-bold text-white mb-6">New Instance</h1>

      <form
        onSubmit={handleSubmit}
        className="bg-slate-800 border border-slate-700 rounded-xl p-6 flex flex-col gap-5"
      >
        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-project"
            pattern="[a-zA-Z0-9_-]+"
            required
            className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          />
          <p className="text-xs text-slate-500 mt-1">
            Letters, numbers, hyphens and underscores only
          </p>
        </div>

        {/* Memory */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">
            Memory (MB)
            {resources && (
              <span className="text-slate-500 font-normal ml-2">
                host total: {resources.total_memory_mb} MB
              </span>
            )}
          </label>
          <input
            type="number"
            value={memoryMb}
            onChange={(e) => setMemoryMb(Number(e.target.value))}
            min={0}
            step={512}
            className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          />
          <p className="text-xs text-slate-500 mt-1">0 = unlimited</p>
        </div>

        {/* CPU */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">
            CPU Cores
            {resources && (
              <span className="text-slate-500 font-normal ml-2">
                host total: {resources.total_cpu_cores} cores
              </span>
            )}
          </label>
          <input
            type="number"
            value={cpuCores}
            onChange={(e) => setCpuCores(Number(e.target.value))}
            min={0}
            step={0.5}
            className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          />
          <p className="text-xs text-slate-500 mt-1">0 = unlimited</p>
        </div>

        {error && (
          <div className="text-red-400 bg-red-950/50 rounded-lg px-4 py-2.5 text-sm">
            {error}
          </div>
        )}

        {busy && (
          <div className="text-slate-400 text-sm text-center">
            Creating container… this may take a moment.
          </div>
        )}

        <div className="flex gap-3 pt-1">
          <button
            type="submit"
            disabled={busy}
            className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg text-sm transition-colors"
          >
            {busy ? "Creating…" : "Create Instance"}
          </button>
          <Link
            href="/"
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium rounded-lg text-sm transition-colors"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
