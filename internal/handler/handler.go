package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/naiba/cloudcode/internal/config"
	"github.com/naiba/cloudcode/internal/docker"
	"github.com/naiba/cloudcode/internal/proxy"
	"github.com/naiba/cloudcode/internal/store"
)

type Handler struct {
	store    *store.Store
	docker   *docker.Manager
	proxy    *proxy.ReverseProxy
	config   *config.Manager
	portPool *PortPool
}

// PortPool allocates ports for new instances.
type PortPool struct {
	mu    sync.Mutex
	start int
	end   int
	used  map[int]bool
}

func NewPortPool(start, end int) *PortPool {
	return &PortPool{start: start, end: end, used: make(map[int]bool)}
}

func (pp *PortPool) Allocate() (int, error) {
	pp.mu.Lock()
	defer pp.mu.Unlock()
	for p := pp.start; p <= pp.end; p++ {
		if !pp.used[p] {
			pp.used[p] = true
			return p, nil
		}
	}
	return 0, fmt.Errorf("no available ports in range %d-%d", pp.start, pp.end)
}

func (pp *PortPool) Release(port int) {
	pp.mu.Lock()
	defer pp.mu.Unlock()
	delete(pp.used, port)
}

func (pp *PortPool) MarkUsed(port int) {
	pp.mu.Lock()
	defer pp.mu.Unlock()
	pp.used[port] = true
}

func New(s *store.Store, dm *docker.Manager, rp *proxy.ReverseProxy, cfgMgr *config.Manager) *Handler {
	h := &Handler{
		store:    s,
		docker:   dm,
		proxy:    rp,
		config:   cfgMgr,
		portPool: NewPortPool(10000, 10100),
	}

	instances, err := s.List()
	if err == nil {
		for _, inst := range instances {
			if inst.Port > 0 {
				h.portPool.MarkUsed(inst.Port)
			}
			if inst.Status == "running" && inst.Port > 0 {
				_ = rp.Register(inst.ID, inst.Port)
			}
		}
	}

	return h
}

// RegisterRoutes sets up all HTTP routes.
func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	// --- Instances API ---
	mux.HandleFunc("GET /api/instances", h.apiListInstances)
	mux.HandleFunc("POST /api/instances", h.apiCreateInstance)
	mux.HandleFunc("GET /api/instances/{id}", h.apiGetInstance)
	mux.HandleFunc("DELETE /api/instances/{id}", h.apiDeleteInstance)
	mux.HandleFunc("POST /api/instances/{id}/start", h.apiStartInstance)
	mux.HandleFunc("POST /api/instances/{id}/stop", h.apiStopInstance)
	mux.HandleFunc("POST /api/instances/{id}/restart", h.apiRestartInstance)
	mux.HandleFunc("GET /api/instances/{id}/status", h.apiInstanceStatus)

	// --- System API ---
	mux.HandleFunc("GET /api/system/resources", h.apiSystemResources)

	// --- Settings API ---
	mux.HandleFunc("GET /api/settings", h.apiGetSettings)
	mux.HandleFunc("PUT /api/settings/env", h.apiSaveEnvVars)
	mux.HandleFunc("GET /api/settings/file", h.apiGetConfigFile)
	mux.HandleFunc("PUT /api/settings/file", h.apiSaveConfigFile)
	mux.HandleFunc("GET /api/settings/dir-files", h.apiListDirFiles)
	mux.HandleFunc("PUT /api/settings/dir-file", h.apiSaveDirFile)
	mux.HandleFunc("DELETE /api/settings/dir-file", h.apiDeleteDirFile)
	mux.HandleFunc("DELETE /api/settings/agents-skill", h.apiDeleteAgentsSkill)

	// --- WebSocket endpoints (unchanged) ---
	mux.HandleFunc("GET /instances/{id}/logs/ws", h.handleLogsWS)
	mux.HandleFunc("GET /instances/{id}/terminal/ws", h.handleTerminalWS)

	// --- Reverse proxy to OpenCode web UI ---
	mux.HandleFunc("/instance/{id}/", h.handleProxy)

	// --- Catch-all: SPA asset fallback (must be last) ---
	mux.HandleFunc("/", h.handleCatchAll)
}

