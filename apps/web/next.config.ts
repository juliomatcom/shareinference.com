import path from "node:path";
import type { NextConfig } from "next";

const NO_INDEX_HEADER = "noindex, nofollow, noarchive, nosnippet, noimageindex";

const nextConfig: NextConfig = {
  output: "standalone",
  // pnpm links node_modules into the workspace root: trace from there.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  poweredByHeader: false,
  // No CSP yet: deferred post-MVP (D39; the engine needs Hugging Face and wasm allowances; wiki-llm/conventions.md).
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        // Needed for wasm threads. Set on every page because sharing survives client-side navigation from the root
        // layout. `credentialless` keeps third-party images such as GitHub avatars working.
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
      ],
    },
    // The built engine files carry the engine id in the path. engine.js, completion.js, profiles.js and shader-patch.js are ours and
    // can change without a version bump, so they are not immutable.
    {
      source: "/engine/:version/wllama/:path*",
      headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
    },
    // Signed-in pages and the proxied api are never for search results or archives (the pages also say so in their
    // meta tags and robots.txt; Caddy additionally refuses crawler User-Agents there, see ops/caddy/Caddyfile).
    ...["/api", "/dashboard", "/settings", "/playground", "/share", "/signin"].map((base) => ({
      source: `${base}/:path*`,
      headers: [{ key: "X-Robots-Tag", value: NO_INDEX_HEADER }],
    })),
  ],
  // Resolved at build time (a build arg in Docker).
  rewrites: async () => [
    { source: "/api/:path*", destination: `${process.env.API_INTERNAL_URL ?? "http://localhost:4401"}/:path*` },
  ],
  // A Playground request can wait in the api queue (300 s) and then run up to 300 s; the rewrite proxy's default
  // timeout (30 s) would cut that short.
  experimental: { proxyTimeout: 610_000 },
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
