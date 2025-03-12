/** @type {import('next').NextConfig} */

const isDev = process.env.NODE_ENV === "development";

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
  
  // Development configuration
  ...(isDev && {
    webpack: (config) => {
      config.watchOptions = {
        poll: 1000,
        aggregateTimeout: 300,
      };
      return config;
    },
  }),
};

export default nextConfig; 