// --- Helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeNoContent(w http.ResponseWriter) {
	w.WriteHeader(http.StatusNoContent)
}

// --- Instance API handlers ---

func (h *Handler) apiListInstances(w http.ResponseWriter, r *http.Request) {
	instances, err := h.store.List()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list instances")
		return
	}
	// Sync Docker status for each instance in parallel (#15)
	if h.docker != nil {
		var wg sync.WaitGroup
		for _, inst := range instances {
			if inst.ContainerID == "" {
				continue
			}
			wg.Add(1)
			go func(inst *store.Instance) {
				defer wg.Done()
				if status, err := h.docker.ContainerStatus(r.Context(), inst.ContainerID); err == nil && status != inst.Status {
					inst.Status = status
					if err := h.store.Update(inst); err != nil {
						log.Printf("Warning: failed to update instance %s status: %v", inst.ID, err)
					}
				}
			}(inst)
		}
		wg.Wait()
	}
	if instances == nil {
		instances = []*store.Instance{}
	}
	writeJSON(w, http.StatusOK, instances)
}

func (h *Handler) apiGetInstance(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst, err := h.store.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "instance not found")
		return
	}
	if inst.ContainerID != "" && h.docker != nil {
		if status, err := h.docker.ContainerStatus(r.Context(), inst.ContainerID); err == nil {
			inst.Status = status
			_ = h.store.Update(inst)
		}
	}
	writeJSON(w, http.StatusOK, inst)
}

