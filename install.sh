#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CloudCode One-Click Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash
#   # or
#   bash install.sh [OPTIONS]
#
# Options:
#   --token <TOKEN>         Platform access token (default: auto-generated)
#   --backend-port <PORT>   Host port for the Go backend (default: 8080)
#   --frontend-port <PORT>  Host port for the Next.js frontend (default: 3000)
#   --data-dir <PATH>       Data directory (default: /opt/cloudcode/data)
#   --install-dir <PATH>    Install directory (default: /opt/cloudcode)
#   --skip-base-image       Skip building the base image
#   --china                 Use Chinese mirrors for Docker, Go, Node, etc.
#   --help                  Show this help
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
INSTALL_DIR="/opt/cloudcode"
DATA_DIR=""  # set later if not overridden
BACKEND_PORT=8080
FRONTEND_PORT=3000
ACCESS_TOKEN=""
SKIP_BASE_IMAGE=false
CHINA_MIRROR=false
PLATFORM_IMAGE="cloudcode:latest"
FRONTEND_IMAGE="cloudcode-frontend:latest"
BASE_IMAGE="cloudcode-base:latest"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log()  { echo -e "${GREEN}[CloudCode]${NC} $*"; }
warn() { echo -e "${YELLOW}[CloudCode]${NC} $*"; }
err()  { echo -e "${RED}[CloudCode]${NC} $*" >&2; }
info() { echo -e "${BLUE}[CloudCode]${NC} $*"; }

# ── Parse arguments ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --token)          ACCESS_TOKEN="$2"; shift 2 ;;
        --backend-port)   BACKEND_PORT="$2"; shift 2 ;;
        --frontend-port)  FRONTEND_PORT="$2"; shift 2 ;;
        --port)           BACKEND_PORT="$2"; shift 2 ;;  # backward compat
        --data-dir)       DATA_DIR="$2"; shift 2 ;;
        --install-dir)    INSTALL_DIR="$2"; shift 2 ;;
        --skip-base-image) SKIP_BASE_IMAGE=true; shift ;;
        --china)          CHINA_MIRROR=true; shift ;;
        --help)
            sed -n '2,/^# ──/p' "$0" | head -n -1 | sed 's/^# \?//'
            exit 0
            ;;
        *) err "Unknown option: $1"; exit 1 ;;
    esac
done

# Default data dir under install dir
[[ -z "$DATA_DIR" ]] && DATA_DIR="${INSTALL_DIR}/data"

# Generate token if not provided
if [[ -z "$ACCESS_TOKEN" ]]; then
    ACCESS_TOKEN=$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | xxd -p | tr -d '\n')
    warn "No --token provided. Generated access token: ${ACCESS_TOKEN}"
fi

# ── Pre-flight checks ────────────────────────────────────────────────────────
log "Starting CloudCode installation..."
info "Install dir    : ${INSTALL_DIR}"
info "Data dir       : ${DATA_DIR}"
info "Backend port   : ${BACKEND_PORT}"
info "Frontend port  : ${FRONTEND_PORT}"
info "China mirror   : ${CHINA_MIRROR}"
echo ""

check_root() {
    if [[ $EUID -ne 0 ]]; then
        err "This script must be run as root (or with sudo)."
        exit 1
    fi
}

detect_os() {
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        OS_ID="${ID:-unknown}"
        OS_VERSION="${VERSION_ID:-unknown}"
    else
        OS_ID="unknown"
        OS_VERSION="unknown"
    fi
    ARCH=$(uname -m)
    log "Detected OS: ${OS_ID} ${OS_VERSION} (${ARCH})"
}

