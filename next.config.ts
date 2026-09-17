import type { NextConfig } from "next";

// `npm run wallpaper` builds with WALLPAPER_EXPORT set: a static export (no server, so no image resizing either), from a
// copy of the project so it doesn't disturb the site's own build. See scripts/wallpaper.mjs.
const wallpaper = process.env.WALLPAPER_EXPORT === "1";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  ...(wallpaper && {
    output: "export",
    images: { unoptimized: true },
  }),
};

export default nextConfig;
