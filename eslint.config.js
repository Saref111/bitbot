// @ts-check
import { defineConfig } from 'eslint/config';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';

export default defineConfig([
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.js',
            'vitest.config.ts',
            'vitest.integration.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Крос-модульні імпорти — лише через index.ts (модуль = папка в src/*).
    // Файли всередині одного модуля — плоскі, без підпапок, тож relative
    // sibling-імпорти (`./gridReady.js`) не зачіпаються, а от reach-through
    // (`../grid/gridReady.js`) флагається.
    files: ['src/**/*.ts'],
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': { typescript: true },
    },
    rules: {
      'import/no-internal-modules': ['error', { allow: ['**/index.js'] }],
    },
  },
  {
    ignores: ['dist/', 'node_modules/'],
  },
]);
