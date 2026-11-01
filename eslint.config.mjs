import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Hard-coded JSX text is an error: every user-facing string lives in a message file. */
const noHardCodedText = {
  'react/jsx-no-literals': ['error', { noStrings: false, allowedStrings: ['·', '/', '|', '—', '–', '•'], ignoreProps: true }],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/out/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/next-env.d.ts',
      '**/drizzle/**',
      'apps/person/public/sw.js',
      '.claude/**',
      '.local/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.{tsx,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: '19' } },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      ...noHardCodedText,
    },
  },
  {
    // Scripts and configs run in Node as plain ESM.
    files: ['scripts/**/*.mjs', '**/*.config.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    // The single source of "now" for the API is src/clock.ts; nothing else may read the wall clock.
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/clock.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Read the time from clock.ts, not Date.now().',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Read the time from clock.ts, not new Date().',
        },
      ],
    },
  },
);
