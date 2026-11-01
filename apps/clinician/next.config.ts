import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const config: NextConfig = {
  trailingSlash: true,
  transpilePackages: ['@mawsool/ui', '@mawsool/types'],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? `http://localhost:${process.env.API_PORT ?? '4000'}`,
  },
};

export default withNextIntl(config);