func (h *Handler) apiCreateInstance(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MB limit (#17)
	var req struct {
		Name     string  `json:"name"`
		MemoryMB int     `json:"memory_mb"`
		CPUCores float64 `json:"cpu_cores"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}

	if existing, _ := h.store.GetByName(req.Name); existing != nil {
		writeError(w, http.StatusConflict, "instance name already exists")
		return
	}

	port, err := h.portPool.Allocate()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "no available ports")
		return
	}

	inst := &store.Instance{
		Name:     req.Name,
		Status:   "created",
		Port:     port,
		WorkDir:  "/root",
		EnvVars:  make(map[string]string),
		MemoryMB: req.MemoryMB,
		CPUCores: req.CPUCores,
	}

	// #13: retry on ID collision (astronomically rare but correct to handle)
	var createErr error
	for attempt := 0; attempt < 5; attempt++ {
		inst.ID = uuid.New().String()[:8]
		if createErr = h.store.Create(inst); createErr == nil {
			break
		}
		if !strings.Contains(createErr.Error(), "UNIQUE constraint") {
			break
		}
	}
	if createErr != nil {
		h.portPool.Release(port)
		writeError(w, http.StatusInternalServerError, "failed to create instance")
		return
	}

	if h.docker != nil {
		containerID, err := h.docker.CreateContainer(r.Context(), inst) // #7 use r.Context()
		if err != nil {
			log.Printf("Error creating container for %s: %v", inst.ID, err)
			// #6: release port so it can be reused since container creation failed
			h.portPool.Release(inst.Port)
			inst.Status = "error"
			inst.ErrorMsg = err.Error()
			if updateErr := h.store.Update(inst); updateErr != nil {
				log.Printf("Warning: failed to update instance %s: %v", inst.ID, updateErr)
			}
		} else {
			inst.ContainerID = containerID
			inst.Status = "running"
			if updateErr := h.store.Update(inst); updateErr != nil {
				log.Printf("Warning: failed to update instance %s: %v", inst.ID, updateErr)
			}
			if err := h.proxy.Register(inst.ID, inst.Port); err != nil {
				log.Printf("Error registering proxy for %s: %v", inst.ID, err)
			}
		}
	}

	writeJSON(w, http.StatusCreated, inst)
}

func (h *Handler) apiDeleteInstance(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst, err := h.store.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "instance not found")
		return
	}

	if inst.ContainerID != "" && h.docker != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := h.docker.RemoveContainerAndVolume(ctx, inst.ContainerID, id); err != nil {
			log.Printf("Error removing container for %s: %v", id, err)
		}
	}

	h.proxy.Unregister(id)
	h.portPool.Release(inst.Port)
	h.config.RemoveInstanceData(id)

	if err := h.store.Delete(id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete instance")
		return
	}

	writeNoContent(w)
}

func (h *Handler) apiStartInstance(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst, err := h.store.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "instance not found")
		return
	}

	if h.docker == nil {
		writeError(w, http.StatusInternalServerError, "docker is not available")
		return
	}

	if inst.ContainerID == "" {
		containerID, err := h.docker.CreateContainer(r.Context(), inst) // #7
		if err != nil {
			inst.Status = "error"
			inst.ErrorMsg = err.Error()
			_ = h.store.Update(inst)
			writeError(w, http.StatusInternalServerError, "failed to create container: "+err.Error())
			return
		}
		inst.ContainerID = containerID
	} else {
		if err := h.docker.StartContainer(r.Context(), inst.ContainerID); err != nil { // #7
			inst.Status = "error"
			inst.ErrorMsg = err.Error()
			_ = h.store.Update(inst)
			writeError(w, http.StatusInternalServerError, "failed to start container: "+err.Error())
			return
		}
	}

	inst.Status = "running"
	inst.ErrorMsg = ""
	if err := h.store.Update(inst); err != nil { // #9
		log.Printf("Warning: failed to update instance %s: %v", inst.ID, err)
	}
	if err := h.proxy.Register(inst.ID, inst.Port); err != nil { // #9
		log.Printf("Warning: failed to register proxy for %s: %v", inst.ID, err)
	}

	writeJSON(w, http.StatusOK, inst)
}

func (h *Handler) apiStopInstance(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst, err := h.store.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "instance not found")
		return
	}

	if inst.ContainerID != "" && h.docker != nil {
		if err := h.docker.StopContainer(r.Context(), inst.ContainerID); err != nil { // #7
			writeError(w, http.StatusInternalServerError, "failed to stop container: "+err.Error())
			return
		}
	}

	inst.Status = "stopped"
	if err := h.store.Update(inst); err != nil { // #9
		log.Printf("Warning: failed to update instance %s: %v", inst.ID, err)
	}
	h.proxy.Unregister(id)

	writeJSON(w, http.StatusOK, inst)
}

func (h *Handler) apiRestartInstance(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst, err := h.store.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "instance not found")
		return
	}

	if h.docker == nil {
		writeError(w, http.StatusInternalServerError, "docker is not available")
		return
	}

	if inst.ContainerID != "" {
		// #24: log stop/remove errors instead of silently ignoring
		if err := h.docker.StopContainer(r.Context(), inst.ContainerID); err != nil { // #7
			log.Printf("Warning: failed to stop container %s during restart: %v", inst.ContainerID, err)
		}
		if err := h.docker.RemoveContainer(r.Context(), inst.ContainerID); err != nil { // #7, #24
			log.Printf("Warning: failed to remove container %s during restart: %v", inst.ContainerID, err)
		}
	}

	containerID, err := h.docker.CreateContainer(r.Context(), inst) // #7
	if err != nil {
		inst.Status = "error"
		inst.ErrorMsg = err.Error()
		if updateErr := h.store.Update(inst); updateErr != nil { // #9
			log.Printf("Warning: failed to update instance %s: %v", inst.ID, updateErr)
		}
		writeError(w, http.StatusInternalServerError, "failed to restart container: "+err.Error())
		return
	}

	inst.ContainerID = containerID
	inst.Status = "running"
	if err := h.store.Update(inst); err != nil { // #9
		log.Printf("Warning: failed to update instance %s: %v", inst.ID, err)
	}
	if err := h.proxy.Register(inst.ID, inst.Port); err != nil { // #9
		log.Printf("Warning: failed to register proxy for %s: %v", inst.ID, err)
	}

	writeJSON(w, http.StatusOK, inst)
}

func (h *Handler) apiInstanceStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst, err := h.store.Get(id)
	if err != nil {
		// Instance deleted — return empty 200 so frontend removes it
		w.WriteHeader(http.StatusOK)
		return
	}

	clientStatus := r.URL.Query().Get("s")
	if inst.ContainerID != "" && h.docker != nil {
		if status, err := h.docker.ContainerStatus(r.Context(), inst.ContainerID); err == nil && status != inst.Status {
			inst.Status = status
			_ = h.store.Update(inst)
		}
	}

	if inst.Status == clientStatus {
		writeNoContent(w)
		return
	}
	writeJSON(w, http.StatusOK, inst)
}

// --- System API ---

func (h *Handler) apiSystemResources(w http.ResponseWriter, r *http.Request) {
	totalMemMB := hostMemoryMB()
	writeJSON(w, http.StatusOK, map[string]int{
		"total_memory_mb": totalMemMB,
		"total_cpu_cores": runtime.NumCPU(),
	})
}

// --- Settings API ---

func (h *Handler) apiGetSettings(w http.ResponseWriter, r *http.Request) {
	// Env vars as ordered array (#21: log error, don't silently return empty)
	envMap, envErr := h.config.GetEnvVars()
	if envErr != nil {
		log.Printf("Warning: failed to get env vars: %v", envErr)
		envMap = map[string]string{}
	}
	type envVar struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	envVars := []envVar{}
	for k, v := range envMap {
		envVars = append(envVars, envVar{Key: k, Value: v})
	}

	// Config files with content
	type configFile struct {
		Name    string `json:"name"`
		RelPath string `json:"rel_path"`
		Hint    string `json:"hint"`
		Content string `json:"content"`
	}
	var configFiles []configFile
	for _, f := range h.config.EditableFiles() {
		content, _ := h.config.ReadFile(f.RelPath)
		configFiles = append(configFiles, configFile{
			Name:    f.Name,
			RelPath: f.RelPath,
			Hint:    f.Hint,
			Content: content,
		})
	}

	// Dir files
	type dirFile struct {
		Name    string `json:"name"`
		RelPath string `json:"rel_path"`
	}
	dirNames := []string{"commands", "agents", "skills", "plugins"}
	dirs := map[string][]dirFile{}
	for _, d := range dirNames {
		files, _ := h.config.ListDirFiles(d)
		arr := []dirFile{}
		for _, f := range files {
			arr = append(arr, dirFile{Name: f.Name, RelPath: f.RelPath})
		}
		dirs[d] = arr
	}

	// Agents skills
	type agentsSkill struct {
		SkillName string `json:"skill_name"`
		RelPath   string `json:"rel_path"`
	}
	rawSkills, _ := h.config.ListAgentsSkills()
	agentsSkills := []agentsSkill{}
	for _, s := range rawSkills {
		agentsSkills = append(agentsSkills, agentsSkill{SkillName: s.SkillName, RelPath: s.RelPath})
	}

	// Directory mappings
	configDir := h.config.RootDir()
	type dirMapping struct {
		Host      string `json:"host"`
		Container string `json:"container"`
	}
	mappings := []dirMapping{
		{Host: filepath.Join(configDir, "opencode") + "/", Container: "/root/.config/opencode/"},
		{Host: filepath.Join(configDir, "opencode-data", "auth.json"), Container: "/root/.local/share/opencode/auth.json"},
		{Host: filepath.Join(configDir, "dot-opencode") + "/", Container: "/root/.opencode/"},
		{Host: filepath.Join(configDir, "agents-skills") + "/", Container: "/root/.agents/"},
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"config_dir":          configDir,
		"env_vars":            envVars,
		"config_files":        configFiles,
		"dirs":                dirs,
		"agents_skills":       agentsSkills,
		"directory_mappings":  mappings,
	})
}

func (h *Handler) apiSaveEnvVars(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MB limit (#17)
	var req struct {
		Vars []struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		} `json:"vars"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	env := make(map[string]string)
	for _, v := range req.Vars {
		k := strings.TrimSpace(v.Key)
		if k == "" {
			continue
		}
		env[k] = v.Value // #14: preserve value as-is, do not trim spaces
	}

	if err := h.config.SetEnvVars(env); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save environment variables: "+err.Error())
		return
	}
	writeNoContent(w)
}

func (h *Handler) apiGetConfigFile(w http.ResponseWriter, r *http.Request) {
	relPath := r.URL.Query().Get("path")
	if relPath == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	content, err := h.config.ReadFile(relPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read file: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"rel_path": relPath,
		"content":  content,
	})
}

