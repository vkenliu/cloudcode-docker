// ============================================================
// Types (matching Go backend structs / API.md)
// ============================================================

export type InstanceStatus =
  | "created"
  | "running"
  | "stopped"
  | "exited"
  | "error"
  | "removed";

export interface Instance {
  id: string;
  name: string;
  container_id: string;
  status: InstanceStatus;
  error_msg: string;
  work_dir: string;
  memory_mb: number;
  cpu_cores: number;
  /** Per-instance env vars. Values are always masked as "***" by the API. */
  env_vars: Record<string, string>;
  access_token: string;
  /** Disk usage in bytes. undefined = not fetched, -1 = unavailable. */
  disk_usage_bytes?: number;
  created_at: string;
  updated_at: string;
}

export interface ConfigFile {
  name: string;
  rel_path: string;
  hint: string;
  content: string | null; // null for auth.json (load on demand)
}

export interface DirFile {
  name: string;
  rel_path: string;
}

export interface AgentsSkill {
  skill_name: string;
  rel_path: string;
}

export interface EnvVar {
  key: string;
  value: string;
}

export interface Settings {
  config_dir: string;
  env_vars: EnvVar[];
  config_files: ConfigFile[];
  dirs: {
    commands: DirFile[];
    agents: DirFile[];
    skills: DirFile[];
    plugins: DirFile[];
  };
  agents_skills: AgentsSkill[];
  directory_mappings: { host: string; container: string }[];
  startup_script: string;
  cors_origins: string[];
  recycling_policy: RecyclingPolicy;
}

export interface RecyclingPolicy {
  enabled: boolean;
  max_stopped_count: number;
}

export interface SystemResources {
  total_memory_mb: number;
  total_cpu_cores: number;
}

export interface ApiError {
  error: string;
}

// ============================================================
// Base fetch helper
// ============================================================

// NEXT_PUBLIC_API_BASE: explicit backend URL for all browser requests.
// When set (e.g. "http://localhost:8080"), all API/WS/instance requests go
// directly to this URL. When empty, we derive it at runtime from the
// browser hostname + NEXT_PUBLIC_BACKEND_PORT (default 8080).
//
// In Docker mode the frontend (port 3000) and backend (port 8080) run on the
// same host. The browser talks directly to the backend — no Next.js proxying.
const EXPLICIT_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";
const BACKEND_PORT = process.env.NEXT_PUBLIC_BACKEND_PORT ?? "8080";

/**
 * Return the public backend URL usable by the browser.
 * All browser requests (API, WebSocket, instance proxy) go directly to the
 * Go backend. The frontend only serves the dashboard UI.
 */
function backendUrl(): string {
  if (EXPLICIT_BASE) return EXPLICIT_BASE;
  if (typeof window !== "undefined") {
    const port = window.location.port;
    // If the frontend is served from the backend port (same-origin), use "".
    if (port === BACKEND_PORT) return "";
    return `${window.location.protocol}//${window.location.hostname}:${BACKEND_PORT}`;
  }
  return "";
}

// Lazily cached backend URL (computed once on first use in the browser).
let _cachedBackendUrl: string | undefined;
function BASE(): string {
  if (_cachedBackendUrl === undefined) _cachedBackendUrl = backendUrl();
  return _cachedBackendUrl;
}

export function instanceProxyUrl(id: string): string {
  return `${BASE()}/instance/${id}/`;
}

/**
 * Build the URL used to open an instance's web UI in the browser.
 * Includes the per-instance access token as a ?token= query param so the
 * proxy can validate it and set the token cookie for subsequent requests.
 */
export function instanceOpenUrl(id: string, accessToken: string): string {
  const base = `${BASE()}/instance/${id}/`;
  if (!accessToken) return base;
  return `${base}?token=${encodeURIComponent(accessToken)}`;
}

export function wsBase(): string {
  // Explicit WS base takes priority (set in dev when Next.js can't proxy WS upgrades).
  const wsEnv = process.env.NEXT_PUBLIC_WS_BASE;
  if (wsEnv) return wsEnv;
  // Derive WS URL from the backend HTTP URL.
  const b = BASE();
  if (b) return b.replace(/^http/, "ws");
  // Same-origin fallback.
  if (typeof window !== "undefined") {
    return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
  }
  return "";
}

/**
 * Build an authenticated WebSocket URL.
 * When the WS base is cross-origin (dev mode), the browser won't send cookies
 * with the upgrade request. This fetches a one-time token from the backend
 * (via the same-origin proxy, so the session cookie is sent) and appends it
 * as ?token= so the Go server can authenticate the WS handshake.
 */
export async function buildWsUrl(path: string): Promise<string> {
  const base = wsBase();
  const url = `${base}${path}`;

  // Only need a token when WS goes to a different origin than the page.
  if (typeof window === "undefined") return url;
  try {
    const pageOrigin = window.location.origin; // e.g. http://localhost:4000
    const wsOrigin = new URL(url).origin.replace(/^ws/, "http"); // e.g. http://localhost:8080
    if (wsOrigin === pageOrigin) return url; // same-origin: cookie sent automatically
  } catch {
    return url;
  }

  // Cross-origin: fetch a one-time token via the session-authenticated proxy.
  // M15: don't silently swallow errors — throw so callers can redirect to /login.
  const { token } = await api.auth.wsToken();
  return `${url}?token=${encodeURIComponent(token)}`;
}

class ApiResponseError extends Error {
  constructor(
    public status: number,
    public body: ApiError
  ) {
    super(body.error);
  }
}

