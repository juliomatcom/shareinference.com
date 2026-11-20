import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // pnpm links node_modules into the workspace root: trace from there.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  poweredByHeader: false,
  // No CSP yet: deferred post-MVP (D39; WebLLM needs CDN, Hugging Face and wasm allowances; wiki-llm/conventions.md).
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    },
  ],
  // Resolved at build time (a build arg in Docker).
  rewrites: async () => [
    { source: "/api/:path*", destination: `${process.env.API_INTERNAL_URL ?? "http://localhost:4401"}/:path*` },
  ],
  // The api may hold a request in its queue up to 180 s before the first byte (JOB_TIMEOUT_MS); the rewrite proxy's
  // default timeout (30 s) would cut the Playground's wait short.
  experimental: { proxyTimeout: 190_000 },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