func (h *Handler) apiSaveConfigFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20) // 10 MB limit (#17)
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Path == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	if err := h.config.WriteFile(req.Path, req.Content); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save file: "+err.Error())
		return
	}
	writeNoContent(w)
}

func (h *Handler) apiListDirFiles(w http.ResponseWriter, r *http.Request) {
	dirName := r.URL.Query().Get("dir")
	if dirName == "" {
		writeError(w, http.StatusBadRequest, "dir is required")
		return
	}
	files, err := h.config.ListDirFiles(dirName)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list files: "+err.Error())
		return
	}
	type dirFile struct {
		Name    string `json:"name"`
		RelPath string `json:"rel_path"`
	}
	result := []dirFile{}
	for _, f := range files {
		result = append(result, dirFile{Name: f.Name, RelPath: f.RelPath})
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) apiSaveDirFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20) // 10 MB limit (#17)
	var req struct {
		Dir      string `json:"dir"`
		Filename string `json:"filename"`
		Content  string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Dir == "" || req.Filename == "" {
		writeError(w, http.StatusBadRequest, "dir and filename are required")
		return
	}
	relPath := filepath.Join(config.DirOpenCodeConfig, req.Dir, req.Filename)
	if err := h.config.WriteFile(relPath, req.Content); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save file: "+err.Error())
		return
	}
	writeNoContent(w)
}

