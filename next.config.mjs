import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Read here rather than imported, so only the version string reaches the browser bundle and never drifts.
const { version } = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
// The patch table decides which dist files the loader sees. A rule that named them again would ship a moved or
// added key unpatched: the loader only counts occurrences in the files webpack routes to it.
const patched = JSON.parse(readFileSync(path.join(here, 'scripts/playsvideo-patches.json'), 'utf8'));

const nextConfig = {
  env: { NEXT_PUBLIC_VERSION: version },
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
      test: resource => Object.hasOwn(patched, resource.replaceAll('\\', '/').split('/playsvideo/dist/')[1] ?? ''),
      use: path.join(here, 'scripts/playsvideo-loader.cjs'),
    });
    return config;
  },
};

export default nextConfig;
