import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/**
 * The person app is a static export so it can later be wrapped as a native app: no server components that
 * need a server, no server actions, no API routes. All server logic lives in apps/api.
 */
const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@mawsool/ui', '@mawsool/types'],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? `http://localhost:${process.env.API_PORT ?? '4000'}`,
  },
};

export default withNextIntl(config);