func (h *Handler) apiDeleteDirFile(w http.ResponseWriter, r *http.Request) {
	relPath := r.URL.Query().Get("path")
	if relPath == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	if err := h.config.DeleteFile(relPath); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete file: "+err.Error())
		return
	}
	writeNoContent(w)
}

func (h *Handler) apiDeleteAgentsSkill(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if err := h.config.DeleteAgentsSkill(name); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete skill: "+err.Error())
		return
	}
	writeNoContent(w)
}

// --- WebSocket handlers (unchanged) ---

var wsUpgrader = websocket.Upgrader{
	// Allow same-host connections only. When Origin header is absent (e.g. native
	// WebSocket clients / curl) we also allow, matching the net/http default.
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		// Accept if Origin matches the Host header (scheme-insensitive).
		host := r.Host
		return strings.EqualFold(strings.TrimPrefix(strings.TrimPrefix(origin, "https://"), "http://"), host)
	},
}

func (h *Handler) handleLogsWS(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst, err := h.store.Get(id)
	if err != nil {
		http.Error(w, "Instance not found", http.StatusNotFound)
		return
	}

	if inst.ContainerID == "" || h.docker == nil {
		http.Error(w, "Container not available", http.StatusBadRequest)
		return
	}

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed for logs: %v", err)
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	reader, err := h.docker.ContainerLogsStream(ctx, inst.ContainerID, "200")
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("Failed to stream logs: "+err.Error()))
		return
	}
	defer reader.Close()

	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				cancel()
				return
			}
		}
	}()

	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			// #10: use BinaryMessage for raw log bytes (may contain ANSI codes)
			if writeErr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); writeErr != nil {
				return
			}
		}
		if err != nil {
			_ = conn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, "logs stream ended"))
			return
		}
	}
}

