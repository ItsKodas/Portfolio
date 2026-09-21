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
  // Every quote notification ever sent links to /admin/quotes/<id>, so these cannot simply stop working.
  // Temporary rather than permanent: a 308 is cached by the browser forever, and these paths are still
  // settling. Make them permanent once they are not.
  // Left out of the wallpaper build on purpose: `output: 'export'` is a static export, with no server to
  // answer with a redirect. Next does not fail that build, it warns and drops them, so the condition is
  // what keeps `npm run wallpaper` quiet rather than what keeps it passing.
  ...(!wallpaper && {
    async redirects() {
      return [
        { source: '/admin', destination: '/portal/quotes', permanent: false },
        { source: '/admin/quotes/:id', destination: '/portal/quotes/:id', permanent: false },
        { source: '/admin/clients/:path*', destination: '/portal/clients/:path*', permanent: false },
        { source: '/admin/ui', destination: '/portal/ui', permanent: false },
      ]
    },
  }),
};

export default nextConfig;
