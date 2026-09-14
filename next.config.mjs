import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  serverExternalPackages: ['@libsql/client'],
  poweredByHeader: false,
  // Framing/sniffing/permissions only: a script-src CSP would need wasm-unsafe-eval and worker-src blob: for the MKV engine.
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
  webpack(config) {
    config.module.rules.push({
      test: /playsvideo[\\/]dist[\\/](engine|worker|adapters[\\/]wasm-ffmpeg)\.js$/,
      use: path.join(here, 'scripts/playsvideo-loader.cjs'),
    });
    return config;
  },
};

export default nextConfig;