func (h *Handler) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	inst, err := h.store.Get(id)
	if err != nil {
		http.Error(w, "Instance not found", http.StatusNotFound)
		return
	}

	if inst.ContainerID == "" || h.docker == nil {
		http.Error(w, "Container not available", http.StatusBadRequest)
		return
	}

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	// #11: use a shared context so both goroutines can signal each other to stop
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	execID, err := h.docker.ExecCreate(ctx, inst.ContainerID, []string{"/bin/bash", "-l"})
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("Failed to create exec: "+err.Error()))
		return
	}

	hijacked, err := h.docker.ExecAttach(ctx, execID)
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("Failed to attach exec: "+err.Error()))
		return
	}
	defer hijacked.Close()

	done := make(chan struct{})

	// goroutine: container → WebSocket
	go func() {
		defer close(done)
		buf := make([]byte, 4096)
		for {
			n, err := hijacked.Reader.Read(buf)
			if n > 0 {
				if writeErr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); writeErr != nil {
					cancel() // #11: signal reader goroutine to stop
					return
				}
			}
			if err != nil {
				cancel() // #11
				return
			}
		}
	}()

	type resizeMsg struct {
		Type string `json:"type"`
		Cols uint   `json:"cols"`
		Rows uint   `json:"rows"`
	}

	// goroutine: WebSocket → container
	go func() {
		for {
			msgType, msg, err := conn.ReadMessage()
			if err != nil {
				_ = hijacked.CloseWrite()
				cancel() // #11: signal writer goroutine to stop
				return
			}
			if msgType == websocket.TextMessage && len(msg) > 0 && msg[0] == '{' {
				var rm resizeMsg
				if json.Unmarshal(msg, &rm) == nil && rm.Type == "resize" {
					_ = h.docker.ExecResize(ctx, execID, rm.Rows, rm.Cols)
					continue
				}
			}
			if _, err := hijacked.Conn.Write(msg); err != nil {
				cancel() // #11
				return
			}
		}
	}()

	<-done
}

// --- Proxy handlers (unchanged) ---

const instanceCookieName = "_cc_inst"

func (h *Handler) handleProxy(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	http.SetCookie(w, &http.Cookie{
		Name:     instanceCookieName,
		Value:    id,
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil, // #18: set Secure flag when serving over HTTPS
		SameSite: http.SameSiteLaxMode,
	})
	h.proxy.ServeHTTP(w, r, id)
}

func (h *Handler) handleCatchAll(w http.ResponseWriter, r *http.Request) {
	// If it's an API path that wasn't matched, return 404 JSON
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	// Check if this is a proxied asset request (Referer or cookie based)
	instanceID := h.resolveInstanceID(r)
	if instanceID != "" {
		h.proxy.ServeHTTPDirect(w, r, instanceID)
		return
	}

	// #23: serve frontend SPA index.html without redirects
	spaPath := filepath.Join("frontend", "dist", "index.html")
	data, err := os.ReadFile(spaPath)
	if err != nil {
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(data)
}

func (h *Handler) resolveInstanceID(r *http.Request) string {
	if id := extractInstanceIDFromReferer(r); id != "" {
		return id
	}
	if c, err := r.Cookie(instanceCookieName); err == nil && c.Value != "" {
		return c.Value
	}
	return ""
}

func extractInstanceIDFromReferer(r *http.Request) string {
	referer := r.Header.Get("Referer")
	if referer == "" {
		return ""
	}
	const prefix = "/instance/"
	idx := strings.Index(referer, prefix)
	if idx == -1 {
		return ""
	}
	rest := referer[idx+len(prefix):]
	slashIdx := strings.Index(rest, "/")
	if slashIdx == -1 {
		return ""
	}
	return rest[:slashIdx]
}