# ── Step 1: Install Docker ───────────────────────────────────────────────────
install_docker() {
    if command -v docker &>/dev/null; then
        log "Docker already installed: $(docker --version)"
        # Ensure Docker is running
        if ! docker info &>/dev/null; then
            systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
        fi
        return 0
    fi

    log "Installing Docker..."

    if [[ "$CHINA_MIRROR" == true ]]; then
        # Use Aliyun mirror for China
        case "$OS_ID" in
            ubuntu|debian)
                apt-get update -qq
                apt-get install -y -qq ca-certificates curl gnupg
                install -m 0755 -d /etc/apt/keyrings
                curl -fsSL "https://mirrors.aliyun.com/docker-ce/linux/${OS_ID}/gpg" \
                    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
                chmod a+r /etc/apt/keyrings/docker.gpg
                echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
                    https://mirrors.aliyun.com/docker-ce/linux/${OS_ID} \
                    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
                    > /etc/apt/sources.list.d/docker.list
                apt-get update -qq
                apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
                    docker-buildx-plugin docker-compose-plugin
                ;;
            centos|rhel|fedora|rocky|almalinux)
                yum install -y yum-utils
                yum-config-manager --add-repo \
                    "https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo"
                yum install -y docker-ce docker-ce-cli containerd.io \
                    docker-buildx-plugin docker-compose-plugin
                ;;
            *)
                err "Unsupported OS for China mirror Docker install: ${OS_ID}"
                err "Please install Docker manually and re-run this script."
                exit 1
                ;;
        esac
    else
        # Use official Docker install script
        curl -fsSL https://get.docker.com | sh
    fi

    systemctl enable docker 2>/dev/null || true
    systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true

    if ! docker info &>/dev/null; then
        err "Docker installation failed or Docker daemon is not running."
        exit 1
    fi

    log "Docker installed: $(docker --version)"
}

# ── Step 2: Configure Docker mirrors (China only) ────────────────────────────
configure_docker_mirrors() {
    if [[ "$CHINA_MIRROR" != true ]]; then
        return 0
    fi

    log "Configuring Docker registry mirrors for China..."

    mkdir -p /etc/docker
    # Preserve existing config if present, only add mirrors
    if [[ -f /etc/docker/daemon.json ]] && command -v jq &>/dev/null; then
        jq '. + {"registry-mirrors": ["https://docker.1ms.run", "https://docker.xuanyuan.me"]}' \
            /etc/docker/daemon.json > /tmp/daemon.json.tmp \
            && mv /tmp/daemon.json.tmp /etc/docker/daemon.json
    else
        cat > /etc/docker/daemon.json <<'MIRRORS'
{
  "registry-mirrors": [
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me"
  ]
}
MIRRORS
    fi

    systemctl daemon-reload 2>/dev/null || true
    systemctl restart docker 2>/dev/null || service docker restart 2>/dev/null || true
    log "Docker mirrors configured."
}

# ── Step 3: Create Docker network ────────────────────────────────────────────
create_network() {
    if docker network inspect cloudcode-net &>/dev/null; then
        log "Docker network 'cloudcode-net' already exists."
    else
        log "Creating Docker network 'cloudcode-net'..."
        docker network create cloudcode-net
    fi
}

# ── Step 4: Create directories ────────────────────────────────────────────────
create_directories() {
    log "Creating directories..."
    mkdir -p "${INSTALL_DIR}"
    mkdir -p "${DATA_DIR}"
}

