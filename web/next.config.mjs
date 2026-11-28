/** @type {import('next').NextConfig} */

const nextConfig = {
  // Hostnames (not URLs) allowed to use dev-only resources such as hot reload when the dev
  // server is opened from another machine, e.g. "my-devbox,my-devbox.example.internal".
  // Next.js only applies this in `next dev`.
  allowedDevOrigins: (process.env.ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),
  // Prerendered pages revalidate every 60 s (app/layout.tsx). A shared cache may serve a page past that while it
  // fetches a new one, for up to expireTime - revalidate = 300 s (stale-while-revalidate=300), instead of a year.
  expireTime: 360,
  experimental: {
    // Keep regenerated pages in memory only: the build output stays as built, and an app run with a read-only
    // filesystem doesn't try to write into .next.
    isrFlushToDisk: false,
  },
  // The Other chains page became Unknown parents (episodes per unknown parent), which became Forks (every parent other
  // than our best block). Redirects keep the query string (?range=…&parent=…).
  async redirects() {
    return [
      { source: '/other-chains', destination: '/forks', permanent: true },
      { source: '/unknown-parents', destination: '/forks', permanent: true },
    ];
  },
  // Rewrites configuration from next.config.mjs
  async rewrites() {
    return [
      {
        // Rewrite /table to / so that direct access to /table
        // will show the same content as the root URL
        source: '/table',
        destination: '/',
      },
    ];
  },
};

export default nextConfig; 