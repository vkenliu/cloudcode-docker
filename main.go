package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"encoding/pem"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
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
		tlsAddr     = flag.String("tls-addr", ":8443", "HTTPS listen address (self-signed cert auto-generated)")
		noTLS       = flag.Bool("no-tls", false, "Disable HTTPS listener")
		tlsCert     = flag.String("tls-cert", "", "Path to TLS certificate file (optional, auto-generated if empty)")
		tlsKey      = flag.String("tls-key", "", "Path to TLS private key file (optional, auto-generated if empty)")
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
	if len(flagOrigins) > 0 {
		log.Printf("CORS enabled for CLI origins: %s", strings.Join(flagOrigins, ", "))
	}

	rp := proxy.New()
	activeTLSAddr := ""
	if !*noTLS {
		activeTLSAddr = *tlsAddr
	}
	h := handler.New(db, dm, rp, cfgMgr, spaFiles, *accessToken, flagOrigins, *addr, activeTLSAddr)

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

	// Optional HTTPS server on a separate port (self-signed cert auto-generated).
	var tlsServer *http.Server
	if !*noTLS {
		certFile := *tlsCert
		keyFile := *tlsKey
		// Validate: both --tls-cert and --tls-key must be provided together.
		if (certFile == "") != (keyFile == "") {
			log.Fatal("--tls-cert and --tls-key must both be provided, or both omitted for auto-generation")
		}
		if certFile == "" {
			// Auto-generate a self-signed cert in the data dir.
			certFile = filepath.Join(*dataDir, "tls", "cert.pem")
			keyFile = filepath.Join(*dataDir, "tls", "key.pem")
			if err := ensureSelfSignedCert(certFile, keyFile); err != nil {
				log.Printf("Warning: failed to generate self-signed TLS cert: %v (HTTPS disabled)", err)
				certFile = ""
				keyFile = ""
			}
		}
		if certFile != "" && keyFile != "" {
			if _, err := os.Stat(certFile); err == nil {
				tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
				cert, err := tls.LoadX509KeyPair(certFile, keyFile)
				if err != nil {
					log.Printf("Warning: failed to load TLS cert: %v (HTTPS disabled)", err)
				} else {
					tlsCfg.Certificates = []tls.Certificate{cert}
					tlsServer = &http.Server{
						Addr:              *tlsAddr,
						Handler:           rootHandler,
						TLSConfig:         tlsCfg,
						ReadHeaderTimeout: 10 * time.Second,
						ReadTimeout:       30 * time.Second,
						WriteTimeout:      0,
						IdleTimeout:       120 * time.Second,
					}
				}
			}
		}
	}

	defer h.Shutdown()

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("Shutting down...")
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("HTTP shutdown error: %v", err)
		}
		if tlsServer != nil {
			if err := tlsServer.Shutdown(ctx); err != nil {
				log.Printf("HTTPS shutdown error: %v", err)
			}
		}
	}()

	// Start HTTPS listener in background if configured.
	if tlsServer != nil {
		go func() {
			log.Printf("CloudCode HTTPS listening on %s (self-signed)", *tlsAddr)
			if err := tlsServer.ListenAndServeTLS("", ""); err != http.ErrServerClosed {
				log.Printf("HTTPS server error: %v", err)
			}
		}()
	}

	log.Printf("CloudCode HTTP listening on %s", *addr)
	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}

// ensureSelfSignedCert generates a self-signed TLS certificate and key if they
// don't already exist. The cert is valid for 10 years and covers localhost,
// 127.0.0.1, and all local IPs.
func ensureSelfSignedCert(certFile, keyFile string) error {
	if _, err := os.Stat(certFile); err == nil {
		return nil // already exists
	}

	if err := os.MkdirAll(filepath.Dir(certFile), 0750); err != nil {
		return err
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return fmt.Errorf("generate serial: %w", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "CloudCode Self-Signed"},
		NotBefore:    time.Now().Add(-1 * time.Hour),
		NotAfter:     time.Now().Add(10 * 365 * 24 * time.Hour), // 10 years
		KeyUsage:     x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}

	// Add all local IPs so the cert works from LAN/public access.
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if ipNet, ok := a.(*net.IPNet); ok && !ipNet.IP.IsLoopback() {
				tmpl.IPAddresses = append(tmpl.IPAddresses, ipNet.IP)
			}
		}
	}

	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return err
	}

	certOut, err := os.Create(certFile)
	if err != nil {
		return err
	}
	defer certOut.Close()
	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: certDER}); err != nil {
		return err
	}

	keyBytes, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	keyOut, err := os.OpenFile(keyFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer keyOut.Close()
	return pem.Encode(keyOut, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes})
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

// dynamicCORSMiddleware checks the request Origin against both the static CLI
// flag origins and the config-file origins. Config origins are cached for 30s
// to avoid reading cors.json on every request.
func dynamicCORSMiddleware(flagOrigins []string, cfgMgr *config.Manager, next http.Handler) http.Handler {
	// Pre-build a set for the static CLI origins (never changes).
	flagSet := make(map[string]struct{}, len(flagOrigins))
	for _, o := range flagOrigins {
		flagSet[strings.ToLower(o)] = struct{}{}
	}

	// Cached config origins (re-read every 30s).
	var (
		cachedMu      sync.Mutex
		cachedOrigins []string
		cachedAt      time.Time
	)
	const cacheTTL = 30 * time.Second

	getConfigOrigins := func() []string {
		cachedMu.Lock()
		defer cachedMu.Unlock()
		if time.Since(cachedAt) < cacheTTL {
			return cachedOrigins
		}
		if saved, err := cfgMgr.GetCORSOrigins(); err == nil {
			cachedOrigins = saved
		}
		cachedAt = time.Now()
		return cachedOrigins
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			// Always set Vary: Origin to prevent cache poisoning.
			w.Header().Add("Vary", "Origin")

			allowed := false
			lower := strings.ToLower(origin)

			// Check static CLI origins first (fast path).
			if _, ok := flagSet[lower]; ok {
				allowed = true
			}

			// Check saved config origins (cached).
			if !allowed {
				for _, s := range getConfigOrigins() {
					if strings.EqualFold(s, origin) {
						allowed = true
						break
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
