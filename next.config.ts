import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
  // Admin pages and APIs must never be cached by the browser (Back button
  // after sign-out must hit the server guard, not a stored copy). Applies
  // to page, API and redirect responses under /admin/* and /api/admin/*.
  async headers() {
    const noStore = [
      { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, private" },
      { key: "Pragma", value: "no-cache" },
      { key: "Expires", value: "0" },
    ];
    return [
      { source: "/admin/:path*", headers: noStore },
      { source: "/api/admin/:path*", headers: noStore },
    ];
  },
};

export default nextConfig;
