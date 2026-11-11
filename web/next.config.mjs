/** @type {import('next').NextConfig} */

const nextConfig = {
  // Hostnames (not URLs) allowed to use dev-only resources such as hot reload when the dev
  // server is opened from another machine, e.g. "my-devbox,my-devbox.tailnet.ts.net".
  // Next.js only applies this in `next dev`.
  allowedDevOrigins: (process.env.ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),
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