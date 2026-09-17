import type { NextConfig } from "next";

// `npm run wallpaper` builds with WALLPAPER_EXPORT set: a static export (no server, so no image resizing either), from a
// copy of the project so it doesn't disturb the site's own build. See scripts/wallpaper.mjs.
const wallpaper = process.env.WALLPAPER_EXPORT === "1";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  // (and tells the page it's that build, which leaves out the wallpaper page's links to the site and the Workshop)
  env: { WALLPAPER_EXPORT: wallpaper ? "1" : "0" },
  ...(wallpaper && {
    output: "export",
    images: { unoptimized: true },
  }),
};

export default nextConfig;
