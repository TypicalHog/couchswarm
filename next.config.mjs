import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  serverExternalPackages: ['@libsql/client'],
  webpack(config) {
    config.module.rules.push({
      test: /playsvideo[\\/]dist[\\/](engine|worker|adapters[\\/]wasm-ffmpeg)\.js$/,
      use: path.join(here, 'scripts/playsvideo-loader.cjs'),
    });
    return config;
  },
};

export default nextConfig;
