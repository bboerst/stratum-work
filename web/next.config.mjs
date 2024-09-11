/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_SOCKET_URL: 'http://localhost:8000',
  },
  async rewrites() {
    return [
      {
        source: '/socket.io/:path*',
        destination: 'http://localhost:8000/socket.io/:path*',
      },
    ];
  },
};

export default nextConfig;
