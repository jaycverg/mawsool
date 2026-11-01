import type { ReactNode } from 'react';

/** The document shell lives in `[locale]/layout.tsx`, where the language and direction are known. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
