import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  ...(isDev && {
    webpackDevMiddleware: (config: any) => {
      config.watchOptions = {
        poll: 1000,
        aggregateTimeout: 300,
      };
      return config;
    },
  }),
};

export default nextConfig;
