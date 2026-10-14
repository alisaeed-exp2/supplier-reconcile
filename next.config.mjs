/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["exceljs", "xlsx"],
  experimental: { serverActions: { bodySizeLimit: "16mb" } },
};
export default nextConfig;