export { ApiResponseError };

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${BASE()}${path}`, {
    method,
    credentials: "include", // always send session cookie
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  // Global 401 handler: redirect to /login for browser sessions.
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login";
    return undefined as T;
  }

  const text = await res.text();

  if (!res.ok) {
    let errBody: ApiError = { error: `HTTP ${res.status}` };
    try {
      errBody = JSON.parse(text) as ApiError;
    } catch {
      // ignore parse error
    }
    throw new ApiResponseError(res.status, errBody);
  }

  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// ============================================================
// Instances API
// ============================================================

export const api = {
  // ============================================================
  // Auth
  // ============================================================
  auth: {
    login(token: string): Promise<{ status: string }> {
      return request("POST", "/api/auth/login", { token });
    },

    logout(): Promise<{ status: string }> {
      return request("POST", "/api/auth/logout");
    },

    /** Returns a single-use token for authenticating cross-origin WebSocket connections. */
    wsToken(): Promise<{ token: string }> {
      return request("GET", "/api/auth/ws-token");
    },
  },

  instances: {
    list(): Promise<Instance[]> {
      return request("GET", "/api/instances");
    },

    get(id: string): Promise<Instance> {
      return request("GET", `/api/instances/${id}`);
    },

    create(payload: {
      name: string;
      memory_mb?: number;
      cpu_cores?: number;
      /** Per-instance env vars. Keys must match [A-Za-z_][A-Za-z0-9_]*. Override global Settings vars. */
      env_vars?: Record<string, string>;
    }): Promise<Instance> {
      return request("POST", "/api/instances", payload);
    },

    delete(id: string): Promise<void> {
      return request("DELETE", `/api/instances/${id}`);
    },

    start(id: string): Promise<Instance> {
      return request("POST", `/api/instances/${id}/start`);
    },

    stop(id: string): Promise<Instance> {
      return request("POST", `/api/instances/${id}/stop`);
    },

    restart(id: string): Promise<Instance> {
      return request("POST", `/api/instances/${id}/restart`);
    },

    /** Replaces per-instance env vars. Returns the updated instance (values masked). Restart required to apply. */
    updateEnvVars(
      id: string,
      env_vars: Record<string, string>
    ): Promise<Instance> {
      return request("PATCH", `/api/instances/${id}/env-vars`, { env_vars });
    },

    /** Generates a new access token for the instance. Returns the new token. */
    regenerateToken(id: string): Promise<{ access_token: string }> {
      return request("POST", `/api/instances/${id}/regenerate-token`);
    },

    /** Returns a map of instanceID → disk usage bytes. Cached server-side (1-hour TTL). */
    diskUsage(): Promise<Record<string, number>> {
      return request("GET", "/api/instances/disk-usage");
    },

    /** Returns updated instance, null if unchanged (204), or {deleted:true} if removed */
    async pollStatus(
      id: string,
      currentStatus: string
    ): Promise<Instance | { deleted: true } | null> {
      const res = await fetch(
        `${BASE()}/api/instances/${id}/status?s=${encodeURIComponent(currentStatus)}`,
        { credentials: "include" }
      );
      if (res.status === 204) return null;
      const text = await res.text();
      if (!text) return { deleted: true };
      // #40: check res.ok before attempting to parse body as Instance
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const errBody = JSON.parse(text) as ApiError;
          if (errBody.error) errMsg = errBody.error;
        } catch {
          // ignore parse error
        }
        throw new ApiResponseError(res.status, { error: errMsg });
      }
      return JSON.parse(text) as Instance;
    },

    /**
     * Batch poll: send all known {id → currentStatus} in one request.
     * Returns a map of changed entries: Instance for updates, null for deleted.
     * IDs whose status has not changed are absent from the result.
     */
    async pollAllStatus(
      statuses: Record<string, string>
    ): Promise<Record<string, Instance | null>> {
      const data = await request<{ changed: Record<string, Instance | null> }>(
        "POST",
        "/api/status/instances",
        { ids: statuses }
      );
      return data?.changed ?? {};
    },
  },

  // ============================================================
  // System
  // ============================================================
  system: {
    resources(): Promise<SystemResources> {
      return request("GET", "/api/system/resources");
    },
  },

  // ============================================================
  // Settings API
  // ============================================================
  settings: {
    get(): Promise<Settings> {
      return request("GET", "/api/settings");
    },

    saveEnv(vars: EnvVar[]): Promise<void> {
      return request("PUT", "/api/settings/env", { vars });
    },

    readFile(relPath: string): Promise<{ rel_path: string; content: string }> {
      return request(
        "GET",
        `/api/settings/file?path=${encodeURIComponent(relPath)}`
      );
    },

    saveFile(path: string, content: string): Promise<void> {
      return request("PUT", "/api/settings/file", { path, content });
    },

    listDirFiles(
      dir: "commands" | "agents" | "skills" | "plugins"
    ): Promise<DirFile[]> {
      return request("GET", `/api/settings/dir-files?dir=${dir}`);
    },

    saveDirFile(payload: {
      dir: string;
      filename: string;
      content: string;
    }): Promise<void> {
      return request("PUT", "/api/settings/dir-file", payload);
    },

    deleteDirFile(relPath: string): Promise<void> {
      return request(
        "DELETE",
        `/api/settings/dir-file?path=${encodeURIComponent(relPath)}`
      );
    },

    deleteAgentsSkill(name: string): Promise<void> {
      return request(
        "DELETE",
        `/api/settings/agents-skill?name=${encodeURIComponent(name)}`
      );
    },

    saveStartupScript(script: string): Promise<void> {
      return request("PUT", "/api/settings/startup-script", { script });
    },

    saveCORSOrigins(origins: string[]): Promise<void> {
      return request("PUT", "/api/settings/cors", { origins });
    },

    saveRecyclingPolicy(policy: RecyclingPolicy): Promise<void> {
      return request("PUT", "/api/settings/recycling", policy);
    },
  },
};
