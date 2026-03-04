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
  port: number;
  work_dir: string;
  memory_mb: number;
  cpu_cores: number;
  created_at: string;
  updated_at: string;
}

export interface ConfigFile {
  name: string;
  rel_path: string;
  hint: string;
  content: string;
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

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

// WebSocket base derived from API base (http→ws, https→wss).
// Falls back to window.location.host when no explicit base is set (same-origin).
// Direct URL to Go's reverse-proxy route for a given instance.
// Must use the Go backend host directly (not Next.js) to preserve trailing slash.
export function instanceProxyUrl(id: string): string {
  return `${BASE || ""}/instance/${id}/`;
}

export function wsBase(): string {
  if (BASE) {
    return BASE.replace(/^http/, "ws");
  }
  if (typeof window !== "undefined") {
    return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
  }
  return "ws://localhost:9090";
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
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) {
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

    /** Returns updated instance, null if unchanged (204), or {deleted:true} if removed */
    async pollStatus(
      id: string,
      currentStatus: string
    ): Promise<Instance | { deleted: true } | null> {
      const res = await fetch(
        `${BASE}/api/instances/${id}/status?s=${encodeURIComponent(currentStatus)}`
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
  },
};
