"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, RecyclingPolicy } from "@/lib/api";

// ============================================================
// Setup Wizard — first-time configuration
// ============================================================

type Step = "tokens" | "ai-keys" | "platform";

const STEPS: { key: Step; label: string }[] = [
  { key: "tokens", label: "Tokens" },
  { key: "ai-keys", label: "AI Model Keys" },
  { key: "platform", label: "Platform" },
];

export default function SetupPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [step, setStep] = useState<Step>("tokens");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // --- Form state ---
  const [githubToken, setGithubToken] = useState("");
  const [aditAuthToken, setAditAuthToken] = useState("");

  // AI model keys
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [geminiKey, setGeminiKey] = useState("");

  // Anthropic OAuth connect
  const [oauthUrl, setOauthUrl] = useState("");
  const [oauthFlowId, setOauthFlowId] = useState("");
  const [oauthCode, setOauthCode] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthConnected, setOauthConnected] = useState(false);
  const [oauthError, setOauthError] = useState("");

  // Platform settings
  const [corsOrigins, setCorsOrigins] = useState("");
  const [recyclingEnabled, setRecyclingEnabled] = useState(true);
  const [maxStopped, setMaxStopped] = useState(5);

  // Check if setup is already done — redirect to dashboard
  useEffect(() => {
    api.system
      .setupStatus()
      .then((s) => {
        if (s.setup_complete) {
          router.replace("/");
        } else {
          setChecking(false);
        }
      })
      .catch(() => setChecking(false));
  }, [router]);

  const stepIdx = STEPS.findIndex((s) => s.key === step);

  const goNext = () => {
    const next = STEPS[stepIdx + 1];
    if (next) setStep(next.key);
  };

  const goPrev = () => {
    const prev = STEPS[stepIdx - 1];
    if (prev) setStep(prev.key);
  };

  const finish = async () => {
    setSaving(true);
    setError("");
    try {
      // Build env vars — only tokens, NOT API keys (those go to auth.json)
      const envVars: Record<string, string> = {};
      if (githubToken.trim()) {
        envVars["GITHUB_TOKEN"] = githubToken.trim();
      }
      if (aditAuthToken.trim()) {
        envVars["ADIT_AUTH_TOKEN"] = aditAuthToken.trim();
      }

      // Build CORS origins
      const origins = corsOrigins
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);

      // Build recycling policy
      const recyclingPolicy: RecyclingPolicy = {
        enabled: recyclingEnabled,
        max_stopped_count: maxStopped,
      };

      // Build auth.json for AI providers (opencode format)
      const authJson: Record<string, unknown> = {};
      if (anthropicKey.trim()) {
        authJson["anthropic"] = { type: "api", key: anthropicKey.trim() };
      }
      if (openaiKey.trim()) {
        authJson["openai"] = { type: "api", key: openaiKey.trim() };
      }
      if (geminiKey.trim()) {
        authJson["google"] = { type: "api", key: geminiKey.trim() };
      }

      await api.system.setup({
        cors_origins: origins.length > 0 ? origins : undefined,
        recycling_policy: recyclingPolicy,
        env_vars: Object.keys(envVars).length > 0 ? envVars : undefined,
        auth_json:
          Object.keys(authJson).length > 0 ? authJson : undefined,
      });

      router.push("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (checking) {
    return (
      <div className="text-slate-400 text-center py-16">
        Checking setup status...
      </div>
    );
  }

  const inputClass =
    "w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-600 text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-mono";

  return (
    <div className="max-w-2xl mx-auto py-8">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold text-blue-400 tracking-tight">
          CloudCode Setup
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          Configure your platform for first-time use. All fields are optional
          and can be changed later in Settings.
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex justify-center gap-2 mb-8">
        {STEPS.map((s, i) => (
          <button
            key={s.key}
            onClick={() => setStep(s.key)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              step === s.key
                ? "bg-blue-600 text-white"
                : i < stepIdx
                  ? "bg-slate-700 text-blue-300"
                  : "bg-slate-800 text-slate-400"
            }`}
          >
            <span className="w-5 h-5 rounded-full border border-current text-xs flex items-center justify-center">
              {i + 1}
            </span>
            {s.label}
          </button>
        ))}
      </div>

      {/* Card */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-8 shadow-2xl">
        {/* ---- Step 1: Tokens ---- */}
        {step === "tokens" && (
          <div className="flex flex-col gap-6">
            <div>
              <h2 className="text-lg font-semibold text-white mb-1">
                Service Tokens
              </h2>
              <p className="text-sm text-slate-400">
                These tokens are injected as environment variables into every
                instance.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-slate-300">
                GitHub Token
              </label>
              <p className="text-xs text-slate-500">
                Used for GitHub CLI authentication (gh), Git operations, and
                GitHub Copilot. Set as both GITHUB_TOKEN and GH_TOKEN.
              </p>
              <input
                type="password"
                placeholder="ghp_xxxxxxxxxxxx"
                value={githubToken}
                onChange={(e) => setGithubToken(e.target.value)}
                className={inputClass}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-slate-300">
                ADIT Auth Token
              </label>
              <p className="text-xs text-slate-500">
                Authentication token for adit-core agent framework.
              </p>
              <input
                type="password"
                placeholder="adit_xxxxxxxxxxxx"
                value={aditAuthToken}
                onChange={(e) => setAditAuthToken(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>
        )}

        {/* ---- Step 2: AI Model Keys ---- */}
        {step === "ai-keys" && (
          <div className="flex flex-col gap-6">
            <div>
              <h2 className="text-lg font-semibold text-white mb-1">
                AI Model Keys
              </h2>
              <p className="text-sm text-slate-400">
                Connect your Anthropic account via OAuth, or enter API keys
                manually. Keys are saved to auth.json (shared across all
                instances).
              </p>
            </div>

            {/* Anthropic OAuth Connect */}
            <div className="flex flex-col gap-3 p-4 bg-slate-900/60 border border-slate-700 rounded-lg">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium text-slate-300">
                    Anthropic (Claude)
                  </label>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Connect your Claude Pro or Max subscription, or enter an
                    API key manually.
                  </p>
                </div>
                {oauthConnected && (
                  <span className="text-xs font-medium text-green-400 bg-green-950/50 border border-green-800 px-2 py-1 rounded">
                    Connected
                  </span>
                )}
              </div>

              {/* OAuth flow states */}
              {!oauthUrl && !oauthConnected && (
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      setOauthBusy(true);
                      setOauthError("");
                      try {
                        const res =
                          await api.system.anthropicAuthorize("max");
                        setOauthUrl(res.url);
                        setOauthFlowId(res.flow_id);
                      } catch (e) {
                        setOauthError(
                          e instanceof Error ? e.message : String(e)
                        );
                      } finally {
                        setOauthBusy(false);
                      }
                    }}
                    disabled={oauthBusy}
                    className="px-3 py-1.5 text-sm font-medium bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-lg transition-colors"
                  >
                    {oauthBusy
                      ? "Starting..."
                      : "Connect Claude Pro/Max"}
                  </button>
                  <button
                    onClick={async () => {
                      setOauthBusy(true);
                      setOauthError("");
                      try {
                        const res =
                          await api.system.anthropicAuthorize("console");
                        setOauthUrl(res.url);
                        setOauthFlowId(res.flow_id);
                      } catch (e) {
                        setOauthError(
                          e instanceof Error ? e.message : String(e)
                        );
                      } finally {
                        setOauthBusy(false);
                      }
                    }}
                    disabled={oauthBusy}
                    className="px-3 py-1.5 text-sm font-medium bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white rounded-lg transition-colors"
                  >
                    Connect via Console
                  </button>
                </div>
              )}

              {oauthUrl && !oauthConnected && (
                <div className="flex flex-col gap-3">
                  <div className="text-sm text-slate-300">
                    <span className="font-medium">Step 1:</span> Open this
                    link and authorize:
                  </div>
                  <a
                    href={oauthUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-400 hover:text-blue-300 underline break-all"
                  >
                    {oauthUrl.length > 80
                      ? oauthUrl.slice(0, 80) + "..."
                      : oauthUrl}
                  </a>
                  <div className="text-sm text-slate-300">
                    <span className="font-medium">Step 2:</span> Paste the
                    authorization code below:
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Paste authorization code here"
                      value={oauthCode}
                      onChange={(e) => setOauthCode(e.target.value)}
                      className={inputClass + " flex-1"}
                    />
                    <button
                      onClick={async () => {
                        if (!oauthCode.trim()) return;
                        setOauthBusy(true);
                        setOauthError("");
                        try {
                          await api.system.anthropicCallback(
                            oauthFlowId,
                            oauthCode.trim()
                          );
                          setOauthConnected(true);
                          setOauthUrl("");
                          setOauthCode("");
                        } catch (e) {
                          setOauthError(
                            e instanceof Error ? e.message : String(e)
                          );
                        } finally {
                          setOauthBusy(false);
                        }
                      }}
                      disabled={oauthBusy || !oauthCode.trim()}
                      className="px-4 py-2 text-sm font-medium bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white rounded-lg transition-colors whitespace-nowrap"
                    >
                      {oauthBusy ? "Connecting..." : "Connect"}
                    </button>
                  </div>
                  <button
                    onClick={() => {
                      setOauthUrl("");
                      setOauthFlowId("");
                      setOauthCode("");
                      setOauthError("");
                    }}
                    className="text-xs text-slate-500 hover:text-slate-400 self-start"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {oauthConnected && (
                <p className="text-xs text-slate-500">
                  OAuth tokens have been saved. You can reconnect anytime from
                  Settings.
                </p>
              )}

              {oauthError && (
                <div className="text-sm text-red-400 bg-red-950/40 border border-red-800 rounded-lg px-3 py-2">
                  {oauthError}
                </div>
              )}

              {/* Manual API key fallback */}
              {!oauthConnected && (
                <div className="border-t border-slate-700 pt-3 mt-1">
                  <p className="text-xs text-slate-500 mb-2">
                    Or enter an API key manually:
                  </p>
                  <input
                    type="password"
                    placeholder="sk-ant-xxxxxxxxxxxx"
                    value={anthropicKey}
                    onChange={(e) => setAnthropicKey(e.target.value)}
                    className={inputClass}
                  />
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-slate-300">
                OpenAI API Key
              </label>
              <p className="text-xs text-slate-500">
                For GPT-4, GPT-4o, o1, o3 models
              </p>
              <input
                type="password"
                placeholder="sk-xxxxxxxxxxxx"
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
                className={inputClass}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-slate-300">
                Google Gemini API Key
              </label>
              <p className="text-xs text-slate-500">
                For Gemini 2.5, Gemini 2.5 Flash, Gemini 2.0 Flash models
              </p>
              <input
                type="password"
                placeholder="AIzaSy..."
                value={geminiKey}
                onChange={(e) => setGeminiKey(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>
        )}

        {/* ---- Step 3: Platform ---- */}
        {step === "platform" && (
          <div className="flex flex-col gap-6">
            <div>
              <h2 className="text-lg font-semibold text-white mb-1">
                Platform Settings
              </h2>
              <p className="text-sm text-slate-400">
                CORS origins and instance recycling policy.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-slate-300">
                CORS Origins
              </label>
              <p className="text-xs text-slate-500">
                Allowed origins for cross-origin API requests (one per line).
                The installer auto-detects server IPs. Add custom origins here
                if needed (e.g., a custom domain).
              </p>
              <textarea
                placeholder={"https://cloudcode.example.com"}
                value={corsOrigins}
                onChange={(e) => setCorsOrigins(e.target.value)}
                rows={3}
                className={inputClass + " resize-y"}
                spellCheck={false}
              />
            </div>

            <div className="flex flex-col gap-3">
              <label className="text-sm font-medium text-slate-300">
                Instance Recycling
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={recyclingEnabled}
                  onChange={(e) => setRecyclingEnabled(e.target.checked)}
                  className="rounded bg-slate-900 border-slate-600 text-blue-600 focus:ring-blue-500"
                />
                Auto-remove oldest stopped instances
              </label>
              {recyclingEnabled && (
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  Keep up to
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={maxStopped}
                    onChange={(e) =>
                      setMaxStopped(Math.max(0, parseInt(e.target.value) || 0))
                    }
                    className="w-16 bg-slate-900 text-white px-2 py-1 rounded text-sm font-mono border border-slate-600 focus:border-blue-500 focus:outline-none"
                  />
                  stopped instances
                </div>
              )}
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mt-4 text-sm text-red-400 bg-red-950/40 border border-red-800 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {/* Navigation buttons */}
        <div className="flex justify-between mt-8">
          <button
            onClick={goPrev}
            disabled={stepIdx === 0}
            className="px-4 py-2 text-sm font-medium bg-slate-700 hover:bg-slate-600 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
          >
            Back
          </button>
          <div className="flex gap-3">
            {stepIdx < STEPS.length - 1 && (
              <button
                onClick={() => {
                  router.push("/");
                }}
                className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-white transition-colors"
              >
                Skip Setup
              </button>
            )}
            {stepIdx < STEPS.length - 1 ? (
              <button
                onClick={goNext}
                className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
              >
                Next
              </button>
            ) : (
              <button
                onClick={finish}
                disabled={saving}
                className="px-5 py-2 text-sm font-medium bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {saving ? "Saving..." : "Complete Setup"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
