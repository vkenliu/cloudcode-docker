import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Disable Next.js's built-in trailing-slash redirect so /instance/{id}/ is
  // forwarded as-is to the Go backend (which requires the trailing slash on its
  // /instance/{id}/ route). Without this, Next.js 308-redirects to strip the
  // slash before the rewrite runs, causing a redirect loop with Go's 301.
  skipTrailingSlashRedirect: true,
  // Dev: Next.js rewrites proxy API calls and WebSocket connections to Go backend
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:8080/api/:path*",
      },
      {
        source: "/instances/:id/logs/ws",
        destination: "http://localhost:8080/instances/:id/logs/ws",
      },
      {
        source: "/instances/:id/terminal/ws",
        destination: "http://localhost:8080/instances/:id/terminal/ws",
      },
      {
        source: "/instance/:path*",
        destination: "http://localhost:8080/instance/:path*",
      },
    ];
  },
  // Required for static export: disable image optimization
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
