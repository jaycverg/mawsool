import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { staffSecurityHeaders } from '../../packages/ui/src/csp';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? `http://localhost:${process.env.API_PORT ?? '4000'}`;

const config: NextConfig = {
  trailingSlash: true,
  transpilePackages: ['@mawsool/ui', '@mawsool/types'],
  env: { NEXT_PUBLIC_API_URL: apiUrl },
  // The page policy, with the API as the only other place a page may talk to (see staffContentSecurityPolicy).
  headers: async () => [{ source: '/:path*', headers: staffSecurityHeaders({ apiUrl, development: process.env.NODE_ENV === 'development' }) }],
};

export default withNextIntl(config);
