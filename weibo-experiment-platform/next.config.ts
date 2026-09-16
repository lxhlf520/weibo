import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 修复 Turbopack workspace root 被上层 lockfile(D:\PycharmProjects\package-lock.json) 错误推断的问题
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