# ── Step 5: Build or pull the base image ──────────────────────────────────────
setup_base_image() {
    if [[ "$SKIP_BASE_IMAGE" == true ]]; then
        if docker image inspect "${BASE_IMAGE}" &>/dev/null; then
            log "Skipping base image build (already exists: ${BASE_IMAGE})"
            return 0
        else
            err "No base image found and --skip-base-image was set. Remove the flag to build from source."
            exit 1
        fi
    fi

    log "Building base image (this may take 10-30 minutes)..."

    # Write Dockerfile for the base image
    mkdir -p "${INSTALL_DIR}/docker"

    # Determine Go download URL based on mirror setting
    local go_url="https://go.dev/dl"
    if [[ "$CHINA_MIRROR" == true ]]; then
        go_url="https://mirrors.aliyun.com/golang"
    fi

    cat > "${INSTALL_DIR}/docker/Dockerfile" <<DOCKERFILE
FROM ubuntu:24.04

ARG TARGETARCH

ARG TZ=UTC
ENV TZ="\$TZ"

ENV DEBIAN_FRONTEND=noninteractive
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV NODE_OPTIONS="--max-old-space-size=4096"

# ── Base system packages ──────────────────────────────────────────────────────
RUN for i in 1 2 3 4 5; do \\
    apt-get update && \\
    apt-get install -y --no-install-recommends \\
        build-essential ca-certificates curl dnsutils fd-find fzf git gnupg2 \\
        iproute2 jq less make nano openssh-client procps python3 python3-dev \\
        python3-pip python3-venv ripgrep sqlite3 tmux tree unzip vim-tiny \\
        wget zoxide zsh \\
    && break || (apt-get install -y --fix-broken 2>/dev/null; sleep 10); \\
    done \\
    && rm -rf /var/lib/apt/lists/* \\
    && ln -sf /usr/bin/python3 /usr/local/bin/python

RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd

# ── uv ────────────────────────────────────────────────────────────────────────
ENV UV_CACHE_DIR=/root/.cache/uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:\${PATH}"

# ── git-delta ─────────────────────────────────────────────────────────────────
ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=\$(dpkg --print-architecture) && \\
    for i in 1 2 3; do \\
        wget -q "https://github.com/dandavison/delta/releases/download/\${GIT_DELTA_VERSION}/git-delta_\${GIT_DELTA_VERSION}_\${ARCH}.deb" && break || sleep 10; \\
    done && \\
    dpkg -i "git-delta_\${GIT_DELTA_VERSION}_\${ARCH}.deb" && \\
    rm "git-delta_\${GIT_DELTA_VERSION}_\${ARCH}.deb"

# ── GitHub CLI ────────────────────────────────────────────────────────────────
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \\
    && echo "deb [arch=\$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
    && for i in 1 2 3; do apt-get update && apt-get install -y gh && break || sleep 10; done \\
    && rm -rf /var/lib/apt/lists/*

# ── Cloudflare Tunnel ─────────────────────────────────────────────────────────
RUN curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \\
    | tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null \\
    && echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \\
    | tee /etc/apt/sources.list.d/cloudflared.list > /dev/null \\
    && for i in 1 2 3; do apt-get update && apt-get install -y cloudflared && break || sleep 10; done \\
    && rm -rf /var/lib/apt/lists/*

# ── Go ────────────────────────────────────────────────────────────────────────
ENV GO_VERSION=1.24.2
RUN for i in 1 2 3; do \\
        curl -fsSL "${go_url}/go\${GO_VERSION}.linux-\${TARGETARCH}.tar.gz" \\
        | tar -C /usr/local -xzf - && break || sleep 10; \\
    done
ENV PATH="/usr/local/go/bin:/root/go/bin:\${PATH}"

# ── Node.js LTS (v22) ────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \\
    && for i in 1 2 3; do apt-get install -y nodejs && break || sleep 10; done \\
    && rm -rf /var/lib/apt/lists/*

# ── Bun ───────────────────────────────────────────────────────────────────────
RUN for i in 1 2 3; do curl -fsSL https://bun.sh/install | bash && break || sleep 10; done
ENV PATH="/root/.bun/bin:\${PATH}"

# ── OpenCode ──────────────────────────────────────────────────────────────────
RUN for i in 1 2 3; do bun install -g opencode-ai@latest && break || sleep 10; done

# ── adit-core ─────────────────────────────────────────────────────────────────
RUN for i in 1 2 3; do \\
        curl -fsSL https://raw.githubusercontent.com/vkenliu/adit-core/main/install.sh | bash && break || sleep 10; \\
    done

# ── Playwright Chromium ───────────────────────────────────────────────────────
RUN for i in 1 2 3; do npx playwright install chromium && break || sleep 10; done
RUN for i in 1 2 3 4 5; do npx playwright install-deps chromium && break || sleep 15; done
RUN CHROME_BIN=\$(find /root/.cache/ms-playwright/chromium-* -name chrome -type f | head -1) \\
    && ln -sf "\$CHROME_BIN" /usr/bin/chromium-browser \\
    && ln -sf "\$CHROME_BIN" /usr/bin/chrome

# ── Directory structure ───────────────────────────────────────────────────────
RUN mkdir -p \\
    /workspace \\
    /root/.opencode \\
    /root/.config/opencode \\
    /root/.local/share/opencode \\
    /root/.agents/skills \\
    /root/.adit-core

# ── Entrypoint ────────────────────────────────────────────────────────────────
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace
EXPOSE 4096
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
DOCKERFILE

    # Write entrypoint.sh
    cat > "${INSTALL_DIR}/docker/entrypoint.sh" <<'ENTRYPOINT'
#!/bin/bash
set -euo pipefail

echo "=== CloudCode Instance Starting ==="

echo "[1/4] Updating OpenCode..."
bun update -g opencode-ai@latest 2>/dev/null || echo "Warning: OpenCode update failed, using existing version"
echo "  OpenCode version: $(opencode --version 2>/dev/null || echo 'unknown')"

echo "[2/4] Updating adit-core..."
curl -fsSL https://raw.githubusercontent.com/vkenliu/adit-core/main/install.sh | bash || echo "Warning: adit-core update failed, using existing version"

echo "[3/4] Updating skills.sh skills..."
bunx skills update -g -y 2>/dev/null || echo "Warning: skills update failed or no skills installed"
if [ -n "${GH_TOKEN:-}" ]; then
    echo "[*] GitHub CLI authenticated via GH_TOKEN"
fi

if [ -f /root/.config/opencode/opencode.json ]; then
    echo "[*] Global opencode config detected"
fi
if [ -f /root/.local/share/opencode/auth.json ]; then
    echo "[*] Global auth config detected"
fi

PORT="${OPENCODE_PORT:-4096}"

if [ -f /root/.config/cloudcode/startup.sh ]; then
    echo "[*] Running startup script..."
    bash /root/.config/cloudcode/startup.sh
    echo "[*] Startup script complete"
fi

echo "[4/4] Starting OpenCode Web UI on port ${PORT}..."
echo "=== Ready ==="

# Run shutdown script (if present) on SIGTERM before forwarding the signal.
# The platform also runs the script via docker exec before sending stop, so
# this trap is defense-in-depth for external `docker stop` calls.
_shutdown() {
    echo "[*] Received SIGTERM"
    if [ -f /root/.config/cloudcode/shutdown.sh ]; then
        echo "[*] Running shutdown script..."
        bash /root/.config/cloudcode/shutdown.sh || echo "[!] Shutdown script failed"
        echo "[*] Shutdown script complete"
    fi
    # Forward SIGTERM to opencode
    kill -TERM "$CHILD_PID" 2>/dev/null
    wait "$CHILD_PID" 2>/dev/null
    exit $?
}
trap _shutdown SIGTERM

opencode web --port "${PORT}" --hostname 0.0.0.0 &
CHILD_PID=$!
wait "$CHILD_PID"
ENTRYPOINT

    chmod +x "${INSTALL_DIR}/docker/entrypoint.sh"

    # Build the base image
    docker build -t cloudcode-base:latest -f "${INSTALL_DIR}/docker/Dockerfile" "${INSTALL_DIR}/docker/"
}

# ── Step 6: Build the platform image ──────────────────────────────────────────
setup_platform_image() {
    if docker image inspect "${PLATFORM_IMAGE}" &>/dev/null; then
        log "Platform image already exists: ${PLATFORM_IMAGE}"
        return 0
    fi

    log "Building platform image from source..."

    if [[ ! -f "${INSTALL_DIR}/Dockerfile.platform" ]]; then
        err "Dockerfile.platform not found in ${INSTALL_DIR}."
        err "Please place the project source code in ${INSTALL_DIR}."
        exit 1
    fi

    docker build -t cloudcode:latest -f "${INSTALL_DIR}/Dockerfile.platform" "${INSTALL_DIR}/"
    log "Platform image built: cloudcode:latest"
}

# ── Step 7: Build the frontend image ─────────────────────────────────────────
setup_frontend_image() {
    if docker image inspect "${FRONTEND_IMAGE}" &>/dev/null; then
        log "Frontend image already exists: ${FRONTEND_IMAGE}"
        return 0
    fi

    log "Building frontend image..."

    if [[ ! -f "${INSTALL_DIR}/frontend/Dockerfile" ]]; then
        err "frontend/Dockerfile not found in ${INSTALL_DIR}."
        err "Please place the project source code in ${INSTALL_DIR}."
        exit 1
    fi

    docker build -t cloudcode-frontend:latest \
        -f "${INSTALL_DIR}/frontend/Dockerfile" \
        "${INSTALL_DIR}/frontend/"
    log "Frontend image built: cloudcode-frontend:latest"
}

# ── Step 7b: Build CORS origins ───────────────────────────────────────────────
build_cors_origins() {
    local origins="http://localhost:${FRONTEND_PORT}"

    # Add all non-loopback local IPs (private/public)
    local ips
    ips=$(hostname -I 2>/dev/null || true)
    for ip in $ips; do
        [[ "$ip" == 127.* ]] && continue
        origins="${origins},http://${ip}:${FRONTEND_PORT}"
    done

    # Detect public IP (cloud VMs often NAT the public IP, so it's not on any interface)
    local public_ip
    public_ip=$(curl -sf --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null \
             || curl -sf --max-time 3 https://ifconfig.me 2>/dev/null \
             || curl -sf --max-time 3 https://api.ipify.org 2>/dev/null \
             || true)
    if [[ -n "$public_ip" && "$origins" != *"${public_ip}"* ]]; then
        origins="${origins},http://${public_ip}:${FRONTEND_PORT}"
    fi

    CORS_ORIGINS="$origins"
    info "CORS origins: ${CORS_ORIGINS}"
}

# ── Step 8: Write docker-compose.yml ──────────────────────────────────────────
write_compose() {
    log "Writing docker-compose.yml..."

    cat > "${INSTALL_DIR}/docker-compose.yml" <<COMPOSE
services:
  cloudcode:
    image: ${PLATFORM_IMAGE}
    container_name: cloudcode
    ports:
      - "${BACKEND_PORT}:8080"
    environment:
      - HOST_DATA_DIR=${DATA_DIR}
    volumes:
      - ${DATA_DIR}:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - cloudcode-net
    restart: unless-stopped
    command:
      - -access-token
      - "${ACCESS_TOKEN}"
      - -cors-origin
      - "${CORS_ORIGINS}"
      - -image
      - "${BASE_IMAGE}"

  frontend:
    image: ${FRONTEND_IMAGE}
    container_name: cloudcode-frontend
    ports:
      - "${FRONTEND_PORT}:3000"
    networks:
      - cloudcode-net
    restart: unless-stopped
    depends_on:
      - cloudcode

networks:
  cloudcode-net:
    external: true
    name: cloudcode-net
COMPOSE
}

# ── Step 9: Start the service ─────────────────────────────────────────────────
start_service() {
    log "Starting CloudCode..."
    cd "${INSTALL_DIR}"

    # Stop existing instance if running
    docker compose down 2>/dev/null || true

    docker compose up -d

    log "CloudCode is starting..."
    sleep 3

    if docker compose ps | grep -q "running"; then
        log "CloudCode is running!"
    else
        warn "Container may still be starting. Check with: docker compose logs -f"
    fi
}

# ── Step 10: Print summary ───────────────────────────────────────────────────
print_summary() {
    local host_ip
    host_ip=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_SERVER_IP")

    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║            CloudCode Installation Complete!                 ║${NC}"
    echo -e "${GREEN}╠══════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${GREEN}║${NC}                                                              "
    echo -e "${GREEN}║${NC}  Frontend:      http://${host_ip}:${FRONTEND_PORT}            "
    echo -e "${GREEN}║${NC}  Backend API:   http://${host_ip}:${BACKEND_PORT}             "
    echo -e "${GREEN}║${NC}  Access Token:  ${ACCESS_TOKEN}                               "
    echo -e "${GREEN}║${NC}                                                              "
    echo -e "${GREEN}║${NC}  Install Dir:   ${INSTALL_DIR}                                "
    echo -e "${GREEN}║${NC}  Data Dir:      ${DATA_DIR}                                   "
    echo -e "${GREEN}║${NC}                                                              "
    echo -e "${GREEN}║${NC}  Manage:                                                     "
    echo -e "${GREEN}║${NC}    cd ${INSTALL_DIR}                                          "
    echo -e "${GREEN}║${NC}    docker compose logs -f      # view logs                   "
    echo -e "${GREEN}║${NC}    docker compose restart       # restart                    "
    echo -e "${GREEN}║${NC}    docker compose down          # stop                       "
    echo -e "${GREEN}║${NC}                                                              "
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
    check_root
    detect_os

    install_docker
    configure_docker_mirrors
    create_network
    create_directories
    setup_base_image
    setup_platform_image
    setup_frontend_image
    build_cors_origins
    write_compose
    start_service
    print_summary
}

main
