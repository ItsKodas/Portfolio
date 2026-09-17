import type { NextConfig } from "next";

// `npm run wallpaper` builds with WALLPAPER_EXPORT set: a static export (no server, so no image resizing either), kept in
// a build folder of its own so it doesn't disturb the site's. See scripts/wallpaper.mjs.
const wallpaper = process.env.WALLPAPER_EXPORT === "1";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  ...(wallpaper && {
    output: "export",
    distDir: ".next-wallpaper",
    images: { unoptimized: true },
  }),
};

export default nextConfig;
