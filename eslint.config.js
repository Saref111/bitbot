// @ts-check
import { defineConfig } from 'eslint/config';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

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
    ignores: ['dist/', 'node_modules/'],
  },
]);
