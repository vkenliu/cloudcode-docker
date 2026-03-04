import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev: Next.js rewrites proxy API calls and WebSocket connections to Go backend
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:9090/api/:path*",
      },
      {
        source: "/instances/:id/logs/ws",
        destination: "http://localhost:9090/instances/:id/logs/ws",
      },
      {
        source: "/instances/:id/terminal/ws",
        destination: "http://localhost:9090/instances/:id/terminal/ws",
      },
      {
        source: "/instance/:path*",
        destination: "http://localhost:9090/instance/:path*",
      },
    ];
  },
  // Required for static export: disable image optimization
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
