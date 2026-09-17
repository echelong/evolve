import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // This project deliberately does not keep AGENTS.md / CLAUDE.md in the repo.
  agentRules: false,
};

export default nextConfig;
