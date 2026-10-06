/** @type {import('next').NextConfig} */

const isDev = process.env.NODE_ENV === "development";

const nextConfig = {
  // Development configuration
  ...(isDev && {
    webpack: (config, { dev }) => {
      if (dev) {
        config.devtool = 'eval-source-map';
        config.watchOptions = {
          poll: 1000,
          aggregateTimeout: 300,
        };
      }
      return config;
    },
  }),
};

export default nextConfig;
