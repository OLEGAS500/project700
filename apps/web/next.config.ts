import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@eim/core", "@eim/db", "@eim/worker"]
};

export default nextConfig;
