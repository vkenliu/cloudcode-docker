package main

import (
	"context"
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/vkenliu/cloudcode-docker/internal/config"
	"github.com/vkenliu/cloudcode-docker/internal/docker"
	"github.com/vkenliu/cloudcode-docker/internal/handler"
	"github.com/vkenliu/cloudcode-docker/internal/proxy"
	"github.com/vkenliu/cloudcode-docker/internal/store"
)

//go:embed frontend/dist
var embeddedSPA embed.FS

func main() {
	var (
		addr        = flag.String("addr", ":8080", "HTTP listen address")
		dataDir     = flag.String("data", "./data", "Data directory for SQLite database")
		imgName     = flag.String("image", "cloudcode-base:latest", "Docker image name for opencode instances")
		noDocker    = flag.Bool("no-docker", false, "Skip Docker initialization (for UI preview)")
		corsOrigin  = flag.String("cors-origin", "", "Comma-separated CORS origins for the platform API, e.g. http://localhost:3000,http://localhost:4000")
		accessToken = flag.String("access-token", "", "Required bearer token / password for accessing the platform")
	)
	flag.Parse()

	if *accessToken == "" {
		log.Fatal("--access-token is required. Set a strong secret token to protect the platform.")
	}

	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("Starting CloudCode Management Platform...")

	db, err := store.New(*dataDir)
	if err != nil {
		log.Fatalf("Failed to initialize store: %v", err)
	}
	defer db.Close()

	cfgMgr, err := config.NewManager(*dataDir)
	if err != nil {
		log.Fatalf("Failed to initialize config manager: %v", err)
	}

	var dm *docker.Manager
	if !*noDocker {
		dm, err = docker.NewManager(*imgName, cfgMgr)
		if err != nil {
			log.Fatalf("Failed to initialize Docker manager: %v", err)
		}
		defer dm.Close()

		exists, err := dm.ImageExists(nil)
		if err != nil {
			log.Printf("Warning: Could not check for base image: %v", err)
		} else if !exists {
			log.Printf("Warning: Base image %q not found. Build it first:", *imgName)
			log.Printf("  docker build -t %s -f docker/Dockerfile docker/", *imgName)
		}
	} else {
		log.Println("Docker disabled (--no-docker), container operations will fail")
	}

	spaFiles, err := fs.Sub(embeddedSPA, "frontend/dist")
	if err != nil {
		log.Fatalf("Failed to sub embedded SPA: %v", err)
	}

	flagOrigins := parseOrigins(*corsOrigin)

	// Load saved CORS origins from config and merge with CLI flag origins.
	savedOrigins, err := cfgMgr.GetCORSOrigins()
	if err != nil {
		log.Printf("Warning: could not read saved CORS origins: %v", err)
	}
	allOrigins := mergeOrigins(flagOrigins, savedOrigins)
	if len(allOrigins) > 0 {
		log.Printf("CORS enabled for origins: %s", strings.Join(allOrigins, ", "))
	}

	rp := proxy.New()
	h := handler.New(db, dm, rp, cfgMgr, spaFiles, *accessToken, flagOrigins)

	mux := http.NewServeMux()

	// Dynamic CORS middleware — always active so saved origins take effect
	// without requiring a restart. Checks CLI flag origins (static) plus
	// config-file origins (re-read on each request).
	rootHandler := dynamicCORSMiddleware(flagOrigins, cfgMgr, mux)

	h.RegisterRoutes(mux)

	server := &http.Server{
		Addr:              *addr,
		Handler:           rootHandler,
		ReadHeaderTimeout: 10 * time.Second, // prevent Slowloris header attacks
		ReadTimeout:       30 * time.Second, // limit slow-body attacks
		// C4: WriteTimeout must be 0 for WebSocket connections — the server
		// hijacks the connection and a non-zero WriteTimeout would tear down
		// idle terminal/log streams after the deadline.  Per-write deadlines
		// are set inside each WS handler instead.
		WriteTimeout: 0,
		IdleTimeout:  120 * time.Second, // reclaim idle connections
	}

	defer h.Shutdown()

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("Shutting down...")
		// #8: graceful shutdown with timeout instead of server.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("Shutdown error: %v", err)
		}
	}()

	log.Printf("CloudCode listening on %s", *addr)
	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}

// parseOrigins splits a comma-separated origin string into a deduplicated slice.
func parseOrigins(s string) []string {
	var out []string
	seen := make(map[string]bool)
	for _, o := range strings.Split(s, ",") {
		if o = strings.TrimSpace(o); o != "" && !seen[o] {
			seen[o] = true
			out = append(out, o)
		}
	}
	return out
}

// mergeOrigins combines two origin slices, deduplicating by lowercase value.
func mergeOrigins(a, b []string) []string {
	seen := make(map[string]bool)
	var out []string
	for _, s := range a {
		lower := strings.ToLower(strings.TrimSpace(s))
		if lower != "" && !seen[lower] {
			seen[lower] = true
			out = append(out, s)
		}
	}
	for _, s := range b {
		lower := strings.ToLower(strings.TrimSpace(s))
		if lower != "" && !seen[lower] {
			seen[lower] = true
			out = append(out, s)
		}
	}
	return out
}

// dynamicCORSMiddleware checks the request Origin against both the static CLI
// flag origins and the config-file origins (re-read on each request so that
// origins saved via the Settings UI take effect without a server restart).
func dynamicCORSMiddleware(flagOrigins []string, cfgMgr *config.Manager, next http.Handler) http.Handler {
	// Pre-build a set for the static CLI origins (never changes).
	flagSet := make(map[string]struct{}, len(flagOrigins))
	for _, o := range flagOrigins {
		flagSet[strings.ToLower(o)] = struct{}{}
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			allowed := false
			lower := strings.ToLower(origin)

			// Check static CLI origins first (fast path).
			if _, ok := flagSet[lower]; ok {
				allowed = true
			}

			// Check saved config origins.
			if !allowed {
				if saved, err := cfgMgr.GetCORSOrigins(); err == nil {
					for _, s := range saved {
						if strings.EqualFold(s, origin) {
							allowed = true
							break
						}
					}
				}
			}

			if allowed {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
				w.Header().Set("Access-Control-Allow-Credentials", "true")
			}
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
