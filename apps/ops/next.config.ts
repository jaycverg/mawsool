import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { staffSecurityHeaders } from '../../packages/ui/src/csp';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? `http://localhost:${process.env.API_PORT ?? '4000'}`;

const config: NextConfig = {
  trailingSlash: true,
  // A gate run builds into its own folder so it never overwrites the one `pnpm dev` is serving.
  ...(process.env.OPS_DIST_DIR ? { distDir: process.env.OPS_DIST_DIR } : {}),
  transpilePackages: ['@mawsool/ui', '@mawsool/types', '@mawsool/rules'],
  // Schemas are interpreted, not compiled with eval, which the page policy forbids (see zod-mode.ts in the types package).
  env: { NEXT_PUBLIC_API_URL: apiUrl, NEXT_PUBLIC_ZOD_JITLESS: 'true' },
  // The page policy, with the API as the only other place a page may talk to (see staffContentSecurityPolicy).
  headers: async () => [{ source: '/:path*', headers: staffSecurityHeaders({ apiUrl, development: process.env.NODE_ENV === 'development' }) }],
};

export default withNextIntl(config);
