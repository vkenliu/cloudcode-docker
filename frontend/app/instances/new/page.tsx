"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, SystemResources, Instance, instanceOpenUrl } from "@/lib/api";

interface EnvEntry {
  key: string;
  value: string;
}

export default function NewInstancePage() {
  const router = useRouter();
  const [resources, setResources] = useState<SystemResources | null>(null);
  const [name, setName] = useState("");
  const [memoryMb, setMemoryMb] = useState(2048);
  const [cpuCores, setCpuCores] = useState(2);
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<Instance | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.system.resources().then(setResources).catch(() => null);
  }, []);

  // Env var editor helpers
  const addEnvRow = () =>
    setEnvEntries((prev) => [...prev, { key: "", value: "" }]);

  const removeEnvRow = (i: number) =>
    setEnvEntries((prev) => prev.filter((_, idx) => idx !== i));

  const updateEnvRow = (i: number, field: "key" | "value", val: string) =>
    setEnvEntries((prev) =>
      prev.map((entry, idx) => (idx === i ? { ...entry, [field]: val } : entry))
    );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (!Number.isFinite(memoryMb) || memoryMb < 0) {
      setError("Memory must be a non-negative number (0 = unlimited)");
      return;
    }
    if (!Number.isFinite(cpuCores) || cpuCores < 0) {
      setError("CPU cores must be a non-negative number (0 = unlimited)");
      return;
    }

    // Validate env var keys before sending
    const envKeyRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const { key } of envEntries) {
      if (key === "") continue; // skip blank rows
      if (!envKeyRe.test(key)) {
        setError(
          `Invalid env var key "${key}". Keys must start with a letter or underscore, followed by letters, digits, or underscores.`
        );
        return;
      }
    }

    // Build env_vars map (skip rows with blank keys)
    const env_vars: Record<string, string> = {};
    for (const { key, value } of envEntries) {
      if (key.trim()) env_vars[key.trim()] = value;
    }

    setBusy(true);
    setError("");
    try {
      const inst = await api.instances.create({
        name: name.trim(),
        memory_mb: memoryMb,
        cpu_cores: cpuCores,
        env_vars,
      });
      setCreated(inst);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const handleCopy = () => {
    if (!created) return;
    navigator.clipboard.writeText(created.access_token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Token reveal screen shown after creation
  if (created) {
    return (
      <div className="max-w-lg mx-auto">
        <h1 className="text-2xl font-bold text-white mb-2">
          Instance Created
        </h1>
        <p className="text-slate-400 text-sm mb-6">
          Save the access token below. It is shown once and can be retrieved
          later from the instance detail page (requires platform login).
        </p>

        <div className="bg-slate-800 border border-amber-600/40 rounded-xl p-6 mb-6">
          <p className="text-xs text-amber-400 uppercase tracking-wide font-semibold mb-3">
            Instance Access Token
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-slate-900 rounded-lg px-3 py-2 text-sm font-mono text-green-400 break-all select-all">
              {created.access_token}
            </code>
            <button
              onClick={handleCopy}
              className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs rounded-lg transition-colors whitespace-nowrap"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-3">
            Use this token to open the web UI or connect via SDK:
          </p>
          <code className="block text-xs text-slate-400 mt-1 break-all">
            opencode attach {instanceOpenUrl(created.id, created.access_token)}{" "}
            --password {created.access_token}
          </code>
        </div>

        <div className="flex gap-3">
          <a
            href={instanceOpenUrl(created.id, created.access_token)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 py-2 text-center bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg text-sm transition-colors"
          >
            Open Web UI ↗
          </a>
          <button
            onClick={() => router.push(`/instances/${created.id}`)}
            className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium rounded-lg text-sm transition-colors"
          >
            Go to Instance
          </button>
        </div>
      </div>
    );
  }

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

        {/* Environment Variables */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm font-medium text-slate-300">
              Environment Variables
            </label>
            <button
              type="button"
              onClick={addEnvRow}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              + Add variable
            </button>
          </div>
          <p className="text-xs text-slate-500 mb-2">
            Override global Settings env vars for this instance only. Applied on
            every start / restart.
          </p>

          {envEntries.length === 0 ? (
            <div className="text-xs text-slate-600 italic">
              No instance-specific variables — global Settings vars apply.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {envEntries.map((entry, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={entry.key}
                    onChange={(e) => updateEnvRow(i, "key", e.target.value)}
                    placeholder="VARIABLE_NAME"
                    className="w-2/5 bg-slate-900 border border-slate-600 rounded-lg px-2.5 py-1.5 text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs font-mono"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                  <input
                    type="password"
                    value={entry.value}
                    onChange={(e) => updateEnvRow(i, "value", e.target.value)}
                    placeholder="value"
                    className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-2.5 py-1.5 text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs font-mono"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                  <button
                    type="button"
                    onClick={() => removeEnvRow(i)}
                    className="text-slate-500 hover:text-red-400 transition-colors text-lg leading-none px-1"
                    aria-label="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
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
