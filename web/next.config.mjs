/** @type {import('next').NextConfig} */

const nextConfig = {
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