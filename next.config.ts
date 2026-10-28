import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["mongodb", "mongodb-memory-server"],
  images: {
    remotePatterns: [{ protocol: "https", hostname: "picsum.photos" }],
  },
  poweredByHeader: false,
};

export default nextConfig;
