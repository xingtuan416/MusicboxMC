import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'release/**', 'out/**', 'node_modules/**', 'docs/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-fallthrough': 'error',
      'prefer-const': 'error',
    },
  },

  {
    // The renderer is still plain JS running in a browser context.
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },

  {
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  {
    // The verification scripts are CommonJS Node programs. Two of them also hand
    // functions to Playwright's `page.evaluate`, and those run in the page, so the
    // browser globals are declared here alongside Node's rather than splitting every
    // file into a Node half and a page half.
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // CommonJS is the format Electron's own tooling expects for these scripts.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    rules: {
      // Full-width spaces (U+3000) are deliberate CJK typography inside UI strings.
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipComments: true }],
    },
  },

  prettier,
);
