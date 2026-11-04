import type { NextConfig } from "next";

// Env: apps/web/.env.local is a symlink to the repo-root .env.local (one file for the repo).
const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@bs/core", "@bs/db"],
  serverExternalPackages: ["pg", "pg-boss"],
  devIndicators: false, // the badge sat on top of the sidebar
};

export default config;
