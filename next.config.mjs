/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Never let a verification build replace the artifact currently served by
  // `next start`. The safe build wrapper sets this only when port 3000 is in
  // use, preventing HTML/CSS manifest mismatches in the live process.
  ...(process.env.WORKSPACE_NEXT_DIST_DIR?.trim()
    ? { distDir: process.env.WORKSPACE_NEXT_DIST_DIR.trim() }
    : {}),
};

export default nextConfig;